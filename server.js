const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = process.env.PORT || 3005;
const OUT    = path.join(__dirname, 'output');

// ── Supabase 영구 저장소 ─────────────────────────────────────────────────
// 환경변수 SUPABASE_URL, SUPABASE_KEY 가 없으면 로컬 파일로 폴백 (개발용)
const SB_URL = process.env.SUPABASE_URL;   // https://xxxx.supabase.co
const SB_KEY = process.env.SUPABASE_KEY;   // service_role 키

// 파일명 → Supabase key 매핑
const FILE_TO_KEY = {
  'investigation-state.json': 'investigation-state',
  'finance-state.json':       'finance-state',
  'finance-plan-state.json':  'finance-plan-state',
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

async function sbWrite(key, data) {
  try {
    await fetch(`${SB_URL}/rest/v1/kv_store`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key, value: data }),
    });
  } catch (e) { console.error('[Supabase write error]', e.message); }
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

// 쓰기 — 캐시 + 영구저장소에 동시 반영
function writeJSON(file, data) {
  _cache[file] = data;
  const key = FILE_TO_KEY[file];
  if (SB_URL && SB_KEY && key) {
    sbWrite(key, data); // 비동기, 응답 기다리지 않음
  } else {
    localWrite(file, data);
  }
}

// 서버 시작 시 전체 state 로드
async function loadAllState() {
  for (const [file, key] of Object.entries(FILE_TO_KEY)) {
    let data = null;
    if (SB_URL && SB_KEY) {
      data = await sbRead(key);
    }
    if (data === null) {
      // Supabase 미설정이거나 아직 데이터 없음 → 로컬 파일에서 읽어서 Supabase에 seed
      data = localRead(file);
      if (SB_URL && SB_KEY && Object.keys(data).length > 0) {
        console.log(`[state] seeding ${key} to Supabase…`);
        await sbWrite(key, data);
      }
    }
    _cache[file] = data;
    console.log(`[state] loaded ${file} (${Object.keys(data).length} keys)`);
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
  '/accounts': '재무계좌현황.html',
  '/plan':     '자금계획관리.html',
  '/inspect':  '법인카드_실사결과보고.html',
  '/spend':    '법인카드_일회성지출관리.html',
  '/report':   '법인카드_분석리포트.html',
  '/quick':    '빠른입력.html',
};

function serveHTML(res, file) {
  fs.readFile(path.join(OUT, file), 'utf8', (err, data) => {
    if (err) { res.writeHead(404); res.end('파일 없음'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
    '/api/state':             'investigation-state.json',
    '/api/finance-state':     'finance-state.json',
    '/api/finance-plan-state':'finance-plan-state.json',
  };
  if (getStateRoutes[url] && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readJSON(getStateRoutes[url])));
    return;
  }

  // 상태 API (POST)
  const postRoutes = {
    '/api/state':             'investigation-state.json',
    '/api/finance-state':     'finance-state.json',
    '/api/finance-plan-state':'finance-plan-state.json',
  };
  if (postRoutes[url] && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        writeJSON(postRoutes[url], data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
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
