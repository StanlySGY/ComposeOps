// Run inside a disposable candidate container with its own DB and this unique host directory mounted.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.env.BACKUP_ACCEPTANCE_ROOT;
assert.match(root || '', /^\/tmp\/composeops-fork-acceptance-[a-f0-9-]+$/);
assert.ok(process.env.DB_PATH?.startsWith(root + '/state/'));
const name = 'co-fork-' + root.split('-').at(-1).slice(0, 8);
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim();
const compose = args => docker(['compose', '-p', name, '-f', root + '/app/compose.json', ...args]);
const app = root + '/app';
const exerciseInterruption = process.env.BACKUP_ACCEPTANCE_INTERRUPT === '1';
if (process.env.BACKUP_FIXTURE_PREPARED !== '1') {
for (const dir of [app, root + '/backups', root + '/restore', root + '/state']) await mkdir(dir, { recursive: true });
await writeFile(app + '/server.js', `const fs=require('fs');const http=require('http');fs.mkdirSync('/data',{recursive:true});if(!fs.existsSync('/data/proof'))fs.writeFileSync('/data/proof','backup-proof');http.createServer((req,res)=>res.end(fs.readFileSync('/data/proof'))).listen(8080);process.on('SIGTERM',()=>process.exit(0));`);
await writeFile(app + '/compose.json', JSON.stringify({ services: {
  web: { image: 'node:22-alpine', environment: { RESTORE_LITERAL: 'before$$MISSING_VAR$${HOME}after' }, command: ['node', '/app/server.js'], volumes: [app + ':/app:ro', 'state:/data', '/anonymous'], ports: ['127.0.0.1::8080'], healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://localhost:8080').then(r=>{if(!r.ok)process.exit(1)})"], interval: '1s', retries: 10 } },
  db: { image: 'redis:7-alpine', command: ['redis-server', '--appendonly', 'yes'], volumes: ['db:/data'] },
  stopped: { image: 'node:22-alpine', command: ['sleep', '10000'] },
}, volumes: { state: {}, db: {} } }));
if (exerciseInterruption) {
  // 延长真实归档窗口，便于在全部应用已停止后确定性地终止独立执行器。
  const payload = await open(app + '/interruption-payload', 'w');
  try { await payload.truncate(128 * 1024 ** 2); } finally { await payload.close(); }
}
}
if (process.env.BACKUP_FIXTURE_SETUP_ONLY === '1') process.exit(0);
let restoreCompose;
try {
  compose(['up', '-d']); compose(['stop', 'stopped']);
  compose(['exec', '-T', 'web', 'sh', '-c', 'echo writable-proof >/writable-proof; echo anonymous-proof >/anonymous/proof']);
  compose(['exec', '-T', 'db', 'redis-cli', 'set', 'proof', 'redis-backup-proof']);
  const { scanProjects, invalidateScanCache } = await import('../backend/src/services/scanner.js');
  const { setProjectPreference } = await import('../backend/src/lib/db.js');
  const { prepareMaintenance, executeMaintenance, refreshTasks, prepareFullRestore, executeFullRestore, recoverMaintenanceTask } = await import('../backend/src/services/container-maintenance.js');
  const { catalog } = await import('../backend/src/services/maintenance-store.js');
  let project = (await scanProjects()).find(p => p.projectName === name && p.workingDir === app);
  assert.ok(project); setProjectPreference(project.id, { managed: true, mountEnabled: true }); invalidateScanCache();
  project = (await scanProjects()).find(p => p.id === project.id);
  const selection = { action: 'backup', backupPath: root + '/backups', containerIds: [project.containers.find(c => c.service === 'web').id] };
  let plan = await prepareMaintenance(selection);
  assert.deepEqual(plan.blockers, []); assert.equal(plan.members.length, 3);
  console.log(JSON.stringify({ stage: 'backup-preflight', members: plan.members.length, sources: plan.sources.length }));
  async function finish(id) {
    for (let i = 0; i < 600; i++) {
      const task = (await refreshTasks()).tasks.find(t => t.id === id);
      if (i % 10 === 0) console.log(JSON.stringify({ stage: task.stage, status: task.status }));
      if (task.status !== 'running') { assert.equal(task.status, 'success', JSON.stringify(task)); return task; }
      await delay(1000);
    }
    assert.fail('Acceptance task timed out');
  }
  const { withProjectOperationLock } = await import('../backend/src/services/project-operation-lock.js');
  if (exerciseInterruption) {
    const interrupted = await executeMaintenance({ token: plan.token, confirmed: true, keySaved: true });
    const { getDockerForHost } = await import('../backend/src/services/docker-hosts.js');
    const client = getDockerForHost(project.hostId), worker = client.getContainer(interrupted.workerId);
    const info = await worker.inspect();
    assert.equal(info.Config.Labels['composeops.maintenance'], interrupted.id);
    assert.equal(info.Config.Labels['composeops.host'], project.hostId);
    const running = project.containers.filter(c => c.state === 'running');
    let killed = false;
    for (let i = 0; i < 2400; i++) {
      const current = await Promise.all(running.map(c => client.getContainer(c.id).inspect()));
      if (current.every(c => !c.State.Running)) {
        assert.equal((await worker.inspect()).State.Running, true);
        await worker.kill({ signal: 'SIGKILL' }); await worker.wait(); killed = true; break;
      }
      if (!(await worker.inspect()).State.Running) assert.fail('未捕获到停机后的执行器中断窗口');
      await delay(50);
    }
    assert.ok(killed, '必须实际中断停机中的备份');
    const interruptedState = (await refreshTasks()).tasks.find(t => t.id === interrupted.id);
    assert.equal(interruptedState.status, 'interrupted');
    assert.ok(!catalog().backups.some(b => b.id === interrupted.id));
    await assert.rejects(withProjectOperationLock(project.id, () => true), { code: 'PROJECT_BUSY' });
    const recovery = await recoverMaintenanceTask(interrupted.id); await finish(recovery.id);
    assert.equal(await withProjectOperationLock(project.id, () => true), true);
    for (const c of running) assert.equal((await client.getContainer(c.id).inspect()).State.Running, true);
    assert.equal(docker(['inspect', compose(['ps', '-aq', 'stopped']), '--format', '{{.State.Running}}']), 'false');
    await worker.remove();
    console.log(JSON.stringify({ stage: 'interruption-recovered', interruptedId: interrupted.id, recoveryId: recovery.id }));
    plan = await prepareMaintenance(selection); assert.deepEqual(plan.blockers, []);
  }
  const task = await executeMaintenance({ token: plan.token, confirmed: true, keySaved: true });
  await assert.rejects(executeMaintenance({ token: plan.token, confirmed: true, keySaved: true }));
  await assert.rejects(withProjectOperationLock(project.id, () => assert.fail('locked project must not run')), { code: 'PROJECT_BUSY' });
  await finish(task.id);
  assert.equal(await withProjectOperationLock(project.id, () => true), true);
  const backup = catalog().backups.find(b => b.id === task.id); assert.ok(backup.complete && backup.fileVerified);
  assert.equal(compose(['exec', '-T', 'db', 'redis-cli', 'get', 'proof']), 'redis-backup-proof');
  const stopped = docker(['inspect', compose(['ps', '-aq', 'stopped']), '--format', '{{.State.Running}}']); assert.equal(stopped, 'false');
  await assert.rejects(prepareFullRestore({ backupId: backup.id, destination: root + '/restore', expectedHostId: 'wrong-node' }), /节点已变化/);
  const stoppedPlan = await prepareFullRestore({ backupId: backup.id, destination: root + '/restore', expectedHostId: project.hostId });
  assert.deepEqual(stoppedPlan.blockers, []);
  const stoppedJob = await executeFullRestore({ token: stoppedPlan.token, confirmed: true });
  await assert.rejects(executeFullRestore({ token: stoppedPlan.token, confirmed: true }));
  const stoppedResult = (await finish(stoppedJob.id)).result;
  restoreCompose = stoppedResult.composeFile;
  assert.equal(stoppedResult.started, false);
  for (const id of stoppedResult.containerIds) assert.equal(docker(['inspect', id, '--format', '{{.State.Running}}']), 'false');
  docker(['compose', '-f', restoreCompose, 'down', '-v']); restoreCompose = undefined;
  console.log(JSON.stringify({ stage: 'stopped-restore-verified', restoreId: stoppedJob.id }));
  const restore = await prepareFullRestore({ backupId: backup.id, destination: root + '/restore', expectedHostId: project.hostId });
  assert.deepEqual(restore.blockers, []); assert.ok(restore.mappings.some(m => m.kind === 'volume'));
  const job = await executeFullRestore({ token: restore.token, confirmed: true, start: true }); const result = (await finish(job.id)).result;
  restoreCompose = result.composeFile;
  const restored = JSON.parse(await readFile(restoreCompose));
  for (const network of Object.values(restored.networks)) assert.equal(network.internal, true);
  const copy = args => docker(['compose', '-f', restoreCompose, ...args]);
  const webService = Object.entries(restored.services).find(([, s]) => s.command?.includes('/app/server.js'))[0];
  const dbService = Object.entries(restored.services).find(([, s]) => s.command?.includes('redis-server'))[0];
  assert.equal(copy(['exec', '-T', webService, 'cat', '/writable-proof']), 'writable-proof');
  assert.equal(copy(['exec', '-T', webService, 'node', '-p', 'process.env.RESTORE_LITERAL']), 'before$MISSING_VAR${HOME}after');
  assert.equal(copy(['exec', '-T', webService, 'cat', '/anonymous/proof']), 'anonymous-proof');
  assert.equal(copy(['exec', '-T', webService, 'node', '-e', "fetch('http://localhost:8080').then(r=>r.text()).then(console.log)"]), 'backup-proof');
  assert.equal(copy(['exec', '-T', dbService, 'redis-cli', 'get', 'proof']), 'redis-backup-proof');
  assert.equal((await stat(restoreCompose)).mode & 0o777, 0o600);
  console.log(JSON.stringify({ ok: true, backupId: backup.id, restoreRoot: result.root, checked: ['config', 'named-volume', 'anonymous-volume', 'writable-layer', 'original-stop-state', 'isolated-network', 'fixture-http', 'fixture-redis', 'literal-environment', 'project-lock', 'stopped-restore-default', 'one-use-confirmation', 'node-isolation', ...(exerciseInterruption ? ['worker-interruption-and-recovery'] : [])] }));
} finally {
  if (restoreCompose) docker(['compose', '-f', restoreCompose, 'down', '-v']);
  compose(['down', '-v']);
}
