import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate } from '../src/services/agent/approval-gate.js';
import { assessRisk } from '../src/services/agent-tools.js';
import { nextRunTime } from '../src/services/cron-scheduler.js';
import { addGitOpsRepo, listGitOpsRepos } from '../src/services/gitops.js';
import {
  addComposeBackup,
  getComposeBackup,
  listComposeBackups,
  setSetting,
  exportUserData,
  COMPOSE_BACKUP_KEEP,
} from '../src/lib/db.js';

/* ---------------- 审批门 fail-closed ---------------- */

test('approval-gate: critical 优先于记忆授权——remember 后仍必须确认', () => {
  const gate = new ApprovalGate();
  gate.setMode('s1', 'full');
  // full 模式下 low/medium/high 免确认
  assert.equal(gate.needsConfirmation('s1', 'compose.ps', {}, 'low', false), false);
  // critical 即使在 allowed 集合里也必须确认(fail-closed 顺序)
  gate.allowForSession('s1', 'maintenance.clean', { scope: 'images' }, 'tool', 'low');
  assert.equal(gate.needsConfirmation('s1', 'maintenance.clean', { scope: 'images' }, 'critical', true), true);
  // allowForSession 显式拒绝 critical 记忆
  assert.equal(gate.allowForSession('s1', 'maintenance.clean', {}, 'tool', 'critical'), false);
  assert.equal(gate.needsConfirmation('s1', 'maintenance.clean', {}, 'critical', true), true);
});

test('approval-gate: 指纹覆盖全部参数——同容器换命令不算同参数', () => {
  const gate = new ApprovalGate();
  // 旧行为指纹只含 projectId/containerId:记住"ls"后"rm -rf"也会被放行。
  gate.allowForSession('s2', 'compose.exec', { projectId: 'p1', containerId: 'c1', command: 'ls' }, 'call');
  // 指纹键序无关,精确同参数放行
  assert.equal(gate.needsConfirmation('s2', 'compose.exec', { containerId: 'c1', projectId: 'p1', command: 'ls' }, 'high', true), false);
  // 换了 command 必须重新确认
  assert.equal(gate.needsConfirmation('s2', 'compose.exec', { projectId: 'p1', containerId: 'c1', command: 'rm -rf /' }, 'high', true), true);
});

test('approval-gate: 匿名会话不共享记忆授权', () => {
  const gate = new ApprovalGate();
  gate.allowForSession(null, 'compose.restart', { projectId: 'p1' }, 'tool');
  // 匿名调用(无 sessionId)每次独立,记忆不生效
  assert.equal(gate.needsConfirmation(undefined, 'compose.restart', { projectId: 'p1' }, 'medium', true), true);
  gate.allowForSession('s3', 'compose.restart', { projectId: 'p1' }, 'tool');
  assert.equal(gate.needsConfirmation('s3', 'compose.restart', { projectId: 'p1' }, 'medium', true), false);
});

test('approval-gate: allow_writes 放行 low/medium,high 与 critical 确认', () => {
  const gate = new ApprovalGate();
  gate.setMode('s4', 'allow_writes');
  assert.equal(gate.needsConfirmation('s4', 'compose.pull', {}, 'low', false), false);
  assert.equal(gate.needsConfirmation('s4', 'compose.restart', {}, 'medium', true), false);
  assert.equal(gate.needsConfirmation('s4', 'compose.up', {}, 'high', true), true);
  assert.equal(gate.needsConfirmation('s4', 'app.deploy', {}, 'critical', true), true);
});

test('assessRisk: 宏工具读注册表 risk,不落 low 默认', () => {
  assert.equal(assessRisk('macro.full_cleanup', {}, {}), 'critical');
  assert.equal(assessRisk('macro.emergency_rollback', {}, {}), 'critical');
  assert.equal(assessRisk('macro.safe_restart', {}, {}), 'high');
});

/* ---------------- cron 修复 ---------------- */

test('cron: weekday=7(周日方言)在周日命中', () => {
  // 2026-09-27 是周日。找一个周日 03:00 之后的时刻,下一次 03:00 应命中下周日而非跳过。
  const sundayNoon = new Date(2026, 8, 27, 12, 0, 0); // 周日 12:00 本地时间
  const next = nextRunTime('0 3 * * 7', sundayNoon);
  assert.ok(next, 'weekday=7 应有下一次执行时间');
  assert.equal(next.getDay(), 0, '必须在周日执行');
  assert.equal(next.getHours(), 3);
  // weekday=0 与 7 等价
  const next0 = nextRunTime('0 3 * * 0', sundayNoon);
  assert.equal(next0.getTime(), next.getTime());
  // 普通工作日字段不受影响
  const monday = nextRunTime('0 3 * * 1', sundayNoon);
  assert.equal(monday.getDay(), 1);
});

test('cron: 新任务从当前时间起算,不会立即补跑', () => {
  // 模拟 tick 逻辑:lastRunAt 为 null 时从 now 起算,下一次执行必然在未来。
  const now = new Date();
  const next = nextRunTime('*/5 * * * *', now);
  assert.ok(next.getTime() > now.getTime(), '新任务的下一次执行必须晚于创建时刻');
});

/* ---------------- GitOps URL 白名单 ---------------- */

test('gitops: ext:: 与未知协议被拒绝,http/ssh/git@ 放行', () => {
  assert.throws(
    () => addGitOpsRepo({ name: 'x', url: 'ext::sh -c touch /tmp/pwned', localPath: '/tmp/gitops-a', projectId: 'p' }),
    /仓库 URL 仅支持/,
  );
  assert.throws(
    () => addGitOpsRepo({ name: 'x', url: 'git://example.com/x.git', localPath: '/tmp/gitops-b', projectId: 'p' }),
    /仓库 URL 仅支持/,
  );
  const repo = addGitOpsRepo({ name: 'audit-ok', url: 'https://example.com/x.git', localPath: '/tmp/gitops-ok', projectId: 'p' });
  assert.equal(repo.url, 'https://example.com/x.git');
  const stored = listGitOpsRepos().find((item) => item.id === repo.id);
  assert.ok(stored, '合法 URL 应正常入库');
});

/* ---------------- 备份保留与回滚数据面 ---------------- */

test('compose 备份: 写入与清理共用同一保留常量,均为 20 份', () => {
  assert.equal(COMPOSE_BACKUP_KEEP, 20);
  for (let i = 0; i < 25; i += 1) {
    addComposeBackup('audit-rollback-project', `/tmp/project/docker-compose.yml`, `version: "3"\n# rev ${i}`, 'save');
  }
  const kept = listComposeBackups('audit-rollback-project');
  assert.equal(kept.length, 20, '写入侧保留 20 份');
  assert.ok(kept.every((item) => item.content === undefined && item.size > 0), '列表查询不带正文(只有 size)');
  const newest = kept[0];
  const full = getComposeBackup('audit-rollback-project', newest.id);
  assert.equal(full.content, 'version: "3"\n# rev 24', 'getComposeBackup 必须返回正文——rollbackProject 依赖它');
});

test('export: docker.hosts 整键排除,SSH 凭据不外泄', () => {
  setSetting('docker.hosts', JSON.stringify([
    { id: 'h1', name: 'prod', type: 'ssh', host: '10.0.0.5', username: 'root', password: 'hunter2', privateKey: '/root/.ssh/id_rsa' },
  ]));
  const data = exportUserData();
  assert.equal(data.settings['docker.hosts'], undefined, '导出不得包含 docker.hosts');
  assert.equal(data.settings['auth.password_hash'], undefined);
});
