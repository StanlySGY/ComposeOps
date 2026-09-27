import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'composeops-agent-metrics-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { configureAlert, parseContainerStats } = await import('../src/services/agent-metrics.js');
const { parseContainerMetrics } = await import('../src/services/metrics-collector.js');

test.after(() => rmSync(tempDir, { recursive: true, force: true }));

test('agent-metrics: Docker stats 正常计算 CPU、内存、网络和磁盘数值', () => {
  const parsedCpu = parseContainerStats({
    cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 10000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 8000 },
  }, 'cpu');
  assert.equal(parsedCpu.current, 100);
  assert.equal(parsedCpu.numeric, 100);

  const parsedMemory = parseContainerStats({ memory_stats: { usage: 100, limit: 200, stats: { cache: 20 } } }, 'memory');
  assert.equal(parsedMemory.current, 40);
  assert.equal(parsedMemory.usedBytes, 80);

  const parsedNetwork = parseContainerStats({ networks: { eth0: { rx_bytes: 2048, tx_bytes: 1024 } } }, 'network');
  assert.equal(parsedNetwork.numeric, 2048);
  assert.equal(parsedNetwork.rxBytes, 2048);
  assert.match(parsedNetwork.current.rx, /KB/);

  const parsedDisk = parseContainerStats({
    blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 512 }, { op: 'read', value: 256 }, { op: 'Write', value: 128 }] },
  }, 'disk');
  assert.equal(parsedDisk.numeric, 768);
  assert.equal(parsedDisk.readBytes, 768);
  assert.equal(parsedDisk.writeBytes, 128);
});

test('agent-metrics: 缺失或无效 Docker stats 返回有限零值', () => {
  for (const metric of ['cpu', 'memory', 'network', 'disk']) {
    const parsed = parseContainerStats({}, metric);
    assert.equal(Number.isFinite(parsed.numeric), true, metric);
    assert.equal(parsed.numeric, 0, metric);
  }
});

test('metrics-collector: 缺失、大小写差异和无效字段不会写出 NaN', () => {
  const metrics = parseContainerMetrics('container-1', {
    cpu_stats: { cpu_usage: {}, system_cpu_usage: 100, online_cpus: 2 },
    precpu_stats: { cpu_usage: {}, system_cpu_usage: 0 },
    memory_stats: { usage: 100, limit: 0 },
    networks: {
      eth0: { rx_bytes: 'not-a-number', tx_bytes: -1 },
      eth1: null,
    },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'Read', value: 512 },
        { op: 'read', value: 256 },
        { op: 'Write', value: 'invalid' },
      ],
    },
  }, 123);

  assert.equal(metrics.some((metric) => !Number.isFinite(metric.value)), false);
  assert.equal(metrics.find((metric) => metric.metric_type === 'network_rx').value, 0);
  assert.equal(metrics.find((metric) => metric.metric_type === 'network_tx').value, 0);
  assert.equal(metrics.find((metric) => metric.metric_type === 'disk_read').value, 768);
  assert.equal(metrics.find((metric) => metric.metric_type === 'disk_write').value, 0);
  assert.equal(metrics.some((metric) => metric.metric_type === 'memory'), false);
});

test('agent-metrics: 告警阈值、持续时间和动作在外部依赖前完成校验', async () => {
  const base = { container: 'container-1', metric: 'cpu', duration: '5m', action: 'notify' };
  await assert.rejects(
    () => configureAlert({ ...base, threshold: -1 }),
    (error) => error.statusCode === 400 && /0 到 100/.test(error.message)
  );
  await assert.rejects(
    () => configureAlert({ ...base, threshold: 101 }),
    (error) => error.statusCode === 400 && /0 到 100/.test(error.message)
  );
  await assert.rejects(
    () => configureAlert({ ...base, threshold: 50, duration: '0m' }),
    (error) => error.statusCode === 400 && /持续时间/.test(error.message)
  );
  await assert.rejects(
    () => configureAlert({ ...base, threshold: 50, duration: '5m', action: 'delete' }),
    (error) => error.statusCode === 400 && /告警动作/.test(error.message)
  );
  await assert.rejects(
    () => configureAlert({ ...base, metric: 'network', threshold: -1 }),
    (error) => error.statusCode === 400 && /不能小于 0/.test(error.message)
  );
});
