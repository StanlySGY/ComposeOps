import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addColumn, runMigrations } from '../src/lib/db.js';

test('db-migrations: addColumn 幂等——列已存在时返回 false 且不抛错', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
  assert.equal(addColumn(db, 't', 'name', 'TEXT'), true);
  assert.equal(addColumn(db, 't', 'name', 'TEXT'), false);
  assert.equal(db.prepare('PRAGMA table_info(t)').all().filter((c) => c.name === 'name').length, 1);
});

test('db-migrations: runMigrations 对空库应用全部迁移并更新 user_version', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_preferences(project_id TEXT PRIMARY KEY);
    CREATE TABLE ai_history(id INTEGER PRIMARY KEY);
    CREATE TABLE alert_events(id INTEGER PRIMARY KEY);
    CREATE TABLE agent_plans(id INTEGER PRIMARY KEY);
    CREATE TABLE ai_sessions(session_id INTEGER PRIMARY KEY);
  `);
  assert.equal(db.pragma('user_version', { simple: true }), 0);
  const applied = runMigrations(db);
  assert.ok(applied.includes(1));
  assert.ok(applied.includes(2));
  assert.ok(applied.includes(3));
  assert.ok(applied.includes(4));
  assert.ok(applied.includes(5));
  assert.ok(applied.includes(6));
  assert.ok(applied.includes(7));
  assert.ok(applied.includes(8));
  assert.ok(applied.includes(9));
  assert.ok(applied.includes(10));
  assert.ok(applied.includes(11));
  assert.equal(db.pragma('user_version', { simple: true }), 12);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'volume_backups'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_records'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_definitions'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_memories'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage'").get());
  assert.ok(db.prepare('PRAGMA table_info(project_preferences)').all().some((c) => c.name === 'managed'));
  assert.ok(db.prepare('PRAGMA table_info(ai_history)').all().some((c) => c.name === 'session_id'));
  assert.ok(db.prepare('PRAGMA table_info(agent_plans)').all().some((c) => c.name === 'progress_stage'));
  assert.ok(db.prepare('PRAGMA table_info(agent_plans)').all().some((c) => c.name === 'project_id'));
  // v10/v11: ai_sessions 压缩分界列 + ai_memories 升级为 scope 银行(重要度/veracity/召回计数)
  assert.ok(db.prepare('PRAGMA table_info(ai_sessions)').all().some((c) => c.name === 'compacted_before_id'));
  assert.ok(db.prepare('PRAGMA table_info(ai_sessions)').all().some((c) => c.name === 'compact_summary'));
  const memoryCols = db.prepare('PRAGMA table_info(ai_memories)').all();
  for (const col of ['scope', 'scope_id', 'importance', 'veracity', 'recall_count']) {
    assert.ok(memoryCols.some((c) => c.name === col), `ai_memories 应有列 ${col}`);
  }
});

test('db-migrations: v11 后 upsertAiMemory 走新唯一键,增删查可用', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_preferences(project_id TEXT PRIMARY KEY);
    CREATE TABLE ai_history(id INTEGER PRIMARY KEY);
    CREATE TABLE alert_events(id INTEGER PRIMARY KEY);
    CREATE TABLE agent_plans(id INTEGER PRIMARY KEY);
    CREATE TABLE ai_sessions(session_id INTEGER PRIMARY KEY);
  `);
  runMigrations(db);
  // upsertAiMemory/listAiMemories 操作模块单例库;这里直接对内存库验证同款 SQL 的冲突目标。
  const insert = db.prepare(`
    INSERT INTO ai_memories(scope, scope_id, memory_key, value, source, confidence, updated_at)
    VALUES('global', '', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(scope, scope_id, memory_key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);
  insert.run('k1', 'v1', 'conversation', 'medium');
  insert.run('k1', 'v2', 'conversation', 'medium');
  const rows = db.prepare('SELECT memory_key, value, scope FROM ai_memories WHERE memory_key = ?').all('k1');
  assert.equal(rows.length, 1, '同 key 二次写入应命中唯一约束走 UPDATE,不产生重复行');
  assert.equal(rows[0].value, 'v2');
  assert.equal(rows[0].scope, 'global');
});

test('db-migrations: v6 创建 inspections 表', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_preferences(project_id TEXT PRIMARY KEY);
    CREATE TABLE ai_history(id INTEGER PRIMARY KEY);
    CREATE TABLE alert_events(id INTEGER PRIMARY KEY);
    CREATE TABLE agent_plans(id INTEGER PRIMARY KEY);
    CREATE TABLE ai_sessions(session_id INTEGER PRIMARY KEY);
  `);
  const applied = runMigrations(db);
  assert.ok(applied.includes(6));
  assert.equal(db.pragma('user_version', { simple: true }), 12);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inspections'").get());
  // 验证 inspections 表列结构
  const cols = db.prepare('PRAGMA table_info(inspections)').all();
  assert.ok(cols.some((c) => c.name === 'score'));
  assert.ok(cols.some((c) => c.name === 'grade'));
  assert.ok(cols.some((c) => c.name === 'findings_json'));
  assert.ok(cols.some((c) => c.name === 'created_at'));
  assert.ok(cols.some((c) => c.name === 'disk_used'));
  assert.ok(cols.some((c) => c.name === 'disk_total'));
});

test('db-migrations: v6 前创建 inspections 表后跳过(列不重复添加)', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE inspections(id INTEGER PRIMARY KEY, score INTEGER, grade TEXT, findings_json TEXT, predictions_json TEXT, summary TEXT, stats_json TEXT, disk_used INTEGER, disk_total INTEGER, duration_ms INTEGER, created_at TEXT, source TEXT);
    CREATE TABLE ai_sessions(session_id INTEGER PRIMARY KEY);
  `);
  db.pragma('user_version = 6');
  const applied = runMigrations(db);
  assert.ok(!applied.includes(6));
  assert.equal(db.pragma('user_version', { simple: true }), 12);
});

test('db-migrations: 已应用版本跳过,重放返回空数组', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_preferences(project_id TEXT PRIMARY KEY, managed INTEGER, mount_enabled INTEGER);
    CREATE TABLE ai_history(id INTEGER PRIMARY KEY, session_id INTEGER);
    CREATE TABLE alert_events(id INTEGER PRIMARY KEY, logs TEXT);
    CREATE TABLE agent_plans(id INTEGER PRIMARY KEY, rating INTEGER, feedback_text TEXT, feedback_at TEXT, progress_stage TEXT, progress_percent INTEGER, current_step_index INTEGER, updated_at TEXT, project_id TEXT, container_id TEXT);
    CREATE TABLE ai_sessions(session_id INTEGER PRIMARY KEY);
  `);
  db.pragma('user_version = 9');
  const applied = runMigrations(db);
  assert.deepEqual(applied, [10, 11, 12]);
  assert.equal(db.pragma('user_version', { simple: true }), 12);
  // v10 未越界:compacted_before_id 只在 v10 加过一次
  assert.ok(db.prepare('PRAGMA table_info(ai_sessions)').all().filter((c) => c.name === 'compacted_before_id').length === 1);
});

test('db-migrations: 真实 user_version=0 历史库(列已在)幂等升到 v4', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-legacy-'));
  const dbPath = join(dir, 'legacy.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE project_preferences(project_id TEXT PRIMARY KEY, managed INTEGER, mount_enabled INTEGER);
    CREATE TABLE ai_history(id INTEGER PRIMARY KEY, session_id INTEGER);
    CREATE TABLE alert_events(id INTEGER PRIMARY KEY, logs TEXT);
    CREATE TABLE agent_plans(id INTEGER PRIMARY KEY, rating INTEGER, feedback_text TEXT, feedback_at TEXT, progress_stage TEXT, progress_percent INTEGER, current_step_index INTEGER, updated_at TEXT, project_id TEXT, container_id TEXT);
    CREATE TABLE ai_sessions(session_id INTEGER PRIMARY KEY);
  `);
  db.pragma('user_version = 0');
  db.close();

  const reopened = new Database(dbPath);
  const applied = runMigrations(reopened);
  assert.ok(applied.includes(1));
  assert.ok(applied.includes(2));
  assert.ok(applied.includes(3));
  assert.ok(applied.includes(4));
  assert.equal(reopened.pragma('user_version', { simple: true }), 12);
  assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_memories'").get());
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test('db-migrations: 失败的迁移不提交版本号(事务包裹)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
  const badMigrations = [{ version: 99, name: 'broken', up: () => { throw new Error('fail'); } }];
  assert.throws(() => runMigrations(db, badMigrations), /fail/);
  assert.equal(db.pragma('user_version', { simple: true }), 0);
});
