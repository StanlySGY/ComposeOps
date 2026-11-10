const http = require('node:http');
http.createServer(async (_req, res) => {
  let good = process.env.FIXTURE_FAIL !== '1';
  if (process.env.UPSTREAM) { try { good = good && (await fetch(process.env.UPSTREAM, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { good = false; } }
  res.writeHead(good ? 200 : 503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ revision: process.env.FIXTURE_REVISION, good }));
}).listen(8080, '0.0.0.0');
