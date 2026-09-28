import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-ai-sessions-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { addAiMessage, getAiHistory, listAiSessions, clearAiSession, clearAiSessions, clearAiHistory, truncateAiHistoryFrom, createAgentPlan, getAgentPlan } = await import('../src/lib/db.js');

test('ai: 会话消息按 sessionId 隔离', () => {
  clearAiHistory();
  addAiMessage('user', '会话A的第一条', null, 1);
  addAiMessage('assistant', '会话A的回答', null, 1);
  addAiMessage('user', '会话B的第一条', null, 2);
  const sessionA = getAiHistory(50, 1);
  const sessionB = getAiHistory(50, 2);
  assert.equal(sessionA.length, 2);
  assert.equal(sessionB.length, 1);
  assert.ok(sessionA.every((message) => message.sessionId === 1));
  assert.ok(sessionB.every((message) => message.sessionId === 2));
});

test('ai: 历史支持按 beforeId 加载更早消息', () => {
  clearAiHistory();
  const first = addAiMessage('user', '第一条', null, 901);
  const second = addAiMessage('assistant', '第二条', null, 901);
  const third = addAiMessage('user', '第三条', null, 901);
  const older = getAiHistory(50, 901, third);
  assert.deepEqual(older.map((message) => message.id), [first, second]);
  assert.equal(getAiHistory(50, 901, first).length, 0);
});

test('ai: 会话列表聚合标题与消息数', () => {
  clearAiHistory();
  addAiMessage('user', '帮我排查容器启动失败', null, 10);
  addAiMessage('assistant', '检查日志', null, 10);
  addAiMessage('user', '另一个会话', null, 20);
  const sessions = listAiSessions(10);
  assert.ok(sessions.length >= 2);
  const session = sessions.find((item) => item.sessionId === 10);
  assert.ok(session);
  assert.equal(session.messageCount, 2);
  assert.ok(session.title.includes('排查'));
});

test('ai: 删除单个会话不影响其它', () => {
  clearAiHistory();
  addAiMessage('user', 'A1', null, 100);
  addAiMessage('user', 'B1', null, 200);
  clearAiSession(100);
  assert.equal(getAiHistory(50, 100).length, 0);
  assert.equal(getAiHistory(50, 200).length, 1);
});

test('ai: 批量删除会话是事务操作且不影响其它会话', () => {
  clearAiHistory();
  addAiMessage('user', 'A1', null, 401);
  addAiMessage('assistant', 'A2', null, 401);
  addAiMessage('user', 'B1', null, 402);
  addAiMessage('user', 'C1', null, 403);
  assert.equal(clearAiSessions([401, 402, 401, 'invalid']), 2);
  assert.equal(getAiHistory(50, 401).length, 0);
  assert.equal(getAiHistory(50, 402).length, 0);
  assert.equal(getAiHistory(50, 403).length, 1);
});

test('ai: 未指定会话默认进入全局历史', () => {
  clearAiHistory();
  addAiMessage('user', '全局消息');
  const history = getAiHistory(50);
  assert.equal(history.length, 1);
  assert.equal(history[0].sessionId, 0);
});

test('ai: Agent 会话与普通 AI 会话按 kind 隔离', () => {
  clearAiHistory();
  addAiMessage('user', '普通对话', null, 301);
  addAiMessage('user', 'Agent 对话', { agent: true }, 302);
  assert.equal(listAiSessions(20, 'agent').some((item) => item.sessionId === 302), true);
  assert.equal(listAiSessions(20, 'agent').some((item) => item.sessionId === 301), false);
});

test('ai: 截断某条消息起的历史(编辑并重发)', () => {
  clearAiHistory();
  const first = addAiMessage('user', '第一轮提问', null, 77);
  const firstAnswer = addAiMessage('assistant', '第一轮回答', null, 77);
  const secondAsk = addAiMessage('user', '第二轮提问', null, 77);
  const secondAnswer = addAiMessage('assistant', '第二轮回答', null, 77);
  assert.equal(getAiHistory(50, 77).length, 4);
  // 消息 id 必须严格递增,否则"按 id 截断"定位不到正确区间
  assert.ok(first < firstAnswer && firstAnswer < secondAsk && secondAsk < secondAnswer);

  const deleted = truncateAiHistoryFrom(77, secondAsk);
  assert.equal(deleted, 2, '应删除第二条提问及其后的回答');
  const rest = getAiHistory(50, 77);
  assert.equal(rest.length, 2);
  assert.equal(rest[0].content, '第一轮提问');
  assert.equal(rest[1].content, '第一轮回答');

  // 截断只作用于目标会话:阈值高于其它会话的消息 id 时不应误删
  const otherId = addAiMessage('user', '别的会话', null, 78);
  assert.equal(truncateAiHistoryFrom(78, otherId + 1), 0, '阈值高于该会话全部消息 id 时不应删任何东西');
  assert.equal(getAiHistory(50, 78).length, 1);
  // 非法入参安全返回 0,不抛错、不误删
  assert.equal(truncateAiHistoryFrom(0, 5), 0);
  assert.equal(truncateAiHistoryFrom(77, -1), 0);
  assert.equal(getAiHistory(50, 77).length, 2, '非法调用后原会话数据保持不变');
});

test('ai: 非数字 sessionId 归一到匿名会话,不撞 NOT NULL 约束', () => {
  clearAiHistory();
  // 路由 schema(numericId)允许字符串 id:Number('smoke-1') 是 NaN,
  // 此前直接透传会让 better-sqlite3 绑成 NULL,抛 "NOT NULL constraint failed"。
  const id = addAiMessage('user', '匿名会话消息', null, 'smoke-1');
  assert.ok(Number.isSafeInteger(id) && id > 0);
  const anonymous = getAiHistory(50, 0);
  assert.equal(anonymous.length, 1);
  assert.equal(anonymous[0].content, '匿名会话消息');

  // 会话列表里不应凭空多出一个 NaN 会话
  const sessions = listAiSessions(10);
  assert.ok(sessions.every((session) => Number.isSafeInteger(session.sessionId)));

  // 执行计划走同一条归一(否则落库直接抛 NOT NULL)
  const planId = createAgentPlan('smoke-1', '非数字会话的执行计划', {}, null, null);
  assert.equal(getAgentPlan(planId).session_id, 0);
});
