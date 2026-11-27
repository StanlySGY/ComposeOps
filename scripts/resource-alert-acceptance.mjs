#!/usr/bin/env node
// Only creates disposable, unmounted, unexposed fixture containers. Existing
// projects are read-only; no production alert rule or data is changed.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), root = await mkdtemp(path.join(tmpdir(), 'resource-alert-acceptance-'));
process.env.DB_PATH = path.join(root, 'fixture.db'); process.env.DISABLE_BACKGROUND_JOBS = '1';
const docker = async args => (await exec('docker', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const image = process.argv[2];
assert.match(image || '', /@sha256:[a-f0-9]{64}$/);
const prefix = 'resource-alert-' + randomBytes(6).toString('hex'), started = [];
const { scanProjects, invalidateScanCache } = await import('../backend/src/services/scanner.js');
const { setProjectPreference } = await import('../backend/src/lib/db.js');
const { createAlertRule } = await import('../backend/src/services/alert-rules.js');
const { executeResourceAlertAction, alertActionState } = await import('../backend/src/services/resource-alert-actions.js');
const inspect = async id => JSON.parse(await docker(['inspect', id]))[0];
const baseline = (await docker(['ps', '-aq', '--no-trunc'])).split('\n').filter(Boolean);
const results = [];
try {
  for (const action of ['auto_restart', 'scale']) {
    const name = prefix + '-' + action.replace('_', '-'), file = path.join(root, name + '.json');
    const document = { services: { web: { image, command: ['sleep', '3600'] }, unrelated: { image, command: ['sleep', '3600'] } }, networks: { default: { internal: true } } };
    await writeFile(file, JSON.stringify(document), { mode: 0o600 });
    const compose = args => docker(['compose', '--project-name', name, '-f', file, ...args]);
    started.push({ compose, name });
    await compose(['up', '-d', '--pull', 'never', '--no-build']);
    invalidateScanCache();
    const project = (await scanProjects('local')).find(item => item.projectName === name);
    assert.ok(project); setProjectPreference(project.id, { managed: true, mountEnabled: true, operationalIntent: 'running' });
    const target = project.containers.find(item => item.service === 'web'), unrelated = project.containers.find(item => item.service === 'unrelated');
    const before = await inspect(target.id), untouched = await inspect(unrelated.id);
    const rule = await createAlertRule({ container: target.id, metric: 'restart_count', threshold: 0, action, confirmAutomatic: true });
    if (action === 'scale') {
      const original = await readFile(file, 'utf8');
      await writeFile(file, original.replace('3600', '3601'));
      await assert.rejects(executeResourceAlertAction(rule, target.id), /配置已变化/);
      assert.equal(alertActionState(rule).status, 'ready');
      await writeFile(file, original);
    }
    const result = await executeResourceAlertAction(rule, target.id);
    assert.equal(result.status, 'succeeded');
    const after = await inspect(target.id), otherAfter = await inspect(unrelated.id);
    assert.equal(after.State.Running, true);
    assert.equal(otherAfter.State.StartedAt, untouched.State.StartedAt);
    if (action === 'auto_restart') assert.notEqual(after.State.StartedAt, before.State.StartedAt);
    else {
      assert.equal(after.State.StartedAt, before.State.StartedAt, '扩容不能重建/重启原副本');
      const ids = (await docker(['ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + name, '--filter', 'label=com.docker.compose.service=web'])).split('\n');
      assert.equal(ids.length, 2); assert.ok(ids.includes(target.id));
    }
    assert.equal(alertActionState(rule).status, 'cooldown');
    await assert.rejects(executeResourceAlertAction(rule, target.id), /冷却/);
    const persisted = await exec(process.execPath, ['--input-type=module', '-e', `const {readAlertRules}=await import('./backend/src/services/alert-rule-store.js');const {alertActionState}=await import('./backend/src/services/resource-alert-actions.js');console.log(JSON.stringify(alertActionState(readAlertRules().find(r=>r.id===process.argv[1]))));`, rule.id], { cwd: process.cwd(), encoding: 'utf8', timeout: 15000, env: process.env });
    assert.equal(JSON.parse(persisted.stdout.trim().split('\n').at(-1)).status, 'cooldown');
    results.push({ action, result: result.status, otherServiceUnchanged: true, originalReplicaPreserved: action === 'scale', cooldownSurvivesProcessRestart: true });
    await compose(['down', '--timeout', '1']); started.pop();
  }
  const remaining = new Set((await docker(['ps', '-aq', '--no-trunc'])).split('\n'));
  assert.ok(baseline.every(id => remaining.has(id)), '已有容器必须保留');
  console.log(JSON.stringify({ passed: true, results, existingContainersPreserved: baseline.length, productionRulesChanged: false }));
} finally {
  for (const item of started.reverse()) await item.compose(['down', '--timeout', '1']).catch(error => console.error('Fixture cleanup needs attention:', item.name, error.message));
  await rm(root, { recursive: true, force: true });
}
