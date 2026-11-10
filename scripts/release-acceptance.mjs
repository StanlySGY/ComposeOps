import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Docker from 'dockerode';
if (!process.argv.includes('--run-isolated-fixtures')) throw new Error('需显式传入 --run-isolated-fixtures');
const output = path.resolve(process.env.SRE_EVIDENCE_DIR || '/tmp/composeops-release-evidence'); await mkdir(output, { recursive: true, mode: 0o700 });
const work = await mkdtemp(path.join(os.tmpdir(), 'composeops-release-')); process.env.DB_PATH = path.join(work, 'db.sqlite'); process.env.DISABLE_BACKGROUND_JOBS = '1';
const { default: db, setProjectPreference } = await import('../backend/src/lib/db.js');
const { getHost } = await import('../backend/src/services/docker-hosts.js');
const { saveSreProfile } = await import('../backend/src/services/sre-profiles.js');
const { reviewSreRelease, approveSreRelease, executeSreRelease } = await import('../backend/src/services/sre-releases.js');
const { sreChangeFingerprint } = await import('../backend/src/services/sre-changes.js');
const { captureDeploymentInputs } = await import('../backend/src/services/reviewed-deployment.js');
const docker = new Docker(), cli = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const name = 'composeops-test-release-' + randomBytes(5).toString('hex'), file = path.join(work, 'compose.json');
const images = { old: 'composeops:sre-release-old', next: 'composeops:sre-release-next', bad: 'composeops:sre-release-bad' };
const compose = args => cli('docker', ['compose', '-p', name, '-f', file, ...args], { timeout: 180000, maxBuffer: 1024 ** 2 });
let project, success = false;
try {
  for (const [variant, image] of Object.entries(images)) await cli('docker', ['build', '-t', image, '--build-arg', 'REVISION=' + variant, '--build-arg', 'FAIL=' + (variant === 'bad' ? '1' : '0'), 'scripts/fixtures/sre-release'], { timeout: 180000, maxBuffer: 1024 ** 2 });
  const document = { services: Object.fromEntries(['database-api', 'backend-api', 'frontend-web'].map((service, index, all) => [service, { image: images.old,
    ports: [{ target: 8080, published: '0', host_ip: '127.0.0.1' }], ...(index ? { depends_on: [all[index - 1]], environment: { UPSTREAM: 'http://' + all[index - 1] + ':8080/' } } : {}) }])) };
  await writeFile(file, JSON.stringify(document), { mode: 0o600 }); await compose(['up', '-d', '--pull', 'never']);
  const rows = await docker.listContainers({ all: true, filters: { label: ['com.docker.compose.project=' + name] } });
  project = { id: name, projectName: name, hostId: 'local', host: getHost('local'), managed: true, editable: true, mountEnabled: true, mounted: true, workingDir: work, composeFiles: [file], containers: rows.map(row => ({ id: row.Id, service: row.Labels['com.docker.compose.service'] })) };
  setProjectPreference(name, { managed: true, mountEnabled: true });
  const urls = {};
  for (const row of rows) { const info = await docker.getContainer(row.Id).inspect(); urls[row.Labels['com.docker.compose.service']] = 'http://127.0.0.1:' + info.NetworkSettings.Ports['8080/tcp'][0].HostPort + '/'; }
  // Pin the loopback ports in the source Compose before review; container recreations retain endpoints.
  for (const [service, definition] of Object.entries(document.services)) definition.ports[0].published = new URL(urls[service]).port;
  await writeFile(file, JSON.stringify(document), { mode: 0o600 }); await compose(['up', '-d', '--pull', 'never']);
  const dependencies = { scan: async () => [project], dockerForHost: () => docker, capture: captureDeploymentInputs };
  const profiles = [];
  for (const serviceName of Object.keys(document.services)) {
    for (let i = 0; i < 20; i++) { if ((await fetch(urls[serviceName]).catch(() => ({ status: 0 }))).status === 200) break; await sleep(500); }
    profiles.push(await saveSreProfile({ projectId: name, serviceName, config: { url: urls[serviceName], timeoutMs: 2000, maxLatencyMs: 2000 } }, 'fixture', dependencies));
  }
  const input = (failing = false) => ({ services: profiles.map((profile, index) => ({ profileId: profile.id, image: failing && index === 1 ? images.bad : images.next, migration: 'none', compatibilityNote: '独立测试 HTTP 服务，无数据库迁移，版本可以双向回退' })) });
  const execute = async fail => {
    const reviewed = await reviewSreRelease(input(fail), 'fixture', dependencies);
    approveSreRelease(reviewed.id, { confirm: 'APPLY_APPLICATION_RELEASE', fingerprint: sreChangeFingerprint(reviewed), allowRollback: true, compatibilityConfirmed: true }, 'fixture');
    const result = await executeSreRelease(reviewed.id, dependencies); await writeFile(path.join(output, fail ? 'failed-middle-rollback.json' : 'ordered-success.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); return result;
  };
  const failed = await execute(true); assert.equal(failed.status, 'rolled_back', failed.error);
  assert.deepEqual(failed.result.steps.map(row => row.serviceName), ['database-api', 'backend-api']); assert.deepEqual(failed.result.rollbackSteps.map(row => row.serviceName), ['backend-api', 'database-api']);
  for (const url of Object.values(urls)) { const reply = await fetch(url); assert.equal(reply.status, 200); assert.equal((await reply.json()).revision, 'old'); }
  const passed = await execute(false); assert.equal(passed.status, 'succeeded', passed.error);
  assert.equal(passed.result.steps.length, 3); for (const url of Object.values(urls)) assert.equal((await (await fetch(url)).json()).revision, 'next');
  success = true; console.log(JSON.stringify({ orderedRelease: 'passed', failedMiddleStoppedLaterService: true, reverseRollback: 'passed', services: 3 }));
} finally {
  await compose(['down', '-v', '--remove-orphans']);
  assert.equal((await docker.listContainers({ all: true, filters: { label: ['com.docker.compose.project=' + name] } })).length, 0);
  await import('../backend/src/services/workflow-engine.js'); await new Promise(resolve => setImmediate(resolve)); db.close();
  if (success) await rm(work, { recursive: true, force: true }); else console.error('失败验收状态保留于：' + work);
}
