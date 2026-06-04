const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT         = process.env.PORT || 3005;
const OUT          = path.join(__dirname, 'output');
const SERVER_START = new Date().toISOString();
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || '';

// ── Supabase 영구 저장소 ─────────────────────────────────────────────────
// 환경변수 SUPABASE_URL, SUPABASE_KEY 가 없으면 로컬 파일로 폴백 (개발용)
const SB_URL      = process.env.SUPABASE_URL;        // https://xxxx.supabase.co
const SB_KEY      = process.env.SUPABASE_ANON_KEY;  // anon/public 키 (Settings→API에서 바로 보임)
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY; // Claude API 키

// 파일명 → Supabase key 매핑
const FILE_TO_KEY = {
  'investigation-state.json': 'investigation-state',
  'finance-state.json':       'finance-state',
  'finance-plan-state.json':  'finance-plan-state',
  'card-replan-state.json':   'card-replan-state',
  'tx-data-state.json':       'tx-data-state',
  'activity-log.json':        'activity-log',
  'card-roster-state.json':   'card-roster-state',
  'finance-work-tags.json':   'finance-work-tags',
  'finance-revenue-state.json': 'finance-revenue-state',
};

// 인메모리 캐시 — 서버 시작 시 로드, 이후 동기 읽기 가능
const _cache = {};

// 고빈도 패치용 Supabase 지연 쓰기 (마지막 패치 후 10초 뒤 1회만 씀)
const _sbDeferTimers = {};
function deferredSbWrite(file) {
  clearTimeout(_sbDeferTimers[file]);
  _sbDeferTimers[file] = setTimeout(async () => {
    const key = FILE_TO_KEY[file];
    if (SB_URL && SB_KEY && key) {
      await sbWrite(key, _cache[file]).catch(e => console.error('[deferred sbWrite]', e.message));
    } else {
      localWrite(file, _cache[file]);
    }
  }, 10000);
}

async function sbRead(key) {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(key)}&select=value`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    const rows = await res.json();
    return (Array.isArray(rows) && rows.length > 0) ? rows[0].value : null;
  } catch { return null; }
}

// 재시도 포함 읽기 — 최대 3회, 1초 간격
async function sbReadWithRetry(key) {
  for (let i = 0; i < 3; i++) {
    const data = await sbRead(key);
    if (data !== null) return data;
    if (i < 2) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

async function sbWrite(key, data) {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/kv_store`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key, value: data }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[Supabase write error] ${res.status} for key "${key}":`, body);
      return false;
    }
    return true;
  } catch (e) { console.error('[Supabase write error]', e.message); return false; }
}

// ── merchants 테이블 (개별 행 저장 — IO 최소화) ──────────────────────────

// DB 행 배열을 500개씩 나눠 upsert
async function sbUpsertMerchants(rows) {
  if (!SB_URL || !SB_KEY || rows.length === 0) return false;
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const res = await fetch(`${SB_URL}/rest/v1/merchants`, {
        method: 'POST',
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[merchants upsert error] ${res.status}:`, body.slice(0, 200));
        return false;
      }
    }
    return true;
  } catch (e) { console.error('[merchants upsert error]', e.message); return false; }
}

// merchants 테이블 전체 읽기 (1000행씩 페이지네이션)
async function sbReadAllMerchants() {
  if (!SB_URL || !SB_KEY) return null;
  try {
    let allRows = [], offset = 0;
    const limit = 1000;
    while (true) {
      const res = await fetch(
        `${SB_URL}/rest/v1/merchants?select=*&limit=${limit}&offset=${offset}`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      allRows = allRows.concat(rows);
      if (rows.length < limit) break;
      offset += limit;
    }
    if (allRows.length === 0) return null;
    const merchants = {};
    allRows.forEach(r => {
      merchants[r.key] = {
        name: r.name || r.key,
        cat: r.cat || '',
        biz: r.biz || '',
        proj: r.proj || '',
        autoTagged: r.auto_tagged || false,
        count: r.count || 0,
        totalOut: r.total_out || 0,
        totalIn: r.total_in || 0,
        sampleDate: r.sample_date || '',
      };
    });
    return merchants;
  } catch (e) { console.error('[sbReadAllMerchants error]', e.message); return null; }
}

// merchants 객체 → DB 행 배열 변환
function merchantsToRows(merchantsObj) {
  return Object.entries(merchantsObj).map(([key, m]) => ({
    key,
    name: m.name || key,
    cat: m.cat || '',
    biz: m.biz || '',
    proj: m.proj || '',
    auto_tagged: !!m.autoTagged,
    count: m.count || 0,
    total_out: m.totalOut || 0,
    total_in: m.totalIn || 0,
    sample_date: m.sampleDate || '',
  }));
}

// Supabase 연결 테스트 (테이블 접근 가능 여부)
async function sbPing() {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/kv_store?limit=1`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
    });
    return { ok: res.ok, status: res.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Claude AI 태깅 ───────────────────────────────────────────────────────
const AI_CATEGORIES = [
  '인건비','4대보험','3.3소득세','제세공과금','통신비','IT인프라비',
  '임대료','차량유지비','지급수수료','식비/경비','복리후생비',
  '마케팅/광고비','특허','변호사비','인증비','사무용품/사무집기',
  '금융비용(이자)','일괄송금(사유확인불가)','거래처','기타',
];

async function callClaudeTagging(merchants) {
  const lines = merchants.map(m =>
    `"${m.name}" (출금 ${(m.totalOut || 0).toLocaleString('ko-KR')}원, ${m.count}건)`
  ).join('\n');

  const prompt = `당신은 한국 법인 회계 분류 전문가입니다.
아래 거래처/거래내역 이름을 카테고리와 사업자로 분류하세요.

카테고리 목록: ${AI_CATEGORIES.join(', ')}
사업자 목록: 한솔, 한큐, 수복지, 교육원 (모르면 빈 문자열 "")

hanQ 그룹 사업자 정보:
- 한솔: IT 개발/디자인/영업 (아고라 프로젝트)
- 한큐: IT 개발/영업/재무/의료기
- 수복지: 복지 관련 사업
- 교육원: 교육 관련 사업

분류 기준:
1. 거래처 이름에서 업종을 적극 추론하세요
   - "(주)", "㈜", "주식회사" 등 법인명이 붙은 경우 상호에서 업종 파악 시도
   - 예: "㈜한국전력" → 제세공과금, "㈜삼성SDS" → IT인프라비, "㈜현대건설" → 거래처
   - 업종이 명확하면 해당 카테고리로, 불명확하면 "거래처"
2. 금액·건수도 참고하세요 (소액 다건 = 소모품/식비 가능성)
3. 사업자는 거래 성격상 특정 사업자에만 해당하는 경우만 지정, 불분명하면 ""
4. "기타"는 최후 수단 — 법인명이 있으면 반드시 "거래처" 우선
5. 절대 설명 없이 JSON만 응답

분류할 거래처 목록:
${lines}

응답 형식 (JSON만, 코드 블록 없이):
{"거래처명": {"cat": "카테고리", "biz": "사업자"}, ...}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 응답에 JSON 없음');
  return JSON.parse(m[0]);
}

// 로컬 파일 폴백 (Supabase 미설정 or 개발 환경)
function localRead(file) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, file), 'utf8')); }
  catch { return {}; }
}
function localWrite(file, data) {
  try { fs.writeFileSync(path.join(OUT, file), JSON.stringify(data), 'utf8'); }
  catch (e) { console.error('[local write error]', e.message); }
}

// 동기 읽기 — 항상 캐시에서 반환
function readJSON(file) { return _cache[file] ?? {}; }

// 쓰기 — 캐시 + 영구저장소에 동시 반영 (await 가능), Supabase 저장 성공 여부 반환
async function writeJSON(file, data) {
  _cache[file] = data;
  const key = FILE_TO_KEY[file];
  if (SB_URL && SB_KEY && key) {
    return await sbWrite(key, data);
  } else {
    localWrite(file, data);
    return false;
  }
}

// 서버 시작 시 전체 state 로드
async function loadAllState() {
  for (const [file, key] of Object.entries(FILE_TO_KEY)) {
    let data = null;
    if (SB_URL && SB_KEY) {
      data = await sbReadWithRetry(key);
    }
    if (data !== null) {
      _cache[file] = data;
      console.log(`[state] loaded ${file} from Supabase (${Object.keys(data).length} keys)`);
    } else {
      data = localRead(file);
      _cache[file] = data;
      if (SB_URL && SB_KEY && Object.keys(data).length > 0) {
        console.log(`[state] seeding ${key} to Supabase from local…`);
        await sbWrite(key, data);
      }
      console.log(`[state] loaded ${file} from local (${Object.keys(data).length} keys)`);
    }
  }

  // merchants 테이블에서 태그 데이터 로드 (kv_store 대체)
  if (SB_URL && SB_KEY) {
    const tableData = await sbReadAllMerchants();
    if (tableData && Object.keys(tableData).length > 0) {
      if (!_cache['finance-work-tags.json']) _cache['finance-work-tags.json'] = {};
      _cache['finance-work-tags.json'].merchants = tableData;
      console.log(`[state] loaded merchants table (${Object.keys(tableData).length} rows)`);
      // 기동 시 merchants 최신 상태를 kv_store에 즉시 반영 (Render 재배포 후 fallback 일관성 보장)
      sbWrite('finance-work-tags', _cache['finance-work-tags.json']).catch(e => console.error('[startup kv-sync]', e.message));
    } else {
      // 테이블 비어있음 → kv_store에서 자동 마이그레이션
      const kvMerchants = _cache['finance-work-tags.json']?.merchants;
      if (kvMerchants && Object.keys(kvMerchants).length > 0) {
        console.log(`[migrate] merchants 테이블로 이관 중 (${Object.keys(kvMerchants).length}개)...`);
        await sbUpsertMerchants(merchantsToRows(kvMerchants));
        console.log(`[migrate] 완료`);
      }
    }
  }
}

// ── 도메인 데이터 ────────────────────────────────────────────────────────
const SUMMARY_DEPOSITS = [
  {accountNo:'301-0237-9325-41',balance:null},
  {accountNo:'301-0240-3659-61',balance:255800},
  {accountNo:'302-0410-2086-51',balance:18910255},
  {accountNo:'302-0945-7796-21',balance:26},
  {accountNo:'302-0958-9854-31',balance:162},
  {accountNo:'302-1018-0299-01',balance:34158},
  {accountNo:'302-1102-7562-71',balance:62},
  {accountNo:'302-1727-0656-01',balance:288900},
  {accountNo:'312-0051-7301-21',balance:414557},
  {accountNo:'352-1078-0700-13',balance:null},
  {accountNo:'352-1619-4468-83',balance:3091},
  {accountNo:'352-1990-4632-53',balance:-229762167},
  {accountNo:'789401-01-862390',balance:1319063},
  {accountNo:'789402-01-148178',balance:6147575},
  {accountNo:'780302-00-032068',balance:57},
  {accountNo:'110-489-553043',balance:null},
  {accountNo:'110-547-773536',balance:29658549},
  {accountNo:'110-621-424679',balance:16802},
  {accountNo:'110-506802904',balance:null},
  {accountNo:'110-465-289239',balance:null},
  {accountNo:'110-513-398282',balance:null},
  {accountNo:'1107-021-926465',balance:null},
  {accountNo:'069-121-660047',balance:1403},
  {accountNo:'1121-031-712452',balance:180573},
];
const SUMMARY_LOANS = [
  {bank:'기업튼튼보증서대출(기운분할)', balance:91652000,  maturity:'2029.11.2'},
  {bank:'농협 마이너스대출',           balance:230000000, maturity:'2026.5.20'},
];
const CARD_PAYMENTS = [
  {label:'국민 · 삼성 · 현대 · 롯데 카드 결제', payDay:25},
  {label:'신한 카드 결제',                       payDay:10},
  {label:'농협 · 광주 카드 결제',                payDay:6},
];

const ROUTES = {
  '/accounts':     '재무계좌현황.html',
  '/plan':         '자금계획관리.html',
  '/inspect':      '법인카드_실사결과보고.html',
  '/spend':        '법인카드_일회성지출관리.html',
  '/report':       '법인카드_분석리포트.html',
  '/quick':        '빠른입력.html',
  '/roster':       '관리명부.html',
  '/finance-new':  '재무관리(신).html',
  '/finance-work': '재무관리(신)_작업.html',
  '/kpi':          'kpi.html',
  '/biz':          'biz-view.html',
};

function serveHTML(res, file) {
  fs.readFile(path.join(OUT, file), 'utf8', (err, data) => {
    if (err) { res.writeHead(404); res.end('파일 없음'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// ── HTTP 서버 ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // HTML 라우트
  if (ROUTES[url] && req.method === 'GET') {
    serveHTML(res, ROUTES[url]); return;
  }

  // 루트 → accounts 리다이렉트
  if (url === '/' && req.method === 'GET') {
    res.writeHead(302, { Location: '/accounts' }); res.end(); return;
  }

  // 상태 API (GET)
  const getStateRoutes = {
    '/api/state':              'investigation-state.json',
    '/api/finance-state':      'finance-state.json',
    '/api/finance-plan-state': 'finance-plan-state.json',
    '/api/card-replan-state':  'card-replan-state.json',
    '/api/tx-data-state':      'tx-data-state.json',
    '/api/activity-log':       'activity-log.json',
    '/api/card-roster-state':  'card-roster-state.json',
    '/api/finance-work-tags':  'finance-work-tags.json',
    '/api/finance-revenue-state': 'finance-revenue-state.json',
  };
  if (getStateRoutes[url] && req.method === 'GET') {
    const file   = getStateRoutes[url];
    const cached = readJSON(file);
    // 캐시가 비어있으면 Supabase에서 직접 재조회 (서버 재시작 시 로드 실패 복구)
    if (SB_URL && SB_KEY && Object.keys(cached).length === 0) {
      const key = FILE_TO_KEY[file];
      (key ? sbRead(key) : Promise.resolve(null))
        .then(fresh => {
          if (fresh !== null) _cache[file] = fresh;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fresh !== null ? fresh : cached));
        })
        .catch(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(cached));
        });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cached));
    return;
  }

  // 상태 API (POST)
  const postRoutes = {
    '/api/state':              'investigation-state.json',
    '/api/finance-state':      'finance-state.json',
    '/api/finance-plan-state': 'finance-plan-state.json',
    '/api/card-replan-state':  'card-replan-state.json',
    '/api/tx-data-state':      'tx-data-state.json',
    '/api/activity-log':       'activity-log.json',
    '/api/card-roster-state':  'card-roster-state.json',
    '/api/finance-work-tags':  'finance-work-tags.json',
    '/api/finance-revenue-state': 'finance-revenue-state.json',
  };
  if (postRoutes[url] && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const sbOk = await writeJSON(postRoutes[url], data);
        // finance-work-tags POST 시 tagged merchants를 테이블에도 저장
        if (postRoutes[url] === 'finance-work-tags.json' && data.merchants) {
          sbUpsertMerchants(merchantsToRows(data.merchants)).catch(e =>
            console.error('[post upsert]', e.message)
          );
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, supabase: !!(SB_URL && SB_KEY && sbOk) }));
      } catch { res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }

  // 재무 요약 API
  if (url === '/api/finance-summary' && req.method === 'GET') {
    const qs      = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
    const horizon = Math.min(Math.max(parseInt(qs.get('days') || '90', 10), 1), 730);
    const st      = readJSON('finance-state.json');
    const balances = (st && st.balances) ? st.balances : {};

    let totalDeposit = 0;
    SUMMARY_DEPOSITS.forEach(d => {
      let bal = d.balance;
      if (balances[d.accountNo] !== undefined) bal = balances[d.accountNo].value;
      if (bal !== null && bal > 0) totalDeposit += bal;
    });

    const now = new Date(); now.setHours(0, 0, 0, 0);
    let totalLoan = 0, urgentCount = 0;
    const alerts = [];

    SUMMARY_LOANS.forEach(loan => {
      totalLoan += (loan.balance || 0);
      const p   = loan.maturity.split('.');
      const mat = new Date(+p[0], +p[1] - 1, +p[2]);
      const days = Math.ceil((mat - now) / 86400000);
      if (days >= 0 && days <= horizon) {
        urgentCount++;
        alerts.push({ text: loan.bank + ' 만기', daysLeft: days, urgency: days <= 14 ? 'urg' : 'wrn' });
      }
    });

    CARD_PAYMENTS.forEach(cp => {
      const d = new Date(now); d.setDate(cp.payDay);
      if (d <= now) d.setMonth(d.getMonth() + 1);
      const days = Math.ceil((d - now) / 86400000);
      alerts.push({ text: cp.label, daysLeft: days, urgency: days <= 5 ? 'urg' : days <= 14 ? 'wrn' : 'info' });
    });

    alerts.sort((a, b) => a.daysLeft - b.daysLeft);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ totalDeposit, totalLoan, netFunds: totalDeposit - totalLoan, urgentCount, alerts }));
    return;
  }

  // 진단 API — Supabase 연결 상태 + 캐시 현황
  if (url === '/api/debug' && req.method === 'GET') {
    const info = {
      supabaseConfigured: !!(SB_URL && SB_KEY),
      supabaseProject: SB_URL ? SB_URL.split('//')[1]?.split('.')[0] : null,
      cache: {},
    };
    Object.entries(FILE_TO_KEY).forEach(([file, key]) => {
      const d = _cache[file];
      info.cache[key] = d ? Object.keys(d).length : 0;
    });
    if (SB_URL && SB_KEY) {
      sbPing().then(ping => {
        info.supabasePing = ping;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info, null, 2));
      });
    } else {
      info.supabasePing = { ok: false, reason: 'not configured' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info, null, 2));
    }
    return;
  }

  // 서버 버전/시작 시간
  if (url === '/api/version' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ startedAt: SERVER_START }));
    return;
  }

  // 태그 패치 — 캐시 즉시 업데이트 + merchants 테이블 개별 행 upsert (논블로킹)
  if (url === '/api/finance-work-tags/patch' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const current = readJSON('finance-work-tags.json');
        if (!current.merchants) current.merchants = {};
        let changedMap = {};
        if (parsed.merchants && typeof parsed.merchants === 'object') {
          changedMap = parsed.merchants;
        } else if (parsed.key && parsed.fields) {
          changedMap = { [parsed.key]: parsed.fields };
        } else {
          res.writeHead(400); res.end('key+fields 또는 merchants 필요'); return;
        }
        for (const [k, fields] of Object.entries(changedMap)) {
          if (!current.merchants[k]) current.merchants[k] = { name: k };
          Object.assign(current.merchants[k], fields);
        }
        _cache['finance-work-tags.json'] = current;
        // 즉시 kv_store 업데이트 (10초 deferred는 Render 배포 시 유실 위험)
        if (SB_URL && SB_KEY) sbWrite('finance-work-tags', current).catch(e => console.error('[patch kv-write]', e.message));
        // Supabase 쓰기 완료 후 응답 (5초 타임아웃 안전장치)
        await Promise.race([
          sbUpsertMerchants(merchantsToRows(changedMap)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('sb-timeout')), 5000))
        ]).catch(e => console.error('[patch upsert]', e.message));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }

  // BS 파라미터 (ROE/ROA/ROIC 분모값) 저장/조회
  if (url === '/api/bs-params') {
    if (req.method === 'GET') {
      (SB_URL && SB_KEY ? sbRead('bs-params') : Promise.resolve(_cache['bs-params'] || null))
        .then(function(data) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, params: data || _cache['bs-params'] || {} }));
        })
        .catch(function() {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, params: _cache['bs-params'] || {} }));
        });
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          _cache['bs-params'] = params;
          if (SB_URL && SB_KEY) sbWrite('bs-params', params).catch(e => console.error('[bs-params]', e.message));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
      });
      return;
    }
  }

  // KPI 예측 & 인사이트 API
  if (url === '/api/kpi-predict' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'ANTHROPIC_API_KEY 미설정' }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { scope, history, totalRev, totalCost, profit, costByCat, bizBreakdown } = JSON.parse(body);

        // 다음 3개월 계산
        const lastMonth = (history[history.length - 1] || {}).month || new Date().toISOString().substring(0, 7);
        const [ly, lm] = lastMonth.split('-').map(Number);
        const next3 = [1, 2, 3].map(i => {
          const m = ((lm - 1 + i) % 12) + 1;
          const y = ly + Math.floor((lm - 1 + i) / 12);
          return `${y}-${String(m).padStart(2, '0')}`;
        });

        const topCosts = Object.entries(costByCat || {})
          .sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([c, v]) => `  - ${c}: ${v.toLocaleString()}원`).join('\n');

        const bizLines = bizBreakdown
          ? Object.entries(bizBreakdown)
              .map(([b, v]) => `  - ${b}: 매출 ${v.rev.toLocaleString()}, 비용 ${v.cost.toLocaleString()}, 순이익 ${v.profit.toLocaleString()}`)
              .join('\n')
          : '';

        const historyLines = history.map(h =>
          `  ${h.month}: 매출 ${h.revenue.toLocaleString()}원, 비용 ${h.costs.toLocaleString()}원, 순이익 ${h.profit.toLocaleString()}원`
        ).join('\n');

        const prompt = `당신은 hanQ 그룹의 수석 재무 분석가입니다. 현금주의 회계 기준의 실제 거래 데이터를 분석합니다.

## 분석 대상: "${scope}"

### 누적 요약
- 총 매출: ${totalRev.toLocaleString()}원
- 총 비용: ${totalCost.toLocaleString()}원
- 순이익: ${profit.toLocaleString()}원
- 이익률: ${totalRev > 0 ? (profit / totalRev * 100).toFixed(1) : 0}%

### 월별 추이 (최근 ${history.length}개월)
${historyLines}

${topCosts ? `### 주요 비용 카테고리 (상위 5개)\n${topCosts}` : ''}

${bizLines ? `### 사업자별 현황\n${bizLines}` : ''}

## 요청

**1. 다음 3개월(${next3.join(', ')}) 예측**
- 최근 트렌드와 계절성을 반영한 매출/비용/순이익 예측
- 숫자는 정수 (원 단위)

**2. 핵심 인사이트 4~6개**
- 리스크(risk): 주의해야 할 재무적 위험 요소
- 기회(opportunity): 개선 또는 성장 가능성
- 트렌드(trend): 현재 진행 중인 의미 있는 추세
- 각 인사이트는 데이터에 근거한 구체적 수치 포함

**응답 형식 (JSON만, 마크다운 코드블록 없이):**
{
  "forecast": [
    {"month": "YYYY-MM", "revenue": 숫자, "costs": 숫자, "profit": 숫자},
    {"month": "YYYY-MM", "revenue": 숫자, "costs": 숫자, "profit": 숫자},
    {"month": "YYYY-MM", "revenue": 숫자, "costs": 숫자, "profit": 숫자}
  ],
  "insights": [
    {"type": "risk", "title": "제목 (15자 이내)", "body": "구체적 설명 (2~3문장, 수치 포함)"},
    {"type": "opportunity", "title": "제목", "body": "설명"},
    {"type": "trend", "title": "제목", "body": "설명"}
  ]
}`;

        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        if (!aiRes.ok) {
          const errText = await aiRes.text().catch(() => '');
          throw new Error(`Anthropic ${aiRes.status}: ${errText.slice(0, 200)}`);
        }

        const aiData = await aiRes.json();
        const text = aiData.content?.[0]?.text || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('AI 응답에 JSON 없음: ' + text.slice(0, 100));
        const parsed = JSON.parse(match[0]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, forecast: parsed.forecast || [], insights: parsed.insights || [] }));
      } catch(e) {
        console.error('[kpi-predict error]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // AI 자동 태깅 API
  if (url === '/api/ai-tag' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'ANTHROPIC_API_KEY 미설정' }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { merchants } = JSON.parse(body);
        if (!Array.isArray(merchants) || merchants.length === 0) {
          res.writeHead(400); res.end('merchants 배열 필요'); return;
        }
        const BATCH = 80;
        const results = {};
        for (let i = 0; i < merchants.length; i += BATCH) {
          const tagged = await callClaudeTagging(merchants.slice(i, i + BATCH));
          Object.assign(results, tagged);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (e) {
        console.error('[AI tag error]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // FM AI 챗봇 API
  if (url === '/api/fm-chat' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!ANTHROPIC_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'ANTHROPIC_API_KEY 미설정' }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { question } = JSON.parse(body);
        if (!question || typeof question !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'question 필요' })); return;
        }
        const prompt = buildFmContextServer(question);
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (!aiRes.ok) {
          const errText = await aiRes.text().catch(() => '');
          throw new Error(`Anthropic ${aiRes.status}: ${errText.slice(0, 200)}`);
        }
        const aiData = await aiRes.json();
        const answer = aiData.content?.[0]?.text || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, answer: answer.trim() }));
      } catch (e) {
        console.error('[fm-chat error]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── Slack 테스트 수동 트리거 ────────────────────────────────────────────────
  if (url === '/api/slack-test' && req.method === 'POST') {
    if (!SLACK_WEBHOOK) { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'SLACK_WEBHOOK_URL 미설정' })); return; }
    runDailySlackAlert().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }

  res.writeHead(404); res.end('Not found');
});


// ── Slack 알림 ──────────────────────────────────────────────────────────────
async function sendSlack(text, attachments) {
  if (!SLACK_WEBHOOK) return;
  try {
    await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachments }),
    });
  } catch (e) { console.error('[Slack]', e.message); }
}

function fmtNum(n) { return Math.round(n).toLocaleString('ko-KR'); }

async function runDailySlackAlert() {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const lines = [];

  // 1) 대출 만기
  SUMMARY_LOANS.forEach(loan => {
    const p   = loan.maturity.split('.');
    const mat = new Date(+p[0], +p[1] - 1, +p[2]);
    const days = Math.ceil((mat - now) / 86400000);
    if (days >= 0 && days <= 30) {
      const icon = days <= 7 ? '🚨' : '⚠️';
      lines.push(`${icon} *${loan.bank}* 만기 *D-${days}* (잔액 ${fmtNum(loan.balance)}원)`);
    }
  });

  // 2) 카드 결제일
  CARD_PAYMENTS.forEach(cp => {
    const d = new Date(now); d.setDate(cp.payDay);
    if (d <= now) d.setMonth(d.getMonth() + 1);
    const days = Math.ceil((d - now) / 86400000);
    if (days <= 3) {
      const icon = days <= 1 ? '🚨' : '⚠️';
      lines.push(`${icon} *${cp.label}* 결제일 *D-${days}*`);
    }
  });

  // 3) 이상지출 — 이번 달 지출이 최근 3개월 평균의 1.5배 초과
  const txState = _cache['tx-data-state.json'] || {};
  const txns = Array.isArray(txState.txns) ? txState.txns : [];
  if (txns.length > 0) {
    const monthly = {};
    txns.forEach(t => {
      if (!t.date || !t.out || t.out <= 0) return;
      const ym = t.date.slice(0, 7);
      monthly[ym] = (monthly[ym] || 0) + t.out;
    });
    const keys = Object.keys(monthly).sort();
    const curYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const curAmt = monthly[curYm] || 0;
    const prev3 = keys.filter(k => k < curYm).slice(-3);
    if (prev3.length >= 2 && curAmt > 0) {
      const avg = prev3.reduce((s, k) => s + monthly[k], 0) / prev3.length;
      if (curAmt > avg * 1.5) {
        lines.push(`📈 *이상지출 감지* — 이번달 ${fmtNum(curAmt)}원 (최근 3개월 평균 ${fmtNum(avg)}원의 ${Math.round(curAmt / avg * 100)}%)`);
      }
    }
  }

  if (!lines.length) {
    // 알림 없을 때도 매일 정상 확인 로그
    console.log('[Slack] 일일 체크 완료 — 긴급 알림 없음');
    return;
  }

  // 계좌 현황 요약
  const st = _cache['finance-state.json'] || {};
  const balances = (st && st.balances) ? st.balances : {};
  let totalDeposit = 0;
  SUMMARY_DEPOSITS.forEach(d => {
    let bal = d.balance;
    if (balances[d.accountNo] !== undefined) bal = balances[d.accountNo].value;
    if (bal !== null && bal > 0) totalDeposit += bal;
  });

  const header = `*📊 hanQ FM 재무 알림* | 총 예금 ${fmtNum(totalDeposit)}원\n${now.getFullYear()}년 ${now.getMonth()+1}월 ${now.getDate()}일`;
  await sendSlack(header + '\n\n' + lines.join('\n'));
  console.log(`[Slack] 알림 발송 — ${lines.length}건`);
}

// ── 시작: state 로드 후 서버 오픈 ───────────────────────────────────────
loadAllState().then(() => {
  server.listen(PORT, () => {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  hanQ Cards & Finance Portal');
    console.log(`  http://localhost:${PORT}`);
    console.log(`  저장소: ${SB_URL ? 'Supabase (' + SB_URL.split('//')[1]?.split('.')[0] + ')' : '로컬 파일'}`);
    console.log(`  Slack: ${SLACK_WEBHOOK ? '연결됨' : '미설정 (SLACK_WEBHOOK_URL 환경변수 필요)'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  });

  // 매일 09:00 KST 알림 (1분마다 체크)
  let _lastAlertDate = '';
  setInterval(() => {
    const utcNow  = new Date();
    const kstHour = (utcNow.getUTCHours() + 9) % 24;
    const kstDate = new Date(utcNow.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    if (kstHour === 9 && kstDate !== _lastAlertDate) {
      _lastAlertDate = kstDate;
      runDailySlackAlert();
    }
  }, 60000);
});

function buildFmContextServer(question) {
  const L = [];
  L.push('당신은 hanQ 그룹의 재무 AI 어시스턴트입니다. 아래 재무 데이터를 기반으로 질문에 한국어로 답변하세요.');
  L.push('수치 근거를 포함하고, 마크다운 없이 평문으로 작성하세요.\n');

  // ── 1. 계좌 현황 ─────────────────────────────────────────────────────────
  const finState = _cache['finance-state.json'] || {};
  const balances = finState.balances || {};
  let totalDeposit = 0;
  const depLines = [];
  SUMMARY_DEPOSITS.forEach(d => {
    let bal = d.balance;
    if (balances[d.accountNo] !== undefined) bal = balances[d.accountNo].value;
    if (bal !== null && bal !== undefined) {
      if (bal > 0) totalDeposit += bal;
      if (bal !== 0) depLines.push(`  ${d.accountNo}: ${fmtN(bal)}원`);
    }
  });
  let totalLoan = 0;
  const loanLines = [];
  SUMMARY_LOANS.forEach(loan => {
    totalLoan += (loan.balance || 0);
    loanLines.push(`  ${loan.bank}: ${fmtN(loan.balance)}원 (만기 ${loan.maturity})`);
  });
  L.push('=== 계좌 현황 ===');
  L.push(`총 예금: ${fmtN(totalDeposit)}원 / 총 대출: ${fmtN(totalLoan)}원 / 순자금: ${fmtN(totalDeposit - totalLoan)}원`);
  if (depLines.length) L.push('예금 계좌:\n' + depLines.join('\n'));
  if (loanLines.length) L.push('대출:\n' + loanLines.join('\n'));

  // ── 2. 카드 결제일 ───────────────────────────────────────────────────────
  L.push('\n=== 법인카드 결제일 ===');
  CARD_PAYMENTS.forEach(cp => L.push(`  ${cp.label}: 매월 ${cp.payDay}일`));

  // ── 3. 거래 내역 분석 ────────────────────────────────────────────────────
  const txState    = _cache['tx-data-state.json'] || {};
  const txns       = Array.isArray(txState.txns) ? txState.txns : [];
  const tagState   = _cache['finance-work-tags.json'] || {};
  const merchants  = tagState.merchants || {};

  if (txns.length > 0) {
    const monthly = {}, catTotals = {}, bizTotals = {}, mMap = {};

    txns.forEach(t => {
      if (!t.date || !t.out || t.out <= 0) return;
      const ym  = t.date.slice(0, 7);
      const mer = t.merchant || t.name || '';
      const m   = merchants[mer] || {};
      const cat = m.cat || '미분류';
      const biz = m.biz || t.biz || '';

      monthly[ym]  = (monthly[ym]  || 0) + t.out;
      catTotals[cat] = (catTotals[cat] || 0) + t.out;
      if (biz) bizTotals[biz] = (bizTotals[biz] || 0) + t.out;

      if (!mMap[mer]) mMap[mer] = {};
      mMap[mer][ym] = (mMap[mer][ym] || 0) + t.out;
    });

    const sortedYms = Object.keys(monthly).sort();
    const last6 = sortedYms.slice(-6);
    const latestYm = last6[last6.length - 1] || '';
    const prevYm   = last6[last6.length - 2] || '';

    L.push('\n=== 월별 총 비용 (최근 6개월) ===');
    last6.forEach(ym => L.push(`  ${ym}: ${fmtN(monthly[ym])}원`));

    const catTop = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 10);
    L.push('\n=== 카테고리별 누적 비용 ===');
    catTop.forEach(([cat, amt]) => L.push(`  ${cat}: ${fmtN(amt)}원`));

    if (Object.keys(bizTotals).length > 0) {
      L.push('\n=== 사업자별 비용 ===');
      Object.entries(bizTotals).sort((a, b) => b[1] - a[1])
        .forEach(([biz, amt]) => L.push(`  ${biz}: ${fmtN(amt)}원`));
    }

    // 반복/신규/소멸
    const recurring = [], newThis = [], dropped = [];
    Object.keys(mMap).forEach(name => {
      const byYm = mMap[name];
      let consecutive = 0;
      for (let i = last6.length - 1; i >= 0; i--) {
        if (byYm[last6[i]]) consecutive++; else break;
      }
      const ymKeys = Object.keys(byYm);
      const avgAmt = Math.round(ymKeys.reduce((s, y) => s + byYm[y], 0) / ymKeys.length);
      if (consecutive >= 2) recurring.push({ name, months: consecutive, avgAmt });
      if (latestYm && byYm[latestYm] && prevYm && !byYm[prevYm] && byYm[latestYm] > 10000)
        newThis.push({ name, amt: byYm[latestYm] });
      if (prevYm && byYm[prevYm] && latestYm && !byYm[latestYm] && byYm[prevYm] > 10000)
        dropped.push({ name, amt: byYm[prevYm] });
    });

    if (recurring.length) {
      recurring.sort((a, b) => b.avgAmt - a.avgAmt);
      L.push('\n=== 반복 결제 (2개월 이상 연속) ===');
      recurring.slice(0, 30).forEach(r => {
        const cat = (merchants[r.name] || {}).cat || '미분류';
        L.push(`  ${r.name} [${cat}]: 월 ${fmtN(r.avgAmt)}원 (${r.months}개월 연속)`);
      });
    }
    if (newThis.length) {
      newThis.sort((a, b) => b.amt - a.amt);
      L.push('\n=== 이번 달 신규 지출 ===');
      newThis.slice(0, 15).forEach(n => L.push(`  ${n.name}: ${fmtN(n.amt)}원`));
    }
    if (dropped.length) {
      dropped.sort((a, b) => b.amt - a.amt);
      L.push('\n=== 전월 대비 소멸 지출 ===');
      dropped.slice(0, 15).forEach(d => L.push(`  ${d.name}: ${fmtN(d.amt)}원`));
    }
  }

  // ── 4. 상위 거래처 ───────────────────────────────────────────────────────
  const topMer = Object.entries(merchants)
    .filter(([, m]) => (m.totalOut || 0) > 0)
    .sort((a, b) => b[1].totalOut - a[1].totalOut)
    .slice(0, 40);
  if (topMer.length) {
    L.push('\n=== 상위 거래처 (출금 기준) ===');
    topMer.forEach(([k, m]) => L.push(`  ${k} [${m.cat || '미분류'}]: ${fmtN(m.totalOut)}원`));
  }

  // ── 5. 자금 계획 ─────────────────────────────────────────────────────────
  const planState = _cache['finance-plan-state.json'] || {};
  const plans = planState.plans || planState.monthly || {};
  const planKeys = Object.keys(plans).sort().slice(-4);
  if (planKeys.length) {
    L.push('\n=== 자금 계획 (최근) ===');
    planKeys.forEach(ym => {
      const p = plans[ym];
      if (p) L.push(`  ${ym}: 계획 ${fmtN(p.planned || p.plan || 0)}원, 실제 ${fmtN(p.actual || 0)}원`);
    });
  }

  L.push(`\n=== 질문 ===\n${question}`);
  return L.join('\n');
}

function fmtN(n) {
  if (n === null || n === undefined) return '-';
  return Number(n).toLocaleString('ko-KR');
}
