import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const temp = await mkdtemp(path.join(os.tmpdir(), 'maintenance-workspace-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.COMPOSEOPS_RUNNER_IMAGE = 'fixture:local';
const { default: docker } = await import('../src/services/docker.js');
const { withRunner, closeIdleProjectRunners, closeAllWorkspaceRunners } = await import('../src/services/compose-workspace.js');
const project = (id) => ({ id, workingDir: '/apps/' + id, composeFiles: ['/apps/' + id + '/compose.yml'] });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function fixture(t) {
  const removed = [];
  t.mock.method(docker, 'createContainer', async ({ WorkingDir }) => ({
    start: async () => {},
    inspect: async () => ({ State: { Running: true } }),
    remove: async () => { removed.push(WorkingDir); },
    exec: async ({ Cmd }) => ({
      start: async () => {
        const payload = Buffer.from(Cmd.at(-1) + '\n');
        const header = Buffer.alloc(8);
        header[0] = 1;
        header.writeUInt32BE(payload.length, 4);
        return Readable.from([Buffer.concat([header, payload])]);
      },
      inspect: async () => ({ ExitCode: 0 }),
    }),
  }));
  return { removed };
}
test('预检等待所选工作命令完成，不能中途删除执行器', async (t) => {
  const { removed } = fixture(t), entered = deferred(), release = deferred();
  const work = withRunner(project('selected'), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const cleanup = closeIdleProjectRunners(['selected'], { waitMs: 1000 });
  assert.deepEqual(removed, []);
  release.resolve();
  await Promise.all([work, cleanup]);
  assert.deepEqual(removed, ['/apps/selected']);
});
test('无关应用的工作命令不阻止所选应用回收，超时不强杀活跃执行器', async (t) => {
  const { removed } = fixture(t), entered = deferred(), release = deferred();
  await withRunner(project('selected'), async () => {});
  const work = withRunner(project('other'), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    await closeIdleProjectRunners(['selected'], { waitMs: 100 });
    assert.deepEqual(removed, ['/apps/selected']);
    await assert.rejects(closeIdleProjectRunners(['other'], { waitMs: 10 }), { statusCode: 409 });
    assert.deepEqual(removed, ['/apps/selected']);
  } finally {
    release.resolve();
    await work;
    await closeAllWorkspaceRunners();
  }
});
test.after(async () => {
  const { default: db } = await import('../src/lib/db.js');
  db.close();
  await rm(temp, { recursive: true, force: true });
});
