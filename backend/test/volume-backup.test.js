import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-volbackup-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { parseProjectVolumes, resolveProjectVolumeNames, getBackupDir, resolveMountedHostPath, createVolumeBackup, openBackupStream, listProjectVolumes } = await import('../src/services/volume-backup.js');
const db = (await import('../src/lib/db.js')).default;
const {
  addVolumeBackup, pruneVolumeBackups, pruneAiData,
  getVolumeBackup, deleteVolumeBackupRow,
  createAiSession, addAiMessage, createAgentPlan, recordAgentExecution, recordAiUsage,
} = await import('../src/lib/db.js');
const { setSetting } = await import('../src/lib/db.js');


test('volume-backup: 容器内备份目录映射到宿主机持久化卷真实路径', () => {
  const hostPath = resolveMountedHostPath({ Mounts: [
    { Type: 'volume', Source: '/var/lib/docker/volumes/opsdash-data/_data', Destination: '/app/backend/data' },
    { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
  ] }, '/app/backend/data/volume-backups');
  assert.equal(hostPath, '/var/lib/docker/volumes/opsdash-data/_data/volume-backups');
});

test('volume-backup: 宿主机路径映射选择最深的匹配挂载点', () => {
  const hostPath = resolveMountedHostPath({ Mounts: [
    { Type: 'bind', Source: '/srv', Destination: '/app' },
    { Type: 'bind', Source: '/mnt/data', Destination: '/app/backend/data' },
  ] }, '/app/backend/data/volume-backups');
  assert.equal(hostPath, '/mnt/data/volume-backups');
});

test('volume-backup: 拒绝映射到应用容器挂载点之外的目录', () => {
  assert.throws(
    () => resolveMountedHostPath({ Mounts: [
      { Type: 'volume', Source: '/var/lib/docker/volumes/opsdash-data/_data', Destination: '/app/backend/data' },
    ] }, '/tmp/volume-backups'),
    (error) => error.statusCode === 400 && /挂载点/.test(error.message),
  );
});

test('volume-backup: parseProjectVolumes 区分命名卷/bind/变量引用', () => {
  const compose = `
services:
  web:
    image: nginx
    volumes:
      - "web-data:/var/www"
      - "./site:/usr/share/nginx/html"
      - "/etc/localtime:/etc/localtime:ro"
      - "$DATA_DIR/cache:/cache"
      - type: bind
        source: ./config
        target: /config
      - type: tmpfs
        target: /tmpfs
  api:
    image: api
    volumes:
      - web-data:/shared
volumes:
  web-data:
  external-vol:
    external: true
`;
  const { volumes, error } = parseProjectVolumes(compose);
  assert.equal(error, '');
  const byName = new Map(volumes.map((item) => [item.name, item]));
  assert.equal(byName.get('web-data').skip, '');
  assert.equal(byName.get('external-vol').external, true);
  assert.ok(byName.get('./site').skip.includes('bind mount'));
  assert.ok(byName.get('/etc/localtime').skip.includes('bind mount'));
  assert.ok(byName.get('$DATA_DIR/cache').skip.includes('变量引用'));
  assert.ok(byName.get('./config').skip.includes('bind mount'));
  assert.ok(!byName.has('/tmpfs'), 'tmpfs 无持久数据,不产生条目');
});

test('volume-backup: parseProjectVolumes 容忍空内容与非法 YAML', () => {
  assert.deepEqual(parseProjectVolumes(''), { volumes: [], error: '' });
  assert.ok(parseProjectVolumes('- [a, b').error.includes('YAML'));
});

test('volume-backup: 逻辑卷键解析为 Compose 实际卷名', () => {
  const parsed = parseProjectVolumes(`
services:
  app:
    image: nginx
    volumes:
      - data:/var/lib/app
      - external-data:/var/lib/external
volumes:
  data:
  external-data:
    external: true
    name: shared-data
  named-alias:
    name: legacy-data
`);
  const resolved = resolveProjectVolumeNames(parsed.volumes, 'demo', ['demo_data', 'shared-data', 'legacy-data']);
  const byComposeName = new Map(resolved.map((item) => [item.composeName, item]));
  assert.equal(byComposeName.get('data').name, 'demo_data');
  assert.equal(byComposeName.get('data').exists, true);
  assert.equal(byComposeName.get('external-data').name, 'shared-data');
  assert.equal(byComposeName.get('external-data').exists, true);
  assert.equal(byComposeName.get('named-alias').name, 'legacy-data');
  assert.equal(byComposeName.get('named-alias').exists, true);

  const bareOnly = resolveProjectVolumeNames(parsed.volumes, 'demo', ['data']);
  assert.equal(bareOnly.find((item) => item.composeName === 'data').name, 'demo_data');
  assert.equal(bareOnly.find((item) => item.composeName === 'data').exists, false, '同名裸卷不能冒充项目卷');
});

test('volume-backup: 同卷超限清理返回应删记录', () => {
  for (let index = 0; index < 25; index += 1) {
    addVolumeBackup({ projectId: 'p1', projectName: 'demo', volume: 'data', file: `demo_data_${index}.tar.gz`, bytes: index, host: 'local' });
  }
  const stale = pruneVolumeBackups('p1', 'data', 20);
  assert.equal(stale.length, 5);
  assert.ok(stale.every((item) => /demo_data_[0-4]\./.test(item.file)), '应清理最旧的 5 份');
  for (const item of stale) deleteVolumeBackupRow(item.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM volume_backups WHERE project_id = 'p1'").get().c, 20);
  assert.equal(getVolumeBackup(1), null, '最旧的记录应被清理');
  assert.ok(getVolumeBackup(25));
  deleteVolumeBackupRow(25);
});

test('volume-backup: retention 按宿主隔离且兼容旧的 keep 参数', () => {
  for (let index = 0; index < 3; index += 1) {
    addVolumeBackup({ projectId: 'p-host', projectName: 'demo', volume: 'data', file: `local_${index}.tar.gz`, host: 'local' });
  }
  for (let index = 0; index < 3; index += 1) {
    addVolumeBackup({ projectId: 'p-host', projectName: 'demo', volume: 'data', file: `remote_${index}.tar.gz`, host: 'node-a' });
  }
  const stale = pruneVolumeBackups('p-host', 'data', { keep: 2, host: 'node-a' });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].host, 'node-a');
  assert.equal(pruneVolumeBackups('p-host', 'data', 2).length, 4, '不传宿主时保留旧的全局查询语义');
  for (const item of stale) deleteVolumeBackupRow(item.id);
  db.prepare("DELETE FROM volume_backups WHERE project_id = 'p-host'").run();
});

test('volume-backup: 旧记录文件名与卷名必须在执行前拒绝', async () => {
  await assert.rejects(() => createVolumeBackup({}, '../outside'), (error) => error.statusCode === 400);
  const id = addVolumeBackup({ projectId: 'p-invalid', projectName: 'demo', volume: 'data', file: '../outside.tar.gz', host: 'local' });
  await assert.rejects(() => openBackupStream(id), (error) => error.statusCode === 409);
  deleteVolumeBackupRow(id);
});

test('volume-backup: 不同宿主使用独立备份目录且记录保留宿主', () => {
  setSetting('backup.volume_dir', '/tmp/default-volume-backups');
  setSetting('backup.volume_dir.node-a', '/srv/node-a-backups');
  assert.equal(getBackupDir({ id: 'node-a' }), '/srv/node-a-backups');
  assert.equal(getBackupDir({ id: 'node-b' }), '/tmp/default-volume-backups');
  const id = addVolumeBackup({ projectId: 'remote-project', projectName: 'remote', volume: 'data', file: 'remote.tar.gz', host: 'node-a' });
  assert.equal(getVolumeBackup(id).host, 'node-a');
  deleteVolumeBackupRow(id);
});

test('volume-backup: 没有 Compose 工作区时拒绝读取项目配置', async () => {
  await assert.rejects(
    () => listProjectVolumes({ id: 'tcp-project', projectName: 'tcp-project', composeMode: 'containers' }),
    (error) => error.statusCode === 409 && error.code === 'COMPOSE_WORKSPACE_REQUIRED',
  );
});

test('retention: pruneAiData 按保留天数清理会话与 Agent 审计', () => {
  const sessionId = createAiSession();
  addAiMessage('user', '很久之前的提问', null, sessionId);
  db.prepare("UPDATE ai_history SET created_at = datetime('now', '-100 days')").run();
  const planId = createAgentPlan(sessionId, '旧计划', { steps: [] });
  db.prepare("UPDATE agent_plans SET created_at = datetime('now', '-100 days') WHERE id = ?").run(planId);
  recordAgentExecution(planId, 'compose.ps', {}, 'success');
  recordAiUsage({ sessionId, model: 'test-model', usage: { total_tokens: 10 } });
  db.prepare("UPDATE ai_usage SET created_at = datetime('now', '-100 days') WHERE session_id = ?").run(sessionId);
  const freshSession = createAiSession();
  addAiMessage('user', '今天的提问', null, freshSession);

  const result = pruneAiData(90);
  assert.ok(result.history >= 1);
  assert.ok(result.plans >= 1);
  assert.ok(result.usage >= 1);
  const remainingHistory = db.prepare('SELECT content FROM ai_history ORDER BY id').all().map((row) => row.content);
  assert.deepEqual(remainingHistory, ['今天的提问']);
  const remainingPlans = db.prepare('SELECT COUNT(*) c FROM agent_plans').get().c;
  assert.equal(remainingPlans, 0);
});
