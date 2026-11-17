// Synthetic fixture only. No production data/configuration is used.
const http = require('node:http');
const crypto = require('node:crypto');
const connection = process.env.DATABASE_URL;
const engine = connection.startsWith('postgres') ? 'postgres' : 'mysql';
async function rows() {
  if (engine === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ connectionString: connection, connectionTimeoutMillis: 1000, query_timeout: 2000 });
    try { await client.connect(); return (await client.query('SELECT id, name FROM items ORDER BY id')).rows; }
    finally { await client.end().catch(() => {}); }
  }
  const mysql = require('mysql2/promise'), client = await mysql.createConnection(connection);
  try { return (await client.query('SELECT id, name FROM items ORDER BY id'))[0]; }
  finally { await client.end(); }
}
http.createServer(async (_req, res) => {
  const traceId = crypto.randomBytes(16).toString('hex'), spanId = crypto.randomBytes(8).toString('hex'), childId = crypto.randomBytes(8).toString('hex');
  const at = Date.now(); let status = 200, message = 'ok', result;
  try { result = await rows(); } catch (error) { status = 503; message = error.code || 'database unavailable'; result = { error: 'dependency unavailable' }; }
  const nano = value => (BigInt(value) * 1000000n).toString();
  const event = { fixture: true, at, traceId, signal: 'dependency-request', status, message,
    traces: { resourceSpans: ['app', 'db'].map((service, i) => ({ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeSpans: [{ spans: [{ traceId, spanId: i ? childId : spanId, ...(i ? { parentSpanId: spanId } : {}), name: i ? 'database SELECT items' : 'GET /items', startTimeUnixNano: nano(at), endTimeUnixNano: nano(Date.now()), status: { code: status === 200 ? 1 : 2, message } }] }] })) },
    logs: { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'app' } }] }, scopeLogs: [{ logRecords: [{ traceId, spanId, timeUnixNano: nano(Date.now()), severityNumber: status === 200 ? 9 : 17, body: { stringValue: message } }] }] }] } };
  console.log(JSON.stringify(event)); res.writeHead(status, { 'Content-Type': 'application/json', 'X-Fixture-Trace': traceId }); res.end(JSON.stringify(result));
}).listen(8080, '0.0.0.0');
