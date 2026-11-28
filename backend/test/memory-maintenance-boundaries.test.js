import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import db, { listAiMemories, sleepAiMemories, upsertAiMemory } from '../src/lib/db.js';
import { registerMemoryTools } from '../src/services/tools/memory-tools.js';

beforeEach(() => db.exec('DELETE FROM ai_memories'));

function seed({ key, scope = 'global', scopeId = '', value = '相同事实', importance = 0.5, updated = '2026-11-28 00:00:00', created = updated, recalled = null, count = 0 }) {
  return Number(db.prepare(`INSERT INTO ai_memories(scope,scope_id,memory_key,value,importance,veracity,updated_at,created_at,last_recalled_at,recall_count)
    VALUES(?,?,?,?,?,'stated',?,?,?,?)`).run(scope, scopeId, key, value, importance, updated, created, recalled, count).lastInsertRowid);
}

test('记忆整理只合并同一作用域和项目的相同内容', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-29T00:00:00Z') });
  seed({ key: 'global' });
  seed({ key: 'a-old', scope: 'project', scopeId: 'a', importance: 0.2, count: 2 });
  const a = seed({ key: 'a-keep', scope: 'project', scopeId: 'a', importance: 0.9, count: 3 });
  const b = seed({ key: 'b-keep', scope: 'project', scopeId: 'b', importance: 0.7, count: 7 });
  seed({ key: 'host-a', scope: 'host', scopeId: 'a' });
  const report = sleepAiMemories();
  const rows = db.prepare('SELECT * FROM ai_memories ORDER BY id').all();
  assert.equal(report.deduped, 1);
  assert.equal(rows.length, 4);
  assert.equal(rows.find(row => row.id === a).recall_count, 5);
  assert.equal(rows.find(row => row.id === b).recall_count, 7);
});

test('去重保留最新召回和真实内容时间，不把整理冒充一次用户更新', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-29T00:00:00Z') });
  seed({ key: 'keeper', importance: 0.8, updated: '2026-09-01 00:00:00', created: '2026-08-01 00:00:00', recalled: '2026-09-02 00:00:00', count: 2 });
  seed({ key: 'recent-recall', importance: 0.4, updated: '2026-09-03 00:00:00', created: '2026-07-01 00:00:00', recalled: '2026-11-28 00:00:00', count: 5 });
  const report = sleepAiMemories();
  const row = db.prepare('SELECT * FROM ai_memories').get();
  assert.equal(row.memory_key, 'keeper');
  assert.equal(row.importance, 0.8, '近期召回的同一事实不应衰减');
  assert.equal(row.recall_count, 7);
  assert.equal(row.last_recalled_at, '2026-11-28 00:00:00');
  assert.equal(row.updated_at, '2026-09-03 00:00:00');
  assert.equal(row.created_at, '2026-07-01 00:00:00');
  assert.deepEqual(report, { deduped: 1, decayed: 0, pruned: 0 });
});

test('长期未用的重复记忆仍衰减，去重不会凭空刷新新鲜度', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-29T00:00:00Z') });
  seed({ key: 'old-a', importance: 0.8, updated: '2026-09-01 00:00:00' });
  seed({ key: 'old-b', importance: 0.4, updated: '2026-09-02 00:00:00' });
  const report = sleepAiMemories();
  assert.equal(report.decayed, 1);
  assert.ok(Math.abs(db.prepare('SELECT importance FROM ai_memories').get().importance - 0.72) < 1e-9);
});

test('显式零重要度的记忆保留零分，不提升为默认重要度', () => {
  seed({ key: 'zero', importance: 0, value: '零分' });
  seed({ key: 'small', importance: 0.1, value: '低分' });
  const ranked = listAiMemories();
  assert.equal(ranked[0].memoryKey, 'small');
  assert.equal(ranked.find(row => row.memoryKey === 'zero').score, 0);
});

test('SQLite UTC 新鲜度在 UTC、上海和纽约时区一致', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-29T00:00:00Z') });
  const oldTimezone = process.env.TZ;
  t.after(() => { if (oldTimezone === undefined) delete process.env.TZ; else process.env.TZ = oldTimezone; });
  seed({ key: 'half-life', importance: 1, updated: '2026-11-26 00:00:00' });
  for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    process.env.TZ = zone;
    assert.equal(listAiMemories()[0].score, 0.85, zone);
  }
});

test('保存返回本次精确键名的记录，不返回排序更高的相似键', () => {
  seed({ key: '部署偏好-附加', value: '另一条', importance: 1 });
  const saved = upsertAiMemory('部署偏好', '本次保存', 'conversation', 'high', { importance: 0.2 });
  assert.equal(saved.memoryKey, '部署偏好');
  assert.equal(saved.value, '本次保存');
  assert.equal(db.prepare('SELECT value FROM ai_memories WHERE id=?').get(saved.id).value, '本次保存');
});

test('去重删除失败时恢复召回计数和全部时间字段', (t) => {
  seed({ key: 'keeper', importance: 0.9, count: 1 });
  seed({ key: 'drop', importance: 0.2, count: 5, recalled: '2026-11-28 12:00:00' });
  const before = db.prepare('SELECT * FROM ai_memories ORDER BY id').all();
  db.exec("CREATE TEMP TRIGGER reject_memory_delete BEFORE DELETE ON ai_memories BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END;");
  t.after(() => db.exec('DROP TRIGGER reject_memory_delete'));
  assert.throws(() => sleepAiMemories(), /fixture delete failure/);
  assert.deepEqual(db.prepare('SELECT * FROM ai_memories ORDER BY id').all(), before);
});

test('Agent 保存和检索工具保留精确键、零权重与召回计数', async () => {
  const tools = new Map();
  registerMemoryTools({ registerTool(name, definition) { tools.set(name, definition); return this; } });
  seed({ key: '项目策略-旧版本', value: '旧事实', importance: 1 });
  const result = await tools.get('memory.save').execute({ key: '项目策略', value: '明确保留的低优先级事实', importance: 0, veracity: 'stated' });
  assert.equal(result.saved, true);
  assert.equal(result.memory.memoryKey, '项目策略');
  assert.equal(result.memory.score, 0);
  const found = await tools.get('memory.search').execute({ query: '明确保留', limit: 1 });
  assert.equal(found.memories.length, 1);
  assert.equal(found.memories[0].id, result.memory.id);
  assert.equal(db.prepare('SELECT recall_count FROM ai_memories WHERE id=?').get(result.memory.id).recall_count, 1);
  assert.equal(tools.get('memory.sleep').confirmationRequired, true);
});

test('近期更新的旧事实不因旧召回时间被衰减或因创建时间被清理', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-29T00:00:00Z') });
  seed({ key: 'recent-update', value: '近期确认的事实', importance: 0.8, created: '2026-01-01 00:00:00', updated: '2026-11-28 00:00:00', recalled: '2026-01-02 00:00:00', count: 1 });
  seed({ key: 'recent-low', value: '近期低优先级事实', importance: 0.05, created: '2026-01-01 00:00:00', updated: '2026-11-28 00:00:00' });
  const report = sleepAiMemories();
  assert.equal(db.prepare("SELECT importance FROM ai_memories WHERE memory_key='recent-update'").get().importance, 0.8);
  assert.ok(db.prepare("SELECT id FROM ai_memories WHERE memory_key='recent-low'").get());
  assert.deepEqual(report, { deduped: 0, decayed: 0, pruned: 0 });
});
