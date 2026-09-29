import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-event-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { recordEvent, queryEvents, updateEvent, eventStats } = await import('../src/services/event-center.js');
const { recordAlertEvent, listAlertEvents } = await import('../src/services/events.js');

test('event-center: 记录并查询统一事件', () => {
  const event = recordEvent({ eventType: 'alert', source: 'health', title: '容器退出', detail: 'web', severity: 'danger', assetId: 'container:c1', assetName: 'web' });
  assert.ok(event.id);
  assert.equal(event.eventType, 'alert');
  assert.equal(event.severity, 'danger');
  const events = queryEvents({ eventType: 'alert' });
  assert.ok(events.some((item) => item.id === event.id));
});

test('event-center: 状态流转', () => {
  const event = recordEvent({ eventType: 'deployment', title: '部署完成', severity: 'info' });
  const updated = updateEvent(event.id, { status: 'resolved', read: true });
  assert.equal(updated.status, 'resolved');
  assert.equal(updated.read, 1);
});

test('event-center: 统计聚合', () => {
  recordEvent({ eventType: 'alert', title: 'a', severity: 'danger', status: 'open' });
  recordEvent({ eventType: 'alert', title: 'b', severity: 'warning', status: 'open' });
  recordEvent({ eventType: 'workflow', title: 'c', severity: 'info', status: 'resolved' });
  const stats = eventStats();
  assert.ok(stats.total >= 3);
  assert.ok(stats.byType.alert >= 2);
  assert.ok(stats.byType.workflow >= 1);
  assert.ok(stats.open >= 2);
});

test('event-center: 兼容旧告警存储并支持统一视图处置', () => {
  const legacy = recordAlertEvent({ key: 'legacy-event-center-test', title: '旧告警', detail: '容器退出', priority: 'danger' });
  const event = queryEvents({ eventType: 'alert', limit: 500 }).find((item) => item.id === `legacy-alert-${legacy.id}`);
  assert.ok(event, '旧 alert_events 必须出现在新版事件中心');
  assert.equal(event.severity, 'danger');
  assert.equal(event.status, 'open');

  const updated = updateEvent(event.id, { status: 'resolved' });
  assert.equal(updated.status, 'resolved');
  const stored = listAlertEvents(500).find((item) => item.id === legacy.id);
  assert.equal(stored.read, 1);
  assert.equal(stored.muted, 1);
  assert.equal(queryEvents({ eventType: 'alert', status: 'resolved', limit: 500 }).some((item) => item.id === event.id), true);
});
