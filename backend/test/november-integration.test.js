import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/lib/db.js';
import { setHostGroup, listHosts, upsertHost, deleteHost, getHost } from '../src/services/docker-hosts.js';
import { previewRetentionPolicy } from '../src/services/metrics.js';
import { recordEvent, queryEvents } from '../src/services/event-center.js';
import { MUTATION_TOOLS } from '../src/lib/mutation-tools.js';

test('节点分组在服务端保存且不重写连接或凭据', () => {
  const host = upsertHost({ name: '分组测试', type: 'tcp', host: '127.0.0.1', port: 2375 });
  try {
    const original = getHost(host.id);
    setHostGroup(host.id, 'staging');
    setHostGroup('local', 'edge');
    assert.equal(listHosts().find(h => h.id === host.id).group, 'staging');
    assert.equal(listHosts().find(h => h.id === 'local').group, 'edge');
    assert.deepEqual(getHost(host.id), original);
    assert.throws(() => setHostGroup(host.id, 'unknown'), /分组无效/);
    assert.throws(() => setHostGroup('missing', 'edge'), /不存在/);
  } finally { deleteHost(host.id); setHostGroup('local', 'production'); }
});
test('保留策略预览列出准确影响但不修改指标', () => {
  const now = Date.now(); const day = 86400000;
  const insert = db.prepare("INSERT INTO container_metrics(host_id, container_id, metric_type, value, unit, timestamp) VALUES('local', 'preview', 'cpu', 10, '%', ?)");
  for (const days of [1, 8, 20, 31]) insert.run(now - days * day);
  assert.deepEqual(previewRetentionPolicy(now), { deleted30d: 1, compactedRows: 2, rawDays: 7, totalDays: 30, aggregateSeconds: 300 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM container_metrics WHERE container_id='preview'").get().n, 4);
});
test('任务来源事件持久化并保留可下钻目标', () => {
  for (const source of ['cron', 'gitops', 'backup', 'inspection']) {
    const record = recordEvent({ eventType: source, source, title: source + ' 完成', status: 'resolved', payload: { to: '/events?tab=operations', sourceId: 'test-' + source } });
    const saved = queryEvents({ eventType: source }).find(e => e.id === record.id);
    assert.equal(saved.payload.sourceId, 'test-' + source);
    assert.equal(saved.payload.to, '/events?tab=operations');
  }
  assert.ok(MUTATION_TOOLS.has('compose.restart'));
  assert.ok(MUTATION_TOOLS.has('environment.set'));
  assert.ok(!MUTATION_TOOLS.has('compose.ps'));
});
