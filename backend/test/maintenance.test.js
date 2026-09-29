import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-maintenance-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const database = await import('../src/lib/db.js');
const db = database.default;
const { getAiUsageSummary, recordAiUsage } = database;
const {
  pruneComposeBackups,
  runDataMaintenance,
  pruneDataHistory,
} = await import('../src/services/maintenance.js');

test('pruneOperationHistory 删除超过保留天数的操作记录', () => {
  db.prepare('DELETE FROM operation_history').run();
  db.prepare("INSERT INTO operation_history(project_id, project_name, action, status, created_at) VALUES('p1','P1','up','success', datetime('now','-5 days'))").run();
  db.prepare("INSERT INTO operation_history(project_id, project_name, action, status, created_at) VALUES('p2','P2','down','success', datetime('now','-45 days'))").run();

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM operation_history').get().c, 2);
  const pruned = db.prepare("DELETE FROM operation_history WHERE julianday(created_at) < julianday('now','-30 days')").run();
  assert.equal(pruned.changes, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM operation_history').get().c, 1);
});

test('pruneAiHistory 清理超过保留天数的 AI 历史', () => {
  db.prepare('DELETE FROM ai_history').run();
  db.prepare("INSERT INTO ai_history(role, content, created_at) VALUES('user','old', datetime('now','-45 days'))").run();
  db.prepare("INSERT INTO ai_history(role, content, created_at) VALUES('user','new', datetime('now'))").run();

  const pruned = pruneDataHistory({ aiHistoryDays: 30 });
  assert.equal(pruned.aiHistoryDeleted, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ai_history').get().c, 1);
});

test('ai_usage 记录规范化 token 并纳入过期清理', () => {
  db.prepare('DELETE FROM ai_usage').run();
  const id = recordAiUsage({
    sessionId: 'session-1',
    model: ' test-model ',
    usage: { prompt_tokens: 12.9, completion_tokens: 7, total_tokens: null },
  });
  assert.ok(Number.isInteger(id));
  const row = db.prepare('SELECT session_id, model, prompt_tokens, completion_tokens, total_tokens FROM ai_usage WHERE id = ?').get(id);
  assert.deepEqual(row, { session_id: 0, model: 'test-model', prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  assert.equal(recordAiUsage({ usage: { prompt_tokens: 'invalid' } }), null);

  db.prepare("UPDATE ai_usage SET created_at = datetime('now', '-45 days')").run();
  const pruned = pruneDataHistory({ aiHistoryDays: 30 });
  assert.equal(pruned.aiUsageDeleted, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ai_usage').get().c, 0);
});

test('ai_usage 汇总按模型与自然日聚合,不暴露会话标识', () => {
  db.prepare('DELETE FROM ai_usage').run();
  recordAiUsage({ sessionId: 101, model: 'alpha', usage: { prompt_tokens: 10, completion_tokens: 5 } });
  recordAiUsage({ sessionId: 101, model: 'alpha', usage: { prompt_tokens: 4, completion_tokens: 1 } });
  recordAiUsage({ sessionId: 202, model: 'beta', usage: { total_tokens: 20 } });
  const oldId = recordAiUsage({ sessionId: 303, model: 'old-model', usage: { total_tokens: 99 } });
  db.prepare("UPDATE ai_usage SET created_at = datetime('now', '-45 days') WHERE id = ?").run(oldId);

  const summary = getAiUsageSummary(30);
  assert.deepEqual(summary.totals, {
    calls: 3,
    sessions: 2,
    prompt_tokens: 14,
    completion_tokens: 6,
    total_tokens: 40,
  });
  assert.deepEqual(summary.byModel.map(({ model, calls, total_tokens }) => ({ model, calls, total_tokens })), [
    { model: 'alpha', calls: 2, total_tokens: 20 },
    { model: 'beta', calls: 1, total_tokens: 20 },
  ]);
  assert.equal(summary.daily.length, 1);
  assert.equal(summary.daily[0].total_tokens, 40);
  assert.equal('session_id' in summary, false);
});

test('pruneComposeBackups 每个项目只保留最新 N 份', () => {
  db.prepare('DELETE FROM compose_backups').run();
  const insertBackup = (projectId, filePath) => db.prepare(
    "INSERT INTO compose_backups(project_id, file_path, content) VALUES(?, ?, 'x')"
  ).run(projectId, filePath);

  insertBackup('pa', 'a1'); insertBackup('pa', 'a2'); insertBackup('pa', 'a3');
  insertBackup('pb', 'b1');

  const pruned = pruneComposeBackups(2);
  assert.equal(pruned.changes, 1); // pa 留 2 删 1,pb 留 1 删 0
  const remaining = db.prepare('SELECT project_id, file_path FROM compose_backups ORDER BY file_path').all();
  assert.deepEqual(remaining.map((r) => r.file_path), ['a2', 'a3', 'b1']);
});

test('runDataMaintenance 幂等且返回各表删除计数', () => {
  db.prepare('DELETE FROM ai_history').run();
  db.prepare('DELETE FROM operation_history').run();
  db.prepare("INSERT INTO ai_history(role, content, created_at) VALUES('user','old', datetime('now','-40 days'))").run();
  db.prepare("INSERT INTO operation_history(project_id, action, status, created_at) VALUES('p9','up','success', datetime('now','-60 days'))").run();

  const result = runDataMaintenance();
  assert.equal(typeof result.agentPlansDeleted, 'number');
  assert.equal(typeof result.aiUsageDeleted, 'number');
  assert.equal(typeof result.operationHistoryDeleted, 'number');
  assert.equal(result.aiHistoryDeleted >= 1, true);
  assert.equal(typeof result.composeBackupsDeleted, 'number');

  const second = runDataMaintenance();
  assert.equal(typeof second.agentPlansDeleted, 'number');
});

test('pruneAgentPlans 通过 CASCADE 联删子表 executions', () => {
  db.prepare('DELETE FROM agent_plans').run();
  db.prepare("INSERT INTO agent_plans(id, session_id, user_message, plan_json, status, created_at) VALUES('plan-old',0,'m','{}','completed', datetime('now','-40 days'))").run();
  db.prepare("INSERT INTO agent_executions(id, plan_id, tool_name, status, created_at) VALUES('e1','plan-old','compose.up','success', datetime('now','-40 days'))").run();

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM agent_plans').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get().c, 1);

  const pruned = db.prepare("DELETE FROM agent_plans WHERE julianday('now') - julianday(created_at) > 30").run();
  assert.equal(pruned.changes, 1);
  // CASCADE:executions 应被连带删除
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM agent_executions').get().c, 0);
});
