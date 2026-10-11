import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const alertMonitorSource = readFileSync(path.join(__dirname, '../src/services/alert-monitor.js'), 'utf8');
const healthAlerterSource = readFileSync(path.join(__dirname, '../src/services/health-alerter.js'), 'utf8');

// 退出/OOM/不健康告警曾由 alert-monitor 与 health-alerter 各发一次:
// 事件表靠同 key 静默去重,但外部通知渠道会收到两条推送。此处固化"单一归属"约束。
test('告警归属:alert-monitor 不再发 exit/oom/unhealthy 告警', () => {
  for (const forbidden of [':exit`', ':oom`', ':unhealthy`', '容器已退出', 'enabledAlertEvents']) {
    assert.ok(!alertMonitorSource.includes(forbidden), `alert-monitor 不应包含 ${forbidden}`);
  }
});

test('告警归属:health-alerter 是 exit/oom/unhealthy 的唯一发出方', () => {
  assert.ok(healthAlerterSource.includes('key: `${container.id}:${event}`'), 'health-alerter 应保留统一事件 key');
  assert.ok(healthAlerterSource.includes("const DEFAULT_EVENTS = ['exit', 'oom', 'unhealthy'];"), '默认触发事件清单应保留');
  assert.ok(healthAlerterSource.includes("priority: event === 'crashloop' ? 'warning' : 'danger'"), 'exit/oom/unhealthy 事件应为 danger 级');
});

test('告警归属:alert-monitor 仍负责内存与 Docker 空间告警', () => {
  for (const required of [':memory`', 'docker-storage', '容器内存告警', 'Docker 空间告警']) {
    assert.ok(alertMonitorSource.includes(required), `alert-monitor 应保留 ${required}`);
  }
});
