const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = process.env.PORT || 3005;
const OUT    = path.join(__dirname, 'output');

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
};

// 인메모리 캐시 — 서버 시작 시 로드, 이후 동기 읽기 가능
const _cache = {};

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
      // Supabase 미설정이거나 키 없음 → 로컬 파일로 폴백
      data = localRead(file);
      _cache[file] = data;
      if (SB_URL && SB_KEY && Object.keys(data).length > 0) {
        // 로컬에 데이터 있으면 Supabase에 seed
        console.log(`[state] seeding ${key} to Supabase from local…`);
        await sbWrite(key, data);
      }
      console.log(`[state] loaded ${file} from local (${Object.keys(data).length} keys)`);
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
  };
  if (postRoutes[url] && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const sbOk = await writeJSON(postRoutes[url], data);
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

  res.writeHead(404); res.end('Not found');
});

// ── 시작: state 로드 후 서버 오픈 ───────────────────────────────────────
loadAllState().then(() => {
  server.listen(PORT, () => {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  hanQ Cards & Finance Portal');
    console.log(`  http://localhost:${PORT}`);
    console.log(`  저장소: ${SB_URL ? 'Supabase (' + SB_URL.split('//')[1]?.split('.')[0] + ')' : '로컬 파일'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
  });
});
