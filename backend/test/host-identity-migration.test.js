import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from '../src/lib/sqlite.js';
import db, { runMigrations } from '../src/lib/db.js';
import { composeProjectId } from '../src/services/project-id.js';
test('v19 副本备份→v20 迁移→还原：保留旧项目身份及全部历史归属', () => {
  const root = mkdtempSync(join(tmpdir(), 'composeops-migration-drill-'));
  const source = join(root, 'source.db'), backup = join(root, 'before.db');
  db.vacuumInto(source);
  let legacy = new Database(source);
  const id = composeProjectId('/same/path', 'app');
  // 撤回 v25–28 的新增结构后再模拟 v19；仅改 user_version 不等于旧版本数据库。
  for (const table of ['sre_worker_heartbeats', 'sre_platform_samples', 'sre_alert_rules', 'sre_alert_states', 'sre_alert_deliveries',
    'sre_diagnosis_evaluations', 'sre_telemetry_credentials', 'sre_telemetry_quotas', 'sre_telemetry',
    'sre_business_plans', 'sre_business_backups', 'sre_business_runs', 'sre_onboarding']) legacy.exec(`DROP TABLE ${table}`);
  legacy.exec('ALTER TABLE sre_changes DROP COLUMN started_at; ALTER TABLE ops_incidents DROP COLUMN diagnosis_json');
  legacy.pragma('user_version = 19');
  legacy.exec("DELETE FROM settings WHERE key = 'projects.legacy_host_id'");
  legacy.prepare("INSERT OR REPLACE INTO settings VALUES('docker.active_host', ?)").run('remote-a');
  legacy.prepare('INSERT INTO project_preferences(project_id, managed, note) VALUES(?, 1, ?)').run(id, '保留备注');
  legacy.prepare("INSERT INTO operation_history(project_id, action, status) VALUES(?, 'pull', 'success')").run(id);
  legacy.vacuumInto(backup);
  assert.deepEqual(runMigrations(legacy), [20, 21, 22, 23, 24, 25, 26, 27, 28]);
  const owner = legacy.prepare("SELECT value FROM settings WHERE key = 'projects.legacy_host_id'").get().value;
  assert.equal(owner, 'remote-a');
  assert.equal(composeProjectId('/same/path', 'app', 'remote-a', owner), id);
  assert.notEqual(composeProjectId('/same/path', 'app', 'local', owner), id);
  assert.equal(legacy.prepare('SELECT note FROM project_preferences WHERE project_id = ?').get(id).note, '保留备注');
  assert.equal(legacy.prepare('SELECT count(*) n FROM operation_history WHERE project_id = ?').get(id).n, 1);
  assert.equal(legacy.pragma('integrity_check', { simple: true }), 'ok');
  legacy.close();
  copyFileSync(backup, source);
  legacy = new Database(source);
  assert.equal(legacy.pragma('user_version', { simple: true }), 19);
  assert.equal(legacy.prepare('SELECT note FROM project_preferences WHERE project_id = ?').get(id).note, '保留备注');
  legacy.close(); rmSync(root, { recursive: true, force: true });
});
