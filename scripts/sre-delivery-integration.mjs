import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile), root = mkdtempSync(path.join(os.tmpdir(), 'composeops-delivery-drill-'));
const projectDir = path.join(root, 'app'), evidence = path.resolve(process.env.SRE_EVIDENCE_DIR || root);
mkdirSync(projectDir); mkdirSync(evidence, { recursive: true });
const name = 'co-delivery-' + Date.now(), composeFile = path.join(projectDir, 'compose.yml'), oldTag = name + ':old', badTag = name + ':bad';
process.env.DB_PATH = path.join(root, 'state.db'); process.env.SERVE_FRONTEND = '1'; process.env.DISABLE_BACKGROUND_JOBS = '1'; process.env.ENABLE_SHELL = '0';
const docker = (...args) => execFileSync('docker', args, { cwd: projectDir, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const compose = (...args) => docker('compose', '--project-name', name, '-f', composeFile, ...args);
let app, runtime, completed = false;
async function until(check, timeout = 240000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)); } throw new Error('Expected isolated drill result was not observed'); }
async function browser(steps, fileName, viewport = '1440x1050') {
  const file = path.join(root, fileName + '.json'); writeFileSync(file, JSON.stringify(steps), { mode: 0o600 });
  const { stdout } = await exec('codex-browser', ['run', file, '--binary', '/usr/bin/google-chrome', '--no-stealth', '--viewport', viewport, '--timeout', '30000'], { maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(path.join(evidence, fileName + '.jsonl'), stdout);
}
try {
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  for (const [tag, file] of [[oldTag, 'health'], [badTag, 'not-health']]) {
    writeFileSync(path.join(projectDir, 'Dockerfile'), `FROM busybox:1.36\nLABEL composeops.fixture=${name}\nRUN mkdir -p /www && echo ready >/www/${file}\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n`);
    docker('build', '--pull=false', '-t', tag, '.');
  }
  writeFileSync(composeFile, `services:\n  web:\n    image: ${oldTag}\n    ports: ["127.0.0.1:${port}:8080"]\n    volumes: ["data:/data"]\n    mem_limit: 48m\n    cpus: 0.25\nvolumes:\n  data: {}\n`, { mode: 0o600 });
  compose('up', '-d', '--pull', 'never');
  const endpoint = `http://127.0.0.1:${port}/health`;
  await until(async () => { try { return (await fetch(endpoint)).status === 200; } catch { return false; } }, 15000);
  const oldId = docker('image', 'inspect', oldTag, '--format', '{{.Id}}'), badId = docker('image', 'inspect', badTag, '--format', '{{.Id}}');
  const { buildApp } = await import('../backend/src/app.js');
  const { scanProjects, invalidateScanCache } = await import('../backend/src/services/scanner.js');
  const { setProjectPreference, setSetting } = await import('../backend/src/lib/db.js');
  const { setPassword } = await import('../backend/src/lib/auth.js');
  const { saveSreProfile } = await import('../backend/src/services/sre-profiles.js');
  const { listSreChanges, executeSreChange } = await import('../backend/src/services/sre-changes.js');
  const { listRecoveryRuns } = await import('../backend/src/services/sre-recovery.js');
  const { createSreRuntime } = await import('../backend/src/services/sre-runtime.js');
  const { createVolumeBackup } = await import('../backend/src/services/volume-backup.js');
  let project = (await scanProjects('local', { background: true })).find(item => item.projectName === name); assert(project);
  setProjectPreference(project.id, { managed: true, mountEnabled: true }); project = (await scanProjects('local', { background: true })).find(item => item.id === project.id);
  const profile = await saveSreProfile({ hostId: 'local', projectId: project.id, serviceName: 'web', config: { url: endpoint, maxLatencyMs: 3000 } });
  const password = randomUUID(); setPassword(password); app = await buildApp({ logger: false }); await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const login = tab => [ { action: 'open', url: base + '/#/reliability?tab=' + tab, wait_for: 'input[type=password]' }, { action: 'fill', selector: 'input[type=password]', value: password }, { action: 'click', selector: 'button:has-text("安全登录")' }, { action: 'wait', wait_for: '.page-title' }, { action: 'click', selector: 'button:has-text("开始使用")' }, { action: 'eval', js: "async () => { const end = Date.now() + 5000; while (document.querySelector('[role=dialog]') && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50)); }" } ];
  runtime = createSreRuntime({ intervalMs: 1000, change: id => executeSreChange(id, { verificationAttempts: 3 }) }); runtime.start();
  await browser([...login('changes'), { action: 'click', selector: 'button:has-text("评审镜像变更")' }, { action: 'fill', selector: 'input[placeholder="registry/app:version 或完整镜像 ID"]', value: badTag }, { action: 'click', selector: 'button:has-text("生成变更评审")' }, { action: 'wait', wait_for: 'button:has-text("审阅并批准变更")' }, { action: 'click', selector: 'button:has-text("审阅并批准变更")' }, { action: 'assert', text: oldId }, { action: 'assert', text: badId }, { action: 'click', selector: '[role=dialog] input[type=checkbox]' }, { action: 'screenshot', out: path.join(evidence, 'change-approval.png'), full_page: true }, { action: 'click', selector: 'button:has-text("批准并执行")' } ], 'change-approval');
  const change = await until(() => { const row = listSreChanges()[0]; return row && !['reviewed','queued','checking','executing','verifying','rolling_back','verifying_rollback'].includes(row.status) && row; });
  writeFileSync(path.join(evidence, 'change-result.json'), JSON.stringify(change, null, 2));
  assert.equal(change.status, 'rolled_back', change.error); assert.equal(change.review.old.imageId, oldId); assert.equal(change.review.next.imageId, badId);
  assert.equal(change.result.forwardVerification.passed, false); assert.equal(change.result.rollbackVerification.passed, true);
  assert.ok(change.result.rollbackVerification.evidence.at(-1).at - change.result.rollbackVerification.evidence[0].at >= 30000);
  const container = compose('ps', '-q', 'web'); assert.equal(docker('inspect', container, '--format', '{{.Image}}'), oldId); assert.equal((await fetch(endpoint)).status, 200);
  docker('exec', container, 'sh', '-c', 'echo fixture-data > /data/record.txt');
  invalidateScanCache(); project = (await scanProjects('local', { background: true })).find(item => item.id === project.id);
  const volume = name + '_data'; setSetting('backup.volume_dir', path.join(root, 'backups'));
  const backup = await createVolumeBackup(project, volume);
  await browser([...login('recovery'), { action: 'click', selector: 'button:has-text("新建恢复计划")' }, { action: 'wait', wait_for: '[role=dialog] select:has(option[value="local:' + project.id + '"])' }, { action: 'eval', js: `() => { const el = document.querySelector('[role=dialog] select'); el.value = ${JSON.stringify('local:' + project.id)}; el.dispatchEvent(new Event('change', { bubbles: true })); }` }, { action: 'wait', wait_for: '[role=dialog] input[value="' + volume + '"]' }, { action: 'click', selector: '[role=dialog] input[value="' + volume + '"]' }, { action: 'click', selector: 'button:has-text("保存恢复计划")' }, { action: 'wait', wait_for: 'button:has-text("运行隔离演练")' }, { action: 'click', selector: 'button:has-text("运行隔离演练")' } ], 'recovery-create');
  const run = await until(() => { const row = listRecoveryRuns()[0]; return row && !['queued','running'].includes(row.status) && row; });
  writeFileSync(path.join(evidence, 'recovery-result.json'), JSON.stringify(run, null, 2));
  assert.equal(run.status, 'passed', run.error); assert.equal(run.result.cleanupComplete, true); assert.equal(run.result.businessRecoveryVerified, false);
  assert.equal(run.result.volumes[0].backupId, backup.id); assert.equal(docker('exec', container, 'cat', '/data/record.txt'), 'fixture-data');
  for (const resource of run.result.resources) assert.equal(resource.state, 'removed');
  for (const [label, viewport] of [['desktop', '1440x1050'], ['mobile', '390x844']]) for (const tab of ['changes', 'recovery']) {
    await browser([...login(tab), { action: 'assert', text: tab === 'changes' ? '原镜像已恢复并验收' : '隔离演练达标' }, { action: 'assert', js: '() => document.documentElement.scrollWidth <= innerWidth + 1' }, { action: 'screenshot', out: path.join(evidence, `${tab}-${label}.png`), full_page: true }], `${tab}-${label}`, viewport);
  }
  completed = true; writeFileSync(path.join(evidence, 'delivery-result.json'), JSON.stringify({ passed: true, projectName: name, profileId: profile.id, changeId: change.id, runId: run.id, httpStatus: 200, restoredImage: oldId, originalVolumePreserved: true }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence }));
} finally {
  await runtime?.stop(); await app?.close();
  try { compose('down', '-v', '--remove-orphans'); } catch (error) { console.error('fixture cleanup failed:', error.message); }
  for (const tag of [oldTag, badTag]) { try { docker('image', 'rm', tag); } catch { /* building may have failed before creating the fixture tag */ } }
  if (completed && evidence !== root) rmSync(root, { recursive: true, force: true });
  else if (!completed) console.error('failed fixture artifacts retained:', root);
}
