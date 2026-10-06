import assert from 'node:assert/strict';
import test from 'node:test';
import Database from '../src/lib/sqlite.js';
import { runMigrations, listAiMemories, recordAiMemoryRecall, sleepAiMemories } from '../src/lib/db.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_preferences(project_id TEXT PRIMARY KEY);
    CREATE TABLE ai_history(id INTEGER PRIMARY KEY);
    CREATE TABLE alert_events(id INTEGER PRIMARY KEY);
    CREATE TABLE agent_plans(id INTEGER PRIMARY KEY);
    CREATE TABLE ai_sessions(session_id INTEGER PRIMARY KEY);
  `);
  runMigrations(db);
  return db;
}

// upsert/list 操作模块单例库;为可测,直接在内存库上执行同款 SQL 的镜像断言。
function seedMemory(db, { key, value, importance = 0.5, veracity = 'stated', daysAgo = 0 }) {
  const stamp = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`
    INSERT INTO ai_memories(scope, scope_id, memory_key, value, source, confidence, importance, veracity, updated_at, created_at)
    VALUES('global', '', ?, ?, 'conversation', 'medium', ?, ?, ?, ?)
  `).run(key, value, importance, veracity, stamp, stamp);
}

test('memory-ranking: veracity 权重与重要度主导排序,老记忆可胜出', () => {
  const db = freshDb();
  seedMemory(db, { key: '旧的核心理念', value: 'v1', importance: 0.95, veracity: 'stated', daysAgo: 10 });
  seedMemory(db, { key: '新的琐碎', value: 'v2', importance: 0.2, veracity: 'tool', daysAgo: 0 });
  const ranked = listAiMemories(10, '', db);
  assert.equal(ranked[0].memoryKey, '旧的核心理念', '重要且 stated 的老记忆应排第一');
  assert.ok(ranked[0].score > ranked[1].score, '排序公式应区分强弱记忆');
});

test('memory-sleep: 重复 value 合并保留最高重要度并累加召回数', () => {
  const db = freshDb();
  seedMemory(db, { key: 'k1', value: '同一内容', importance: 0.3, daysAgo: 5 });
  db.prepare("UPDATE ai_memories SET recall_count = 3 WHERE memory_key = 'k1'").run();
  seedMemory(db, { key: 'k2', value: '同一内容', importance: 0.8, daysAgo: 1 });
  const report = sleepAiMemories({ database: db });
  assert.ok(report, 'sleepAiMemories 应返回报告');
  const rows = db.prepare('SELECT memory_key, importance, recall_count FROM ai_memories').all();
  assert.equal(rows.length, 1, '同 value 应合并为一条');
  assert.equal(rows[0].memory_key, 'k2', '保留重要度高者');
  assert.equal(Number(rows[0].importance), 0.8);
  assert.equal(Number(rows[0].recall_count), 3, '召回数应合并');
});

test('memory-sleep: 衰减只作用久未使用记忆且有地板', () => {
  const db = freshDb();
  seedMemory(db, { key: '旧未用', value: 'a', importance: 0.5, daysAgo: 40 });
  seedMemory(db, { key: '新未用', value: 'b', importance: 0.5, daysAgo: 1 });
  seedMemory(db, { key: '旧但常召回', value: 'c', importance: 0.5, daysAgo: 40 });
  db.prepare("UPDATE ai_memories SET last_recalled_at = datetime('now') WHERE memory_key = '旧但常召回'").run();
  sleepAiMemories({ decayDays: 30, decayFactor: 0.9, importanceFloor: 0.05, database: db });
  const rows = Object.fromEntries(db.prepare('SELECT memory_key, importance FROM ai_memories').all().map((r) => [r.memory_key, Number(r.importance)]));
  assert.ok(Math.abs(rows['旧未用'] - 0.45) < 1e-9, '40 天未用应衰减 0.9 倍');
  assert.equal(rows['新未用'], 0.5, '近期记忆不衰减');
  assert.equal(rows['旧但常召回'], 0.5, '最近被召回的记忆不衰减(last_recalled_at 兜底)');
});

test('memory-sleep: 90 天以上从未召回且低重要度的记忆被清理', () => {
  const db = freshDb();
  seedMemory(db, { key: '低价值老记忆', value: 'a', importance: 0.05, daysAgo: 100 });
  seedMemory(db, { key: '高价值老记忆', value: 'b', importance: 0.9, daysAgo: 100 });
  seedMemory(db, { key: '低价值新记忆', value: 'c', importance: 0.05, daysAgo: 3 });
  const report = sleepAiMemories({ decayDays: 30, pruneDays: 90, database: db });
  assert.equal(report.pruned, 1, '只清理低价值+从未召回+90 天以上');
  const keys = db.prepare('SELECT memory_key FROM ai_memories').all().map((r) => r.memory_key);
  assert.ok(!keys.includes('低价值老记忆'));
  assert.ok(keys.includes('高价值老记忆') && keys.includes('低价值新记忆'));
});

test('memory-recall: 召回计数写回 recall_count 与 last_recalled_at', () => {
  const db = freshDb();
  seedMemory(db, { key: 'k1', value: 'a', daysAgo: 2 });
  const row = db.prepare("SELECT id FROM ai_memories WHERE memory_key = 'k1'").get();
  const touched = recordAiMemoryRecall([row.id], db);
  assert.equal(touched, 1);
  const after = db.prepare("SELECT recall_count, last_recalled_at FROM ai_memories WHERE memory_key = 'k1'").get();
  assert.equal(Number(after.recall_count), 1);
  assert.ok(after.last_recalled_at, 'last_recalled_at 应写回');
});
