import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runCheckerOnce } from './platform-checker.mjs';
if (process.argv.includes('--test-panel')) {
  process.env.DISABLE_BACKGROUND_JOBS = '1'; process.env.SERVE_FRONTEND = '0';
  const { default: db, setSetting } = await import('../backend/src/lib/db.js');
  const { buildApp } = await import('../backend/src/app.js');
  const token = (await readFile(process.env.CHECKER_FIXTURE_TOKEN, 'utf8')).trim();
  setSetting('sre.platform.monitor_token_hash', createHash('sha256').update(token).digest('hex'));
  const sample = () => { const at = Date.now(); db.prepare('INSERT OR REPLACE INTO sre_platform_samples(sampled_at,data_json) VALUES(?,?)').run(at, JSON.stringify({ at, databaseBytes: 1, walBytes: 0, diskFreePercent: 90 })); };
  sample(); const timer = setInterval(sample, 1000), app = await buildApp({ logger: false });
  await app.listen({ host: '127.0.0.1', port: Number(process.env.CHECKER_FIXTURE_PORT || 0) });
  process.send({ port: app.server.address().port });
  process.once('SIGTERM', async () => { clearInterval(timer); await app.close(); db.close(); process.exit(0); });
} else {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'checker-acceptance-')), output = path.resolve(process.env.SRE_EVIDENCE_DIR || '/tmp/composeops-checker-evidence'); await mkdir(output, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(dir, 'credential'), stateFile = path.join(dir, 'state.json'); await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const messages = [], webhook = http.createServer(async (request, response) => { let body = ''; for await (const chunk of request) body += chunk; messages.push(JSON.parse(body)); response.writeHead(200); response.end('{}'); });
  webhook.listen(0, '127.0.0.1'); await once(webhook, 'listening'); let child, port;
  const start = async () => {
    child = fork(fileURLToPath(import.meta.url), ['--test-panel'], { env: { ...process.env, DB_PATH: path.join(dir, 'panel.db'), CHECKER_FIXTURE_TOKEN: tokenFile, CHECKER_FIXTURE_PORT: String(port || 0) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('测试面板启动失败'); })]); port = message.port;
  };
  const stop = async () => { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; child = null; };
  let passed = false;
  try {
    await start(); const config = { url: `http://127.0.0.1:${port}/healthz/platform/`, tokenFile, stateFile, location: 'same-host', timeoutMs: 1000, webhookUrl: `http://127.0.0.1:${webhook.address().port}/events` };
    const series = []; let state;
    const check = async () => { state = await runCheckerOnce(config); series.push({ at: state.observedAt, status: state.status, ok: state.observation.ok }); await new Promise(resolve => setTimeout(resolve, 10)); };
    await check(); await check(); await check(); assert.equal(state.status, 'healthy');
    await stop(); await check(); await check(); await check(); assert.equal(state.status, 'firing'); assert.equal(messages.length, 1);
    await start(); await check(); await check(); await check(); assert.equal(state.status, 'healthy'); assert.deepEqual(messages.map(row => row.transition), ['firing', 'resolved']);
    await check(); assert.equal(messages.length, 2);
    const limited = await fetch(`http://127.0.0.1:${port}/api/v1/sre/profiles`, { headers: { Authorization: 'Bearer ' + (await readFile(tokenFile, 'utf8')) } }); assert.equal(limited.status, 401);
    await writeFile(path.join(output, 'independent-checker.json'), JSON.stringify({ passed: true, series, notifications: messages, operationalApiDenied: true, limitation: '此验收与部署为独立进程，同宿主不能检测整机断电。' }, null, 2), { mode: 0o600 });
    passed = true; console.log(JSON.stringify({ stoppedPanelDetected: true, restartedPanelRecovered: true, persistedNotifications: messages.length, operationalApiDenied: true }));
  } finally { if (child) await stop(); webhook.close(); await once(webhook, 'close'); if (passed) await rm(dir, { recursive: true, force: true }); }
}
