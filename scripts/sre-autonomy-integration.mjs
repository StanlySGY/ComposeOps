import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
const exec = promisify(execFile);
const directory = mkdtempSync(path.join(os.tmpdir(), 'composeops-autonomy-drill-'));
const evidence = path.resolve(process.env.SRE_EVIDENCE_DIR || directory);
mkdirSync(evidence, { recursive: true });
const projectName = 'co-autonomy-' + Date.now(), containerName = projectName + '-web';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
process.env.DB_PATH = path.join(directory, 'drill.db'); process.env.SERVE_FRONTEND = '1';
process.env.DISABLE_BACKGROUND_JOBS = '1'; process.env.ENABLE_SHELL = '0';
let app, stopObserver, stopWorker;
const password = randomUUID();
async function until(check, timeout = 300000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error('Isolated automatic recovery did not reach the expected state');
}
async function browser(steps, name, viewport = '1440x1050') {
  const file = path.join(directory, name + '.json'); writeFileSync(file, JSON.stringify(steps), { mode: 0o600 });
  const { stdout } = await exec(process.env.CODEX_BROWSER || 'codex-browser', ['run', file, '--binary', process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', '--no-stealth', '--viewport', viewport, '--timeout', '30000'], { maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(path.join(evidence, name + '.jsonl'), stdout);
}
try {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const httpPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  docker('run', '-d', '--name', containerName, '--label', 'com.docker.compose.project=' + projectName,
    '--label', 'com.docker.compose.service=web', '--publish', '127.0.0.1:' + httpPort + ':8080', '--memory', '32m', '--cpus', '0.25',
    'busybox:1.36', 'sh', '-c', 'mkdir -p /www; n=$(cat /tmp/starts 2>/dev/null || echo 0); n=$((n+1)); echo "$n" >/tmp/starts; if [ "$n" -gt 1 ]; then echo ready >/www/health; fi; exec httpd -f -p 8080 -h /www');
  const inspect = await until(() => { const item = JSON.parse(docker('inspect', containerName))[0]; return item.State.Running && item.NetworkSettings.Ports['8080/tcp'] && item; }, 15000);
  const endpoint = 'http://127.0.0.1:' + inspect.NetworkSettings.Ports['8080/tcp'][0].HostPort + '/health';
  await until(async () => { try { return (await fetch(endpoint)).status === 404; } catch { return false; } }, 15000);
  const { buildApp } = await import('../backend/src/app.js');
  const { scanProjects } = await import('../backend/src/services/scanner.js');
  const { setProjectPreference } = await import('../backend/src/lib/db.js');
  const { setPassword } = await import('../backend/src/lib/auth.js');
  const { listSreProfiles } = await import('../backend/src/services/sre-profiles.js');
  const { getAutonomyPolicy } = await import('../backend/src/services/sre-autonomy.js');
  const { startIncidentObserver, stopIncidentObserver } = await import('../backend/src/services/incident-observer.js');
  const { startOpsEffectWorker, stopOpsEffectWorker } = await import('../backend/src/services/ops-effect-worker.js');
  const { listIncidents, getIncidentDetail } = await import('../backend/src/services/incident-store.js');
  const project = (await scanProjects('local')).find(item => item.projectName === projectName);
  assert(project); setProjectPreference(project.id, { managed: true }); setPassword(password);
  app = await buildApp({ logger: false }); await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const login = (route = '/reliability') => [
    { action: 'open', url: base + '/#' + route, wait_for: 'input[type=password]' },
    { action: 'fill', selector: 'input[type=password]', value: password },
    { action: 'click', selector: 'button:has-text("安全登录")' },
    { action: 'wait', wait_for: '.page-title' },
    { action: 'click', selector: 'button:has-text("开始使用")' },
    { action: 'eval', js: "async () => { const end = Date.now() + 5000; while (document.querySelector('[role=dialog]') && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50)); }" },
    { action: 'assert', js: "() => !document.querySelector('[role=dialog]')" },
  ];
  await browser([...login(),
    { action: 'click', selector: 'button:has-text("添加应用目标")' },
    { action: 'wait', wait_for: '[role=dialog] select:has(option[value="local:' + project.id + '"])' },
    { action: 'eval', js: `() => { const select = document.querySelector('[role=dialog] select'); select.value = ${JSON.stringify('local:' + project.id)}; select.dispatchEvent(new Event('change', { bubbles: true })); }` },
    { action: 'fill', selector: 'input[type=url]', value: endpoint },
    { action: 'fill', selector: 'label:has-text("连续失败触发次数") input', value: '2' },
    { action: 'click', selector: 'button:has-text("保存目标")' },
    { action: 'wait', wait_for: 'button:has-text("审阅自动授权")' },
    { action: 'click', selector: 'button:has-text("审阅自动授权")' },
    { action: 'click', selector: 'button:has-text("核对并继续")' },
    { action: 'wait', wait_for: '[role=dialog][aria-label="启用有界自动重启"]' },
    { action: 'assert', text: projectName + ' / web' },
    { action: 'screenshot', out: path.join(evidence, 'autonomy-approval.png'), full_page: true },
    { action: 'click', selector: 'button:has-text("确认授权")' },
    { action: 'wait', wait: 500 },
    { action: 'assert', text: '预授权生效' },
  ], 'autonomy-approval');
  const profile = listSreProfiles()[0]; assert(profile); assert.equal(getAutonomyPolicy(profile.id).enabled, true);
  assert.equal(docker('exec', containerName, 'cat', '/tmp/starts'), '1');
  startOpsEffectWorker({ pollMs: 1000 }); stopWorker = stopOpsEffectWorker;
  startIncidentObserver({ scan: async () => [{ ...project, managed: true }] }); stopObserver = stopIncidentObserver;
  const incident = await until(() => listIncidents().find(item => item.projectId === project.id));
  console.log(JSON.stringify({ stage: 'detected', incidentId: incident.id }));
  const detail = await until(() => { const value = getIncidentDetail(incident.id); return value.incident.resolvedAt && value; });
  assert.equal(detail.effects.length, 1); assert.equal(detail.effects[0].attempt, 1);
  assert.match(detail.effects[0].approvedBy, /^sre-policy:/); assert.equal(detail.incident.verification.scope, 'application_http');
  assert.ok(detail.incident.verification.samples >= 3); assert.ok(detail.incident.verification.windowMs >= 30000);
  assert.equal(docker('exec', containerName, 'cat', '/tmp/starts'), '2'); assert.equal((await fetch(endpoint)).status, 200);
  for (const [name, viewport] of [['desktop', '1440x1050'], ['mobile', '390x844']]) {
    await browser([...login('/oncall?incident=' + incident.id),
      { action: 'assert', text: '已验证恢复' }, { action: 'assert', text: '本事件依据独立 HTTP 探针及容器状态验证' },
      { action: 'eval', js: "() => [...document.querySelectorAll('h3')].find(el => el.textContent === '恢复验收')?.parentElement.scrollIntoView({ block: 'start', behavior: 'instant' })" },
      { action: 'wait', wait: 300 }, { action: 'screenshot', out: path.join(evidence, 'autonomy-' + name + '.png'), full_page: true },
      { action: 'assert', js: '() => document.documentElement.scrollWidth <= innerWidth + 1' },
      { action: 'open', url: base + '/#/reliability', wait_for: 'button:has-text("审阅自动授权")' },
      { action: 'assert', text: projectName },
      { action: 'screenshot', out: path.join(evidence, 'reliability-' + name + '.png'), full_page: true },
    ], 'autonomy-' + name, viewport);
  }
  writeFileSync(path.join(evidence, 'autonomy-result.json'), JSON.stringify({ passed: true, projectName, profile, policy: getAutonomyPolicy(profile.id), detail, actualStarts: 2, httpStatus: 200 }, null, 2));
  console.log(JSON.stringify({ passed: true, incidentId: incident.id, evidence }));
} finally {
  await stopObserver?.(); await stopWorker?.(); await app?.close();
  try { docker('rm', '-f', containerName); } finally { if (evidence !== directory) rmSync(directory, { recursive: true, force: true }); }
}
