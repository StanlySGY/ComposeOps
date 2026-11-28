import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const temp = mkdtempSync(path.join(os.tmpdir(), 'composeops-event-window-'));
process.env.DB_PATH = path.join(temp, 'events.db');
const { default: db, addEventRecord, addAlertEvent, updateAlertEvent } = await import('../src/lib/db.js');
const { queryEvents } = await import('../src/services/event-center.js');
after(() => { db.close(); rmSync(temp, { recursive: true, force: true }); });
beforeEach(() => { db.exec('DELETE FROM event_records; DELETE FROM alert_events;'); });
const noise = (count = 510) => db.transaction(() => { for (let i = 0; i < count; i++) addEventRecord({ eventType: 'workflow', title: `noise-${i}`, severity: 'info', status: 'resolved' }); })();

test('稀少类型、级别和状态在截取结果之前过滤', () => {
  const wanted = addEventRecord({ eventType: 'gitops', title: '真实回滚失败', severity: 'danger', status: 'open' });
  noise();
  for (const filters of [{ eventType: 'gitops' }, { severity: 'danger' }, { status: 'open' }, { eventType: 'gitops', severity: 'danger', status: 'open' }]) {
    assert.deepEqual(queryEvents({ ...filters, limit: 1 }).map(item => item.id), [wanted.id]);
  }
});

test('旧告警过滤不会受顶部告警栏的 200 条上限影响', () => {
  const wanted = addAlertEvent({ key: 'rare', title: '旧的严重未处理告警', priority: 'danger' });
  db.transaction(() => { for (let i = 0; i < 220; i++) { const item = addAlertEvent({ key: `noise-${i}`, title: '普通已处理告警', priority: 'info' }); updateAlertEvent(item.id, { read: true, muted: true }); } })();
  const events = queryEvents({ eventType: 'alert', severity: 'danger', status: 'open', limit: 1 });
  assert.deepEqual(events.map(item => item.id), [`legacy-alert-${wanted.id}`]);
});

test('已迁移的旧告警不会因新统一事件超过窗口而重新出现', () => {
  const legacy = addAlertEvent({ key: 'represented', title: '不得复活的旧告警', priority: 'danger' });
  const migrated = addEventRecord({ eventType: 'alert', title: '已处理的迁移告警', severity: 'danger', status: 'resolved', payload: { legacyAlertId: String(legacy.id) } });
  noise();
  assert.deepEqual(queryEvents({ eventType: 'alert', status: 'open' }), []);
  assert.deepEqual(queryEvents({ eventType: 'alert', status: 'resolved' }).map(item => item.id), [migrated.id]);
});

test('按发生时间选择最近结果，同秒按 ID 确定顺序', () => {
  const newest = addEventRecord({ eventType: 'gitops', title: '最近发生' });
  const older = addEventRecord({ eventType: 'gitops', title: '后导入的历史' });
  db.prepare('UPDATE event_records SET created_at=? WHERE id=?').run('2026-11-29 00:00:00', newest.id);
  db.prepare('UPDATE event_records SET created_at=? WHERE id=?').run('2026-11-28 00:00:00', older.id);
  assert.deepEqual(queryEvents({ eventType: 'gitops', limit: 1 }).map(item => item.id), [newest.id]);
  db.prepare('UPDATE event_records SET created_at=?').run('2026-11-29 00:00:00');
  assert.deepEqual(queryEvents({ eventType: 'gitops', limit: 2 }).map(item => item.id), [older.id, newest.id]);
});

test('坏 payload 不影响未迁移告警，空 legacy ID 不会排除全部记录', () => {
  const legacy = addAlertEvent({ key: 'valid', title: '必须保留的告警', priority: 'danger' });
  const row = addEventRecord({ eventType: 'workflow', title: '坏历史' });
  db.prepare('UPDATE event_records SET payload=? WHERE id=?').run('{broken-json', row.id);
  addEventRecord({ eventType: 'workflow', title: '空映射', payload: { legacyAlertId: null } });
  assert.deepEqual(queryEvents({ eventType: 'alert' }).map(item => item.id), [`legacy-alert-${legacy.id}`]);
});

test('统一与旧告警合并后再应用总量上限，读查询不修改失败记录', () => {
  const unified = addEventRecord({ eventType: 'alert', title: '统一失败', severity: 'danger', status: 'open' });
  const legacy = addAlertEvent({ key: 'legacy', title: '旧失败', priority: 'danger' });
  db.prepare('UPDATE event_records SET created_at=? WHERE id=?').run('2026-11-29 00:00:00', unified.id);
  db.prepare('UPDATE alert_events SET created_at=? WHERE id=?').run('2026-11-29 01:00:00', legacy.id);
  const snapshot = JSON.stringify([db.prepare('SELECT * FROM event_records').all(), db.prepare('SELECT * FROM alert_events').all()]);
  assert.equal(queryEvents({ eventType: 'alert', severity: 'danger', limit: 1 })[0].id, `legacy-alert-${legacy.id}`);
  assert.equal(queryEvents({ eventType: 'alert', severity: 'danger', limit: 500 }).length, 2);
  assert.equal(JSON.stringify([db.prepare('SELECT * FROM event_records').all(), db.prepare('SELECT * FROM alert_events').all()]), snapshot);
});

test('旧告警级别和处置状态保持兼容，已迁移映射只出现一次', () => {
  const variants = [
    { priority: 'danger', severity: 'danger', read: false, muted: false, status: 'open' },
    { priority: 'info', severity: 'info', read: true, muted: false, status: 'acknowledged' },
    { priority: 'legacy-other', severity: 'warning', read: true, muted: true, status: 'resolved' },
    { priority: 'warning', severity: 'warning', read: false, muted: true, status: 'open' },
  ];
  for (const [i, variant] of variants.entries()) {
    const item = addAlertEvent({ key: `variant-${i}`, title: variant.status, priority: variant.priority });
    updateAlertEvent(item.id, { read: variant.read, muted: variant.muted });
    assert(queryEvents({ severity: variant.severity, status: variant.status }).some(event => event.id === `legacy-alert-${item.id}`));
  }
  assert.equal(queryEvents({ status: 'closed' }).length, 0);
});

test('筛选 API 返回窗口之外的真实记录且验证上限', async () => {
  const wanted = addEventRecord({ eventType: 'gitops', title: '保留的失败', severity: 'danger', status: 'open' }); noise();
  const { default: Fastify } = await import('fastify');
  const { default: routes } = await import('../src/routes/event-center.js');
  const app = Fastify({ logger: false }); await app.register(routes);
  try {
    const response = await app.inject('/events?eventType=gitops&severity=danger&status=open&limit=1');
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json().events.map(event => event.id), [wanted.id]);
    assert.equal((await app.inject('/events?limit=501')).statusCode, 400);
  } finally { await app.close(); }
});
