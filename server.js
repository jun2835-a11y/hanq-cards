const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = process.env.PORT || 3005;
const OUT    = path.join(__dirname, 'output');

const ROUTES = {
  '/accounts': '재무계좌현황.html',
  '/plan':     '자금계획관리.html',
  '/inspect':  '법인카드_실사결과보고.html',
  '/spend':    '법인카드_일회성지출관리.html',
  '/report':   '법인카드_분석리포트.html',
};

function serveHTML(res, file) {
  fs.readFile(path.join(OUT, file), 'utf8', (err, data) => {
    if (err) { res.writeHead(404); res.end('파일 없음'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, file), 'utf8')); }
  catch { return {}; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(path.join(OUT, file), JSON.stringify(data), 'utf8'); return true; }
  catch { return false; }
}

http.createServer((req, res) => {
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
  if (url === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readJSON('investigation-state.json')));
    return;
  }
  if (url === '/api/finance-state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readJSON('finance-state.json')));
    return;
  }
  if (url === '/api/finance-plan-state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readJSON('finance-plan-state.json')));
    return;
  }

  // 상태 API (POST)
  const postRoutes = {
    '/api/state': 'investigation-state.json',
    '/api/finance-state': 'finance-state.json',
    '/api/finance-plan-state': 'finance-plan-state.json',
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

  res.writeHead(404); res.end('Not found');

}).listen(PORT, () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  hanQ Cards & Finance Portal');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  /accounts  재무계좌현황`);
  console.log(`  /plan      자금계획관리`);
  console.log(`  /inspect   카드 실사결과보고`);
  console.log(`  /spend     일회성지출관리`);
  console.log(`  /report    분석리포트`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
});
