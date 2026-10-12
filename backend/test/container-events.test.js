import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as settle } from 'node:timers/promises';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-container-events-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const { subscribeContainerEvents, startStateRecorder } = await import('../src/services/container-events.js');
const { getActivityDocker, setActiveHost, upsertHost } = await import('../src/services/docker-hosts.js');
const { scanProjects, invalidateScanCache } = await import('../src/services/scanner.js');
const { setProjectPreference, listContainerStateEvents } = await import('../src/lib/db.js');
const docker = getActivityDocker();
const row = { Id: 'test-container', Names: ['/测试'], State: 'running', Labels: { 'com.docker.compose.project': 'events-audit', 'com.docker.compose.project.working_dir': tempDir } };
const event = { Type: 'container', Action: 'start', Actor: { ID: row.Id, Attributes: { name: '测试容器', ...row.Labels } } };
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('Docker Events 跨 chunk/UTF-8 JSON 保留完整事件,坏行不吞后续事件', async (t) => {
  t.mock.method(docker, 'listContainers', async () => [row]);
  invalidateScanCache();
  const [project] = await scanProjects();
  setProjectPreference(project.id, { managed: true });
  invalidateScanCache();
  await scanProjects();
  const stream = new PassThrough();
  t.mock.method(docker, 'getEvents', async () => stream);
  const events = [];
  const unsubscribe = subscribeContainerEvents(value => events.push(value));
  t.after(unsubscribe);
  await settle();
  for (const byte of Buffer.from(JSON.stringify(event) + '\n')) stream.write(Buffer.from([byte]));
  stream.write('not-json\n' + JSON.stringify({ ...event, Action: 'die' }) + '\n');
  await settle();
  assert.deepEqual(events.map(value => value.action), ['start', 'die']);
  assert.equal(events[0].containerName, '测试容器');
});

test('状态记录器把 die 退出码落库,扫描快照缺失的容器靠事件标签补项目', async (t) => {
  t.mock.method(docker, 'listContainers', async () => [row]);
  invalidateScanCache();
  const [project] = await scanProjects();
  setProjectPreference(project.id, { managed: true });
  invalidateScanCache();
  await scanProjects();

  const stream = new PassThrough();
  t.mock.method(docker, 'getEvents', async () => stream);
  const stopRecorder = startStateRecorder();
  const unsubscribe = subscribeContainerEvents(() => {});
  t.after(() => { unsubscribe(); stopRecorder(); });
  await settle();

  const base = Math.floor(Date.now() / 1000);
  // Docker Events API 的 attributes 全是字符串,exitCode/execDuration 也一样(实测 daemon 29.x)
  const dieEvent = {
    ...event,
    Action: 'die',
    time: base + 1,
    Actor: { ...event.Actor, Attributes: { ...event.Actor.Attributes, exitCode: '137', execDuration: '42' } },
  };
  // 该容器不在 listContainers 快照里(销毁后已消失),只能靠事件自带的 compose 标签还原项目
  const destroyEvent = {
    Type: 'container',
    Action: 'destroy',
    time: base + 2,
    Actor: { ID: 'ghost-container', Attributes: { name: '已销毁容器', ...row.Labels } },
  };
  stream.write(`${JSON.stringify(dieEvent)}\n${JSON.stringify(destroyEvent)}\n`);

  // handleDockerEvent 走串行队列且内部 await scanProjects(),轮询等待比固定 settle 次数稳
  let rows = [];
  for (let i = 0; i < 40 && rows.length < 2; i += 1) {
    await settle();
    rows = listContainerStateEvents({ projectId: project.id, limit: 100 });
  }
  assert.equal(rows.length, 2);
  // 按时间倒序:destroy(base+2) 在 die(base+1) 之前
  assert.deepEqual(rows.map((item) => item.action), ['destroy', 'die']);

  const destroyed = rows.find((item) => item.containerId === 'ghost-container');
  assert.equal(destroyed.projectId, project.id);
  assert.equal(destroyed.projectName, project.projectName);
  assert.equal(destroyed.containerName, '已销毁容器');
  // 非 die 事件不得带退出码
  assert.equal(destroyed.exitCode, null);

  const die = rows.find((item) => item.containerId === row.Id);
  assert.equal(die.containerName, '测试容器');
  // 字符串退出码要落成整数,列表页才能按 137 判定异常退出
  assert.equal(die.exitCode, 137);
  assert.equal(die.execDuration, 42);

  // 记录器必须真正退订:否则它会长期留在订阅者集合里,事件流再也停不下来
  unsubscribe();
  stopRecorder();
  assert.equal(stream.destroyed, true);
});

test('getEvents 等待期间退订,不会留下无订阅者的流', async (t) => {
  let resolve;
  t.mock.method(docker, 'getEvents', () => new Promise(r => { resolve = r; }));
  const unsubscribe = subscribeContainerEvents(() => {});
  unsubscribe();
  const stream = new PassThrough();
  t.after(() => stream.destroy());
  resolve(stream);
  await settle();
  assert.equal(stream.destroyed, true);
});

test('Docker 首次订阅失败后自动重试,退订后停止重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = new PassThrough();
  let calls = 0;
  t.mock.method(docker, 'getEvents', async () => { if (++calls === 1) throw new Error('临时断线'); return stream; });
  const unsubscribe = subscribeContainerEvents(() => {});
  t.after(unsubscribe);
  await settle();
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(calls, 2);
  unsubscribe();
  assert.equal(stream.destroyed, true);
  t.mock.timers.tick(6000);
  await settle();
  assert.equal(calls, 2);
});

test('已有订阅在切换节点时立即迁移,不等待新的 WebSocket 连接', async t => {
  const host = upsertHost({ name: '测试节点', type: 'tcp', host: '127.0.0.1', port: 1 });
  setActiveHost(host.id);
  const remote = getActivityDocker();
  setActiveHost('local');
  const localStream = new PassThrough();
  const remoteStream = new PassThrough();
  t.mock.method(docker, 'getEvents', async () => localStream);
  const remoteEvents = t.mock.method(remote, 'getEvents', async () => remoteStream);
  const unsubscribe = subscribeContainerEvents(() => {});
  t.after(() => { unsubscribe(); setActiveHost('local'); });
  await settle();
  setActiveHost(host.id);
  await settle();
  assert.equal(localStream.destroyed, true);
  assert.equal(remoteEvents.mock.callCount(), 1);
  unsubscribe();
  assert.equal(remoteStream.destroyed, true);
});
