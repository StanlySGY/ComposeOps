import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-state-history-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { addContainerStateEvent, listContainerStateEventsWindow, getContainerStateEventBefore } = await import('../src/lib/db.js');
const {
  listStateHistory,
  listStateContainers,
  listStateExits,
  getStateUptime,
  pruneStateHistory,
} = await import('../src/services/state-history.js');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// 固定基准时刻(2023-11):可用率换算只依赖显式传入的窗口,不依赖墙上时钟,断言才能写死。
const BASE = 1_700_000_000;
const WINDOW = { since: BASE, until: BASE + 3000 };
const PROJECT = 'state-history-test';

function seed(containerId, containerName, events, projectId = PROJECT) {
  for (const item of events) {
    addContainerStateEvent({
      containerId,
      containerName,
      projectId,
      projectName: 'state-history',
      action: item.action,
      healthStatus: item.healthStatus || '',
      exitCode: item.exitCode ?? null,
      execDuration: item.execDuration ?? null,
      timestamp: item.at,
    });
  }
}

seed('c-up', 'up', [
  { action: 'start', at: BASE + 1000 },
  { action: 'die', at: BASE + 2000, exitCode: 0, execDuration: 1000 },
  { action: 'start', at: BASE + 2100 },
]);
seed('c-abnormal', 'abnormal', [{ action: 'die', at: BASE + 1500, exitCode: 137, execDuration: 42 }]);
seed('c-unknown', 'unknown', [{ action: 'health_status', at: BASE + 1000, healthStatus: 'healthy' }]);
seed('c-destroyed', 'destroyed', [
  { action: 'start', at: BASE + 1000 },
  { action: 'destroy', at: BASE + 2000 },
]);
// 窗口起点前有一条 stop:起点状态必须从它推断,而不是从窗口内首个事件反推。
seed('c-preceding', 'preceding', [
  { action: 'stop', at: BASE - 500 },
  { action: 'health_status', at: BASE + 1500, healthStatus: 'healthy' },
]);

test('状态历史: 按项目/容器/动作过滤,按时间倒序返回', () => {
  const all = listStateHistory({ projectId: PROJECT, limit: 100 });
  assert.equal(all.length, 9);
  assert.deepEqual(
    all.map((item) => item.timestamp),
    [...all.map((item) => item.timestamp)].sort((a, b) => b - a)
  );
  assert.equal(listStateHistory({ projectId: PROJECT, containerId: 'c-up' }).length, 3);
  // 按时间倒序;同时间戳再按 id 倒序,保证分页稳定
  assert.deepEqual(
    listStateHistory({ projectId: PROJECT, action: 'die', limit: 100 }).map((item) => item.containerId),
    ['c-up', 'c-abnormal']
  );
  assert.equal(listStateHistory({ projectId: 'no-such-project', limit: 100 }).length, 0);
  // limit 非法时回退/夹紧,不会因 0/负数退化成全表扫描
  assert.equal(listStateHistory({ projectId: PROJECT, limit: 2 }).length, 2);
  assert.equal(listStateHistory({ projectId: PROJECT, limit: -5 }).length, 1);
  assert.equal(listStateHistory({ projectId: PROJECT, limit: 0 }).length, 9);
});

test('状态历史: 窗口起点的状态取自窗口前最近一条事件', () => {
  assert.equal(getContainerStateEventBefore('c-preceding', BASE)?.action, 'stop');
  // 边界含等号:窗口起点当刻的事件也算"之前最近一条"
  assert.equal(getContainerStateEventBefore('c-preceding', BASE - 500)?.action, 'stop');
  assert.equal(getContainerStateEventBefore('c-preceding', BASE - 501), null);
  assert.equal(getContainerStateEventBefore('c-up', BASE), null);
});

test('状态历史: 逐容器换算运行/宕机/未知时长,未知不参与可用率', () => {
  const report = getStateUptime({ projectId: PROJECT, ...WINDOW });
  assert.deepEqual(report.window, { since: BASE, until: BASE + 3000, seconds: 3000 });
  assert.equal(report.truncated, false);
  assert.equal(report.summary.containers, 5);

  const byId = new Map(report.containers.map((item) => [item.containerId, item]));

  // 首个事件是 start → 起点反推为宕机:[0,1000) 宕机、[1000,2000) 运行、[2000,2100) 宕机、尾部 900s 运行。
  const up = byId.get('c-up');
  assert.deepEqual(
    { up: up.upSeconds, down: up.downSeconds, unknown: up.unknownSeconds, transitions: up.transitions, exits: up.exits, abnormal: up.abnormalExits },
    { up: 1900, down: 1100, unknown: 0, transitions: 3, exits: 1, abnormal: 0 }
  );
  assert.equal(up.availability, 63.33);
  assert.equal(up.lastAction, 'start');
  assert.equal(up.lastEventAt, BASE + 2100);
  // 最近一条事件是 start,但"上次退出码"必须仍来自那次 die
  assert.equal(up.lastExitCode, 0);
  assert.equal(up.lastExitAt, BASE + 2000);

  // 非零退出码计入 abnormalExits;die 之前必然运行,故窗口前 1500s 记运行、尾部 1500s 记宕机。
  const abnormal = byId.get('c-abnormal');
  assert.deepEqual(
    { up: abnormal.upSeconds, down: abnormal.downSeconds, unknown: abnormal.unknownSeconds, exits: abnormal.exits, abnormal: abnormal.abnormalExits, lastExitCode: abnormal.lastExitCode },
    { up: 1500, down: 1500, unknown: 0, exits: 1, abnormal: 1, lastExitCode: 137 }
  );
  assert.equal(abnormal.availability, 50);

  // health_status 不改变运行态,且无窗口前事件可推断 → 全窗口计入 unknownSeconds,可用率为 null 而非 100%。
  const unknown = byId.get('c-unknown');
  assert.deepEqual(
    { up: unknown.upSeconds, down: unknown.downSeconds, unknown: unknown.unknownSeconds, transitions: unknown.transitions },
    { up: 0, down: 0, unknown: 3000, transitions: 0 }
  );
  assert.equal(unknown.availability, null);

  // destroy 之后状态不可知:窗口尾部不再延续,避免把"已删除"算成宕机时长。
  const destroyed = byId.get('c-destroyed');
  assert.deepEqual(
    { up: destroyed.upSeconds, down: destroyed.downSeconds, unknown: destroyed.unknownSeconds, destroyed: destroyed.destroyed },
    { up: 1000, down: 1000, unknown: 0, destroyed: true }
  );

  // 窗口内只有 health_status,但窗口前有 stop → 起点状态可判定为宕机,不落入 unknown。
  const preceding = byId.get('c-preceding');
  assert.deepEqual(
    { up: preceding.upSeconds, down: preceding.downSeconds, unknown: preceding.unknownSeconds },
    { up: 0, down: 3000, unknown: 0 }
  );
  assert.equal(preceding.availability, 0);

  // 可用率升序置顶最不稳的容器;null(不可判定)排最后。abnormal/destroyed 同为 50,按名称定序保证稳定。
  assert.deepEqual(report.containers.map((item) => item.containerName), ['preceding', 'abnormal', 'destroyed', 'up', 'unknown']);

  assert.deepEqual(report.summary, {
    containers: 5,
    availability: 40,
    upSeconds: 4400,
    downSeconds: 6600,
    unknownSeconds: 3000,
    transitions: 6,
    exits: 2,
    abnormalExits: 1,
  });
});

test('状态历史: 窗口批量查询按容器分组且组内升序', () => {
  const { groups, truncated } = listContainerStateEventsWindow({ projectId: PROJECT, since: BASE, until: BASE + 3000 });
  assert.equal(truncated, false);
  assert.equal(groups.size, 5);
  for (const events of groups.values()) {
    assert.deepEqual(
      events.map((item) => item.timestamp),
      [...events.map((item) => item.timestamp)].sort((a, b) => a - b)
    );
  }
  // 窗口外的 stop 不应混进组内(它只作为起点推断来源)
  assert.deepEqual(groups.get('c-preceding').map((item) => item.action), ['health_status']);
});

test('状态历史: 容器列表返回窗口内每个容器的最近一次转换', () => {
  const containers = listStateContainers({ projectId: PROJECT, since: BASE - 1000, limit: 100 });
  assert.equal(containers.length, 5);
  const web = containers.find((item) => item.containerId === 'c-up');
  assert.equal(web.action, 'start');
  assert.equal(web.timestamp, BASE + 2100);
  assert.equal(containers.some((item) => item.containerId === 'c-preceding' && item.action === 'health_status'), true);
  // since 之前的 stop 不该成为"最近一次转换"
  assert.equal(containers.some((item) => item.action === 'stop'), false);
});

test('状态历史: 退出明细把异常退出排在前面', () => {
  const now = Math.floor(Date.now() / 1000);
  seed('c-exit-clean', 'exit-clean', [{ action: 'die', at: now - 60, exitCode: 0, execDuration: 30 }]);
  seed('c-exit-oom', 'exit-oom', [{ action: 'die', at: now - 600, exitCode: 137, execDuration: 12 }]);
  seed('c-exit-unknown', 'exit-unknown', [{ action: 'die', at: now - 300 }]);
  seed('c-exit-running', 'exit-running', [{ action: 'start', at: now - 30 }]);

  const { exits, total } = listStateExits({ projectId: PROJECT, days: 7, limit: 100 });
  assert.equal(total, 3); // start 事件不进退出明细
  // 异常退出置顶,其余按时间倒序(与是否记录退出码无关)
  assert.deepEqual(exits.map((item) => item.containerId), ['c-exit-oom', 'c-exit-clean', 'c-exit-unknown']);
  assert.equal(exits[0].abnormal, true);
  assert.equal(exits[0].exitCode, 137);
  assert.equal(exits[0].execDuration, 12);
  assert.equal(exits[1].abnormal, false);
  assert.equal(exits[1].exitCode, 0);
  // exitCode 缺失(旧事件未记录)不当作异常,避免把未知当成故障
  assert.equal(exits[2].abnormal, false);
  assert.equal(exits[2].exitCode, null);
  assert.equal(listStateExits({ projectId: PROJECT, days: 7, limit: 2 }).exits.length, 2);
  // 窗口外的历史(BASE 在 2023 年)不进 7 天明细
  assert.equal(exits.some((item) => item.containerId === 'c-abnormal'), false);
});

test('状态历史: 非 die 事件的 exit_code 保持 NULL,不被写成 0', () => {
  const row = addContainerStateEvent({
    containerId: 'c-null-exit',
    containerName: 'null-exit',
    projectId: 'state-history-null',
    projectName: 'state-history',
    action: 'start',
    timestamp: BASE + 10,
  });
  assert.equal(row.exitCode, null);
  assert.equal(row.execDuration, null);
  // 字符串形式的退出码(Docker 事件 attributes 全是字符串)也要落成整数
  const die = addContainerStateEvent({
    containerId: 'c-null-exit',
    containerName: 'null-exit',
    projectId: 'state-history-null',
    projectName: 'state-history',
    action: 'die',
    exitCode: '137',
    execDuration: '42',
    timestamp: BASE + 20,
  });
  assert.equal(die.exitCode, 137);
  assert.equal(die.execDuration, 42);
});

test('状态历史: 按保留天数清理过期事件', () => {
  const now = Math.floor(Date.now() / 1000);
  seed('c-old', 'old', [{ action: 'die', at: now - 10 * 86400, exitCode: 1 }]);
  const removed = pruneStateHistory(5);
  // BASE 那批 2023 年的事件同样超期,只断言"至少清掉目标行"
  assert.ok(removed.changes >= 1);
  assert.equal(listStateHistory({ projectId: PROJECT, containerId: 'c-old' }).length, 0);
  // 窗口内的近期事件不能被误删
  assert.equal(listStateHistory({ projectId: PROJECT, containerId: 'c-exit-oom' }).length, 1);
  // days 非法时回退到默认 90 天,不会误删全表
  assert.equal(pruneStateHistory(0).changes, 0);
  assert.equal(listStateHistory({ projectId: PROJECT, containerId: 'c-exit-oom' }).length, 1);
});
