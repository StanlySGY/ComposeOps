import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planRetention, applyRetention } from '../../scripts/release-retention.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directories = [];
  for (let i = 0; i < 4; i++) {
    const dir = path.join(root, `deploy-20261128-case${i}`), data = Buffer.from('synthetic encrypted backup ' + i);
    fs.mkdirSync(dir); directories.push(dir);
    fs.writeFileSync(path.join(dir, 'database-before.tar'), data);
    fs.utimesSync(path.join(dir, 'database-before.tar'), new Date(100000 + i * 1000), new Date(100000 + i * 1000));
    fs.writeFileSync(path.join(dir, 'database-before.sha256'), createHash('sha256').update(data).digest('hex') + '  database-before.tar\n');
    fs.writeFileSync(path.join(dir, 'deployment-result.json'), JSON.stringify({ healthy: true, revision: String(i).repeat(40) }));
    fs.writeFileSync(path.join(dir, 'release-method.json'), JSON.stringify({ revision: String(i).repeat(40) }));
    fs.writeFileSync(path.join(dir, 'production.env'), 'KEEP_SECRET');
  }
  fs.writeFileSync(path.join(root, 'opsdash.db'), 'KEEP_LIVE_DATABASE');
  return { root, directories };
}
const archive = dir => path.join(dir, 'database-before.tar');

test('preview is non-destructive; apply retains newest two, evidence, secrets and live files', async t => {
  const { root, directories } = fixture(t), plan = planRetention(root);
  assert.equal(plan.candidates.length, 2); assert.ok(directories.every(d => fs.existsSync(archive(d))));
  const result = await applyRetention(plan);
  assert.equal(result.deleted.length, 2); assert.equal(result.reclaimedBytes, plan.candidateBytes);
  assert.deepEqual(directories.map(d => fs.existsSync(archive(d))), [false, false, true, true]);
  assert.ok(directories.every(d => fs.existsSync(path.join(d, 'production.env')) && fs.existsSync(path.join(d, 'deployment-result.json'))));
  assert.equal(fs.readFileSync(path.join(root, 'opsdash.db'), 'utf8'), 'KEEP_LIVE_DATABASE');
  const events = fs.readFileSync(result.audit, 'utf8').trim().split('\n').map(line => JSON.parse(line).event);
  assert.deepEqual(events, ['started', 'delete_intent', 'deleted', 'delete_intent', 'deleted', 'completed']);
  await assert.rejects(applyRetention(plan), /变化/);
});

test('retention honors pins, minimum age and failed or incomplete deployments', t => {
  const { root, directories } = fixture(t);
  fs.writeFileSync(path.join(directories[0], '.retain'), 'manual pin');
  fs.writeFileSync(path.join(directories[1], '.deploying'), 'active');
  let plan = planRetention(root); assert.equal(plan.candidates.length, 0);
  assert.ok(plan.retained.some(r => r.reason.includes('.retain')));
  fs.unlinkSync(path.join(directories[1], '.deploying'));
  fs.writeFileSync(path.join(directories[1], 'deployment-result.json'), JSON.stringify({ healthy: false }));
  plan = planRetention(root); assert.equal(plan.candidates.length, 0); assert.equal(plan.skipped.length, 1);
  assert.throws(() => planRetention(root, { keep: 1 }), /至少保留/);
  fs.unlinkSync(path.join(directories[0], '.retain'));
  for (const dir of directories) fs.utimesSync(archive(dir), new Date(), new Date());
  const fresh = planRetention(root); assert.equal(fresh.candidates.length, 0);
  assert.ok(fresh.retained.some(r => r.reason.includes('年龄')));
});

test('changed candidate, new pin and tampered plan abort before deletion', async t => {
  const { root, directories } = fixture(t);
  let plan = planRetention(root);
  fs.appendFileSync(archive(directories[0]), 'changed');
  await assert.rejects(applyRetention(plan), /变化/);
  plan = planRetention(root); fs.writeFileSync(path.join(directories[0], '.retain'), 'new');
  await assert.rejects(applyRetention(plan), /变化/);
  plan = planRetention(root); plan.candidates[0].file = '../opsdash.db';
  await assert.rejects(applyRetention(plan), /变化/);
  assert.ok(directories.every(d => fs.existsSync(archive(d))));
});

test('checksum failure in a retained backup stops all deletion and releases lock', async t => {
  const { root, directories } = fixture(t);
  fs.appendFileSync(archive(directories[3]), 'corrupted');
  await assert.rejects(applyRetention(planRetention(root)), /校验失败/);
  assert.ok(directories.every(d => fs.existsSync(archive(d))));
  assert.equal(fs.existsSync(path.join(root, '.release-retention.lock')), false);
});

test('symbolic links, hard links, stale plans and concurrent cleanup fail closed', async t => {
  const { root, directories } = fixture(t);
  fs.unlinkSync(archive(directories[0])); fs.symlinkSync(path.join(root, 'opsdash.db'), archive(directories[0]));
  fs.linkSync(archive(directories[1]), path.join(root, 'backup-alias'));
  assert.equal(planRetention(root).candidates.length, 0);
  fs.unlinkSync(path.join(root, 'backup-alias')); fs.unlinkSync(archive(directories[0])); fs.writeFileSync(archive(directories[0]), 'synthetic encrypted backup 0');
  fs.utimesSync(archive(directories[0]), new Date(100000), new Date(100000));
  const plan = planRetention(root);
  await assert.rejects(applyRetention(plan, plan.expiresAt + 1), /过期/);
  fs.mkdirSync(path.join(root, '.release-retention.lock'));
  await assert.rejects(applyRetention(plan), /EEXIST/);
  assert.ok(directories.every(d => fs.existsSync(archive(d))));
});

test('symlinked roots and deployment directories are never traversed', t => {
  const { root, directories } = fixture(t), alias = root + '-alias';
  fs.symlinkSync(root, alias); t.after(() => fs.unlinkSync(alias));
  assert.throws(() => planRetention(alias), /真实/);
  fs.symlinkSync(directories[0], path.join(root, 'deploy-20261128-alias'));
  const plan = planRetention(root); assert.equal(plan.candidates.length, 2);
  assert.ok(plan.skipped.some(row => row.directory.endsWith('-alias')));
});
