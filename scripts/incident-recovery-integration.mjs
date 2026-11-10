import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const directory = mkdtempSync(path.join(os.tmpdir(), 'composeops-incident-drill-'));
const evidence = path.resolve(process.env.SRE_EVIDENCE_DIR || directory);
mkdirSync(evidence, { recursive: true });
const projectName = 'co-sre-drill-' + Date.now();
const containerName = projectName + '-web';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
process.env.DB_PATH = path.join(directory, 'drill.db');
process.env.SERVE_FRONTEND = '1';
process.env.DISABLE_BACKGROUND_JOBS = '1';
process.env.ENABLE_SHELL = '0';
let app, stopWorker, stopObserver;
const password = randomUUID();
async function until(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)); }
  throw new Error('Timed out waiting for isolated incident condition');
}
async function browser(steps, name, viewport = '1440x1050') {
  const file = path.join(directory, name + '.json'); writeFileSync(file, JSON.stringify(steps), { mode: 0o600 });
  const { stdout } = await exec(process.env.CODEX_BROWSER || 'codex-browser', ['run', file, '--binary', process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', '--no-stealth', '--viewport', viewport, '--timeout', '30000'], { maxBuffer: 4 * 1024 * 1024 });
  // Browser output contains only assertions and page observations; no cookies/passwords.
  writeFileSync(path.join(evidence, name + '-browser.json'), stdout);
}
try {
  docker('run', '-d', '--name', containerName, '--label', 'com.docker.compose.project=' + projectName,
    '--label', 'com.docker.compose.service=web', '--network', 'none', '--memory', '32m', '--cpus', '0.25',
    '--health-cmd', 'test -f /tmp/ready', '--health-interval', '1s', '--health-timeout', '1s', '--health-retries', '1',
    'alpine:3.20', 'sh', '-c', 'if ! test -f /tmp/first-start; then touch /tmp/first-start; echo "PASSWORD=sre-drill-sensitive-value"; exit 7; fi; touch /tmp/ready; exec sleep 600');
  await until(() => docker('inspect', '-f', '{{.State.Status}}', containerName) === 'exited');
  const { buildApp } = await import('../backend/src/app.js');
  const { scanProjects } = await import('../backend/src/services/scanner.js');
  const { setProjectPreference } = await import('../backend/src/lib/db.js');
  const { setPassword } = await import('../backend/src/lib/auth.js');
  const { startIncidentObserver, stopIncidentObserver } = await import('../backend/src/services/incident-observer.js');
  const { startOpsEffectWorker, stopOpsEffectWorker } = await import('../backend/src/services/ops-effect-worker.js');
  const { listIncidents, getIncidentDetail } = await import('../backend/src/services/incident-store.js');
  const project = (await scanProjects('local')).find(item => item.projectName === projectName);
  assert(project, 'temporary Compose-labelled project should be discovered');
  setProjectPreference(project.id, { managed: true });
  setPassword(password);
  app = await buildApp({ logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  // Only the test project is eligible for this observer; test DB has no other managed targets.
  startIncidentObserver({ scan: async () => [{ ...project, managed: true }], pollMs: 15000 });
  stopObserver = stopIncidentObserver;
  const incident = await until(() => listIncidents().find(item => item.projectId === project.id));
  startOpsEffectWorker({ pollMs: 1000 }); stopWorker = stopOpsEffectWorker;
  const loginSteps = [
    { action: 'open', url: base + '/#/oncall?incident=' + incident.id, wait_for: 'input[type=password]' },
    { action: 'fill', selector: 'input[type=password]', value: password },
    { action: 'click', selector: 'button:has-text("安全登录")' },
    { action: 'wait', wait_for: '.oncall-view h1' },
    { action: 'click', selector: 'button:has-text("开始使用")' },
    { action: 'eval', js: "async () => { const end = Date.now() + 5000; while (document.querySelector('[role=dialog]') && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50)); }" },
    { action: 'assert', js: "() => !document.querySelector('[role=dialog]')" },
  ];
  await browser([...loginSteps,
    { action: 'assert', text: projectName },
    { action: 'assert', js: "() => !document.body.innerText.includes('sre-drill-sensitive-value')" },
    { action: 'click', selector: 'button:has-text("生成重启处置")' },
    { action: 'wait', wait_for: 'button:has-text("审阅并批准")' },
    { action: 'click', selector: 'button:has-text("审阅并批准")' },
    { action: 'wait', wait_for: '[role=dialog]' },
    { action: 'assert', text: '仅重启此容器一次' },
    { action: 'screenshot', out: path.join(evidence, 'approval-desktop.png'), full_page: true },
    { action: 'click', selector: '[role=dialog] button:has-text("批准并入队")' },
    { action: 'wait', wait_for: 'button:has-text("刷新")', wait: 2000 },
    { action: 'assert', js: '() => document.documentElement.scrollWidth <= innerWidth + 1' },
  ], 'approval-desktop');
  const recovered = await until(() => { const value = getIncidentDetail(incident.id); return value.incident.resolvedAt && value; }, 100000);
  assert.equal(recovered.effects.length, 1);
  assert.equal(recovered.effects[0].status, 'succeeded');
  assert.equal(recovered.effects[0].attempt, 1);
  assert.equal(recovered.incident.verification.scope, 'container_healthcheck');
  assert.ok(recovered.incident.verification.samples >= 3);
  assert.ok(recovered.incident.verification.windowMs >= 30000);
  assert.equal(docker('inspect', '-f', '{{.State.Health.Status}}', containerName), 'healthy');
  assert.equal(JSON.stringify(recovered).includes('sre-drill-sensitive-value'), false);
  for (const [name, viewport] of [['recovered-desktop', '1440x1050'], ['recovered-mobile', '390x844']]) {
    await browser([...loginSteps,
      { action: 'assert', text: '已验证恢复' },
      { action: 'assert', text: '处置完成，健康验收已通过' },
      { action: 'assert', js: '() => document.documentElement.scrollWidth <= innerWidth + 1' },
      { action: 'screenshot', out: path.join(evidence, name + '.png'), full_page: true },
      { action: 'eval', js: "() => document.querySelector('.oncall-view section:last-of-type')?.scrollIntoView({ block: 'start', behavior: 'instant' })" },
      { action: 'wait', wait: 300 },
      { action: 'screenshot', out: path.join(evidence, name + '-detail.png'), full_page: true },
      { action: 'eval', js: "() => [...document.querySelectorAll('.oncall-view h3')].find(el => el.textContent === '恢复验收')?.parentElement.scrollIntoView({ block: 'start', behavior: 'instant' })" },
      { action: 'wait', wait: 300 },
      { action: 'screenshot', out: path.join(evidence, name + '-verification.png'), full_page: true },
      { action: 'click', selector: 'a:has-text("任务与审计")' },
      { action: 'wait', wait_for: '.ops-ticket-workspace' },
      { action: 'assert', text: projectName },
    ], name, viewport);
  }
  writeFileSync(path.join(evidence, 'incident-recovery.json'), JSON.stringify({ passed: true, isolatedProject: projectName,
    incident: recovered.incident, effects: recovered.effects, reports: recovered.reports,
    browser: ['desktop-approval', 'desktop-recovery', 'mobile-recovery'], realHealthcheck: true }, null, 2));
  console.log(JSON.stringify({ passed: true, incidentId: incident.id, actualHealth: 'healthy', evidence }));
} finally {
  await stopObserver?.(); await stopWorker?.(); await app?.close();
  try { docker('rm', '-f', containerName); } finally { if (evidence !== directory) rmSync(directory, { recursive: true, force: true }); }
}
