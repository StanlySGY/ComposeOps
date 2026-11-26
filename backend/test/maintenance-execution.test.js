import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-execution-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { maintenanceExecutionMode } = await import('../src/services/container-maintenance.js');
const prepared = action => ({ action, config: { backupPath: '/backups/apps' }, publicPlan: { blockers: [], coverageVerified: true } });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test('不能通过备份接口绕过现有发布评审流程', () => {
  assert.throws(() => maintenanceExecutionMode(prepared('update'), { confirmed: true, keySaved: true }), /发布评审/);
});
test('完整性预检不能绕过', () => {
  for (const plan of [{ blockers: ['数据未覆盖'], coverageVerified: true }, { blockers: [], coverageVerified: false }]) {
    assert.throws(() => maintenanceExecutionMode({ ...prepared('backup'), publicPlan: plan }, { confirmed: true, keySaved: true }), /预检未通过/);
  }
});
test('手动备份保留范围与密钥确认，不继承自动更新权限', () => {
  for (const input of [{}, { confirmed: true }, { keySaved: true }]) assert.throws(() => maintenanceExecutionMode(prepared('backup'), input, '/backups/apps'), /尚未确认/);
  assert.equal(maintenanceExecutionMode(prepared('backup'), { confirmed: true, keySaved: true }, ''), 'manual');
});
