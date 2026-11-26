import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
const dir = await mkdtemp('/tmp/maintenance-lock-');
process.env.DB_PATH = dir + '/db.sqlite';
const { default: db } = await import('../src/lib/db.js');
const { withProjectOperationLock, assertProjectOperationAllowed, isProjectOperationLocked } = await import('../src/services/project-operation-lock.js');
test.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
test('持久备份锁阻止配置与运行操作，独立项目继续工作', async () => {
  db.prepare('INSERT INTO maintenance_project_locks(project_id, task_id, host_id) VALUES (?, ?, ?)').run('a', 'backup1', 'local');
  assert.throws(() => assertProjectOperationAllowed('a'), { code: 'PROJECT_BUSY' });
  await assert.rejects(withProjectOperationLock('a', () => assert.fail('should not run')), { code: 'PROJECT_BUSY' });
  assert.equal(await withProjectOperationLock('b', () => 42), 42);
  db.prepare('DELETE FROM maintenance_project_locks WHERE task_id = ?').run('backup1');
  assert.equal(await withProjectOperationLock('a', () => 7), 7);
});
test('其他进程仍有效的主线租约阻止启动备份', () => {
  db.prepare('INSERT INTO project_operation_leases(project_id, owner, expires_at) VALUES (?, ?, ?)').run('a', 'other-process', Date.now() + 60000);
  assert.equal(isProjectOperationLocked('a'), true);
  db.prepare('DELETE FROM project_operation_leases WHERE project_id = ?').run('a');
  assert.equal(isProjectOperationLocked('a'), false);
});
