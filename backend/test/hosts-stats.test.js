import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-hosts-test-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { parseContainerStat } = await import('../src/services/stats.js');
const {
  listHosts,
  getHost,
  setActiveHost,
  upsertHost,
  deleteHost,
  probeHost,
  composeEnv,
  getActiveHostId,
} = await import('../src/services/docker-hosts.js');

test('stats: parseContainerStat 计算 CPU 与内存百分比', () => {
  const raw = {
    cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 10000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 8000 },
    memory_stats: { usage: 104857600, limit: 1073741824 },
    networks: { eth0: { rx_bytes: 100, tx_bytes: 200 } },
    blkio_stats: { io_service_bytes_recursive: [
      { op: 'Read', value: 512 },
      { op: 'Write', value: 1024 },
    ] },
  };
  const stat = parseContainerStat(raw);
  assert.equal(stat.cpuPercent, 100); // (1000/2000)*2*100
  assert.equal(stat.memUsageMB, 100);
  assert.equal(stat.memLimitMB, 1024);
  assert.equal(stat.memPercent, 9.77);
  assert.deepEqual(stat.netIO, { rxBytes: 100, txBytes: 200 });
  assert.deepEqual(stat.blockIO, { readBytes: 512, writeBytes: 1024 });
});

test('stats: parseContainerStat 缺省字段返回 0', () => {
  const stat = parseContainerStat({});
  assert.equal(stat.cpuPercent, 0);
  assert.equal(stat.memUsageMB, 0);
  assert.equal(stat.memPercent, 0);
});

test('hosts: 默认本地节点永远存在且不可删除', () => {
  const hosts = listHosts();
  assert.ok(hosts.some((host) => host.id === 'local' && host.type === 'local'));
  assert.throws(() => deleteHost('local'), /不可删除/);
});

test('hosts: upsert 保存/更新节点并隐藏敏感字段', () => {
  const created = upsertHost({ name: 'Worker-1', type: 'ssh', host: '10.0.0.5', port: 22, username: 'root', password: 'hunter2', privateKey: 'KEYDATA' });
  assert.ok(created.id);
  assert.equal(created.password, '••••••••••••');
  assert.equal(created.hasPassword, true);
  assert.equal(created.privateKey, '••••••••••••');
  assert.equal(created.hasPrivateKey, true);

  // 更新时保留旧凭据(传掩码跳过)
  const updated = upsertHost({ id: created.id, name: 'Worker-1 v2', type: 'ssh', host: '10.0.0.5', port: 22, username: 'root', password: '••••••••••••', privateKey: '••••••••••••' });
  assert.equal(updated.name, 'Worker-1 v2');
  const stored = getHost(created.id);
  assert.equal(stored.password, 'hunter2'); // 内部仍保留明文
  assert.equal(stored.privateKey, 'KEYDATA');
});

test('hosts: setActiveHost 切换并持久化,删除后回落本地', () => {
  const node = upsertHost({ name: 'Staging', type: 'tcp', host: '192.168.1.20', port: 2375 });
  setActiveHost(node.id);
  assert.equal(getActiveHostId(), node.id);
  deleteHost(node.id);
  assert.equal(getActiveHostId(), 'local');
});

test('hosts: probeHost 构建临时节点,远程 Compose CLI 明确要求 runner', () => {
  const probe = probeHost({ type: 'ssh', host: '10.1.1.1', port: 2222, username: 'admin', password: 'pw' });
  assert.equal(probe.type, 'ssh');
  assert.equal(probe.host, '10.1.1.1');
  assert.equal(probe.port, 2222);
  assert.throws(() => composeEnv(probe), (error) => error.code === 'REMOTE_COMPOSE_RUNNER_REQUIRED');
  const tcp = probeHost({ type: 'tcp', host: '10.1.1.2' });
  assert.throws(() => composeEnv(tcp), (error) => error.code === 'REMOTE_COMPOSE_RUNNER_REQUIRED');
  assert.throws(() => probeHost({ type: 'tcp', host: '  ' }), /主机地址/);
});
