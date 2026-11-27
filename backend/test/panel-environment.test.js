import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelMetricsReader, parsePanelNetwork } from '../src/services/panel-environment.js';

const routes = 'Iface Destination\neth0 00000000';
const dev = (rx, tx, name = 'eth0') => `${name}: ${rx} 1 2 3 4 5 6 7 ${tx} 9 10 11 12 13 14 15`;
function fixture(options = {}) {
  const state = { time: 1000, user: 10, idle: 90, irq: 0, rx: 100, tx: 200, interface: 'eth0', calls: 0 };
  const system = { cpus: () => { state.calls++; return [{ times: { user: state.user, nice: 0, sys: 0, idle: state.idle, irq: state.irq } }]; }, loadavg: () => [0, 1, 2],
    totalmem: () => 1000, freemem: () => 300, uptime: () => 100, hostname: () => 'panel-fixture', type: () => 'Linux', release: () => 'fixture' };
  const read = async path => path.endsWith('/route') ? `Iface Destination\n${state.interface} 00000000` : dev(state.rx, state.tx, state.interface);
  const reader = createPanelMetricsReader({ system, read, now: () => state.time, cacheMs: 0, timeoutMs: 20,
    fileStat: async () => ({ dev: 1 }), diskStat: async () => ({ blocks: 100, bsize: 1024, bfree: 10, bavail: 5 }), ...options });
  return { state, reader };
}

test('网络使用真实RX/TX列并只计默认路由接口，避免Docker桥重复计算', () => {
  const parsed = parsePanelNetwork([dev(100, 200), dev(900, 800, 'docker0'), dev(700, 600, 'veth01')].join('\n'), routes);
  assert.equal(parsed.rxTotal, 100); assert.equal(parsed.txTotal, 200);
  assert.deepEqual(parsed.interfaces.map(item => item.name), ['eth0']); assert.equal(parsed.scope, 'default-route');
  assert.equal(parsePanelNetwork('invalid', routes), null);
});

test('首次CPU/网络保持未知，后续按真实差分采样，IRQ计入CPU总量', async () => {
  const { state, reader } = fixture();
  const first = await reader();
  assert.equal(first.host.scope, 'panel-environment'); assert.equal(first.host.cpu.percent, null);
  assert.equal(first.network.rx, null); assert.equal(first.network.tx, null); assert.equal(first.network.status, 'pending');
  assert.equal(first.host.memory.used, 700);
  state.time += 2000; state.user += 10; state.idle += 10; state.irq += 10; state.rx += 100; state.tx += 200;
  const next = await reader();
  assert.equal(next.host.cpu.percent, 66.7); assert.equal(next.network.rx, 50); assert.equal(next.network.tx, 100);
  assert.equal(next.disk.length, 1); assert.equal(next.disk[0].free, 5120); assert.equal(next.disk[0].used, 92160);
});

test('计数器重置、路由接口变化不制造负数、零值或突增速率', async () => {
  const { state, reader } = fixture(); await reader();
  state.time += 1000; state.rx = 1; state.tx = 2; state.user = 0; state.idle = 1;
  const reset = await reader(); assert.equal(reset.network.rx, null); assert.equal(reset.network.tx, null); assert.equal(reset.host.cpu.percent, null);
  state.time += 1000; state.interface = 'eth1'; state.rx = 10000; state.tx = 20000;
  const changed = await reader(); assert.equal(changed.network.rx, null); assert.equal(changed.network.status, 'pending');
});

test('并发读共享单次采样；短期缓存避免每个浏览器重复磁盘读', async () => {
  let release, reads = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const { state, reader } = fixture({ cacheMs: 1000, timeoutMs: 500, read: async path => { reads++; await wait; return path.endsWith('/route') ? routes : dev(0, 0); } });
  const requests = Array.from({ length: 20 }, () => reader());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 2); assert.equal(state.calls, 1);
  release(); const results = await Promise.all(requests); assert.ok(results.every(item => item === results[0]));
  await reader(); assert.equal(reads, 2); assert.equal(state.calls, 1);
});

test('文件系统不响应或proc不可读有界返回，缺失不伪造零用量', async () => {
  const { reader } = fixture({ read: async () => { throw new Error('permission'); }, diskStat: () => new Promise(() => {}) });
  const start = Date.now(), data = await reader();
  assert.ok(Date.now() - start < 1000); assert.equal(data.diskStatus, 'unavailable'); assert.deepEqual(data.disk, []);
  assert.equal(data.network.status, 'unavailable'); assert.equal(data.network.rx, null); assert.equal(data.network.tx, null);
  assert.equal(data.host.memory.used, 700);
});

test('单个网络接口重置即使被其它接口增长掩盖也不能算成有效速率', async () => {
  let second = false;
  const { state, reader } = fixture({ read: async path => path.endsWith('/route') ? 'Iface Destination\neth0 00000000\neth1 00000000'
    : [dev(second ? 1 : 100, 100), dev(second ? 1000 : 100, 100, 'eth1')].join('\n') });
  await reader(); second = true; state.time += 1000;
  const data = await reader(); assert.equal(data.network.rx, null); assert.equal(data.network.tx, 0);
});
