import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import fullBackupRoutes from '../src/routes/full-backup.js';

test('预检 API 校验项目参数并禁止响应缓存', async () => {
  const app = Fastify();
  const calls = [];
  await app.register(fullBackupRoutes, { prefix: '/ops', previewFullBackup: async id => { calls.push(id); return { mode: 'preview-only' }; } });
  try {
    for (const suffix of ['', '?projectId=', `?projectId=${'x'.repeat(129)}`]) {
      assert.equal((await app.inject(`/ops/storage/full-backup-plan${suffix}`)).statusCode, 400);
    }
    const response = await app.inject('/ops/storage/full-backup-plan?projectId=project1');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(calls, ['project1']);
  } finally { await app.close(); }
});

test('节点切换或未纳管返回明确错误，底层连接错误不泄露凭据', async () => {
  const app = Fastify();
  await app.register(fullBackupRoutes, { previewFullBackup: async id => {
    if (id === 'unmanaged') throw Object.assign(new Error('项目尚未加入管理'), { statusCode: 403, code: 'FULL_BACKUP_PREFLIGHT' });
    if (id === 'changed') throw Object.assign(new Error('节点已切换，请重新生成清单'), { statusCode: 409, code: 'FULL_BACKUP_PREFLIGHT' });
    throw Object.assign(new Error('ssh://user:private-password@host'), { statusCode: 403 });
  } });
  try {
    assert.equal((await app.inject('/storage/full-backup-plan?projectId=unmanaged')).statusCode, 403);
    assert.equal((await app.inject('/storage/full-backup-plan?projectId=changed')).statusCode, 409);
    const failure = await app.inject('/storage/full-backup-plan?projectId=broken');
    assert.equal(failure.statusCode, 502);
    assert.doesNotMatch(failure.body, /private-password/);
  } finally { await app.close(); }
});
