import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, link, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  inspectSources,
  runBackup,
  runRecovery,
  validBackupPath,
  configurationDigests,
  containerIdentity,
  backupStopOrder,
} from '../src/services/maintenance-worker.js';
import { encryptArtifact, decryptArtifact } from '../src/services/maintenance-archive.js';
import { extractFullBackup } from '../scripts/full-backup-extract.js';

async function fixture(t, patch = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'full-backup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'app'),
    output = path.join(root, 'backup');
  await mkdir(source);
  await mkdir(output);
  await writeFile(path.join(source, '.env'), 'PASSWORD=fixture-only');
  const key = randomBytes(32),
    keyFile = path.join(root, 'recovery.key');
  await writeFile(keyFile, key);
  const prefix = (x) => x,
    sources = [{ kind: 'bind', source, index: 0 }];
  const scan = await inspectSources(sources, output, { prefix, destinationLocation: output });
  const containers = [
    {
      Id: 'web',
      Name: '/web',
      Image: 'sha256:base',
      Config: { Image: 'web:1', Labels: {} },
      HostConfig: {},
      Mounts: [],
      NetworkSettings: { Networks: {} },
      State: { Running: true, ExitCode: 0 },
    },
    {
      Id: 'db',
      Name: '/db',
      Image: 'sha256:base',
      Config: { Image: 'mariadb:11', Labels: {} },
      HostConfig: {},
      Mounts: [],
      NetworkSettings: { Networks: {} },
      State: { Running: false, ExitCode: 0 },
    },
  ];
  const runtime = structuredClone(containers),
    calls = [];
  const docker = {
    getContainer: (id) => ({
      inspect: async () => structuredClone(runtime.find((c) => c.Id === id)),
      stop: async () => {
        calls.push('stop:' + id);
        Object.assign(runtime.find((c) => c.Id === id).State, {
          Running: false,
          ExitCode: patch.exitCode || 0,
        });
      },
      start: async () => {
        calls.push('start:' + id);
        runtime.find((c) => c.Id === id).State.Running = true;
      },
      commit: async () => {
        calls.push('commit:' + id);
        return { Id: 'sha256:commit-' + id };
      },
    }),
    getImage: (id) => ({
      get: async () => Readable.from(['image:' + id]),
      remove: async () => {
        calls.push('remove:' + id);
      },
    }),
    listContainers: async () =>
      runtime.map((c) => ({ Id: c.Id, State: c.State.Running ? 'running' : 'exited', Labels: {} })),
  };
  const config = {
    id: randomUUID(),
    key: key.toString('base64'),
    backupPath: output,
    containers,
    sources,
    scan,
    imageBytes: 100,
    rootfsBytes: 20,
    projects: [],
    networks: [],
    volumes: [],
    allIds: containers.map((c) => c.Id),
  };
  const archive = () => ({ stream: Readable.from(['tar-fixture']), done: Promise.resolve(), stop: () => {} });
  return {
    root,
    source,
    output,
    key,
    keyFile,
    config,
    docker,
    calls,
    runtime,
    options: { docker, output, prefix, archive, verifyArtifact: (file, key) => decryptArtifact(file, key) },
  };
}
test('完整备份包含镜像、可写层和加密清单，恢复原运行状态且不启动原停止容器', async (t) => {
  const f = await fixture(t);
  const receipt = await runBackup(f.config, f.options);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.fileVerified, true);
  assert.equal(receipt.restoreVerified, false);
  assert.equal(receipt.artifacts.filter((a) => a.kind === 'image').length, 1);
  assert.equal(receipt.artifacts.filter((a) => a.kind === 'writable-layer').length, 2);
  assert.deepEqual(
    f.calls.filter((s) => s.startsWith('start:')),
    ['start:web'],
  );
  const destination = path.join(f.root, 'restored');
  await extractFullBackup(path.join(f.output, f.config.id), f.keyFile, destination);
  const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
  assert.equal(manifest.containers.length, 2);
  assert.equal(await readFile(path.join(destination, 'source-0.tar'), 'utf8'), 'tar-fixture');
  assert.equal(
    (await readFile(path.join(f.output, f.config.id, 'manifest.json.enc'))).includes(Buffer.from('PASSWORD')),
    false,
  );
});
test('强制退出不能冒充数据库干净停机；仍尝试恢复运行', async (t) => {
  const f = await fixture(t, { exitCode: 137 });
  await assert.rejects(runBackup(f.config, f.options), /未干净退出/);
  assert.ok(f.calls.includes('start:web'));
  assert.equal((await readdir(path.join(f.output, f.config.id))).includes('receipt.json'), false);
});
test('归档失败恢复所有原运行容器且不产生完整备份收据', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runBackup(f.config, {
      ...f.options,
      archive: () => {
        throw new Error('模拟归档失败');
      },
    }),
    /模拟归档失败/,
  );
  assert.equal(f.runtime[0].State.Running, true);
  assert.equal((await readdir(path.join(f.output, f.config.id))).includes('receipt.json'), false);
});
test('执行前身份变化阻止停机', async (t) => {
  const f = await fixture(t);
  f.runtime[0].Config.Image = 'changed:2';
  await assert.rejects(runBackup(f.config, f.options), /配置或启停状态已改变/);
  assert.deepEqual(f.calls, []);
});
test('重启执行器发现中断日志时只恢复原运行状态，不能重放或报告完整', async (t) => {
  const f = await fixture(t);
  f.runtime[0].State.Running = false;
  await mkdir(path.join(f.output, f.config.id));
  await writeFile(path.join(f.output, f.config.id, 'journal.json'), JSON.stringify({ resumeIds: ['web'] }));
  await assert.rejects(runBackup(f.config, f.options), /上次备份进程中断/);
  assert.deepEqual(f.calls, ['start:web']);
});
test('源和目标重叠、外部符号链接、跨归档硬链接均明确阻止', async (t) => {
  const f = await fixture(t),
    prefix = (x) => x;
  await assert.rejects(
    inspectSources(f.config.sources, f.source, { prefix, destinationLocation: f.source }),
    /重叠/,
  );
  const outside = path.join(f.root, 'outside');
  await writeFile(outside, 'external');
  await symlink(outside, path.join(f.source, 'external'));
  await assert.rejects(
    inspectSources(f.config.sources, f.output, { prefix, destinationLocation: f.output }),
    /符号链接目标/,
  );
  await rm(path.join(f.source, 'external'));
  await link(outside, path.join(f.source, 'hard'));
  await assert.rejects(
    inspectSources(f.config.sources, f.output, { prefix, destinationLocation: f.output }),
    /硬链接/,
  );
});
test('篡改密文或错误密钥无法解密成功', async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, 'test.enc');
  await encryptArtifact('秘密数据', file, f.key);
  await assert.rejects(decryptArtifact(file, randomBytes(32)));
  const data = await readFile(file);
  data[20] ^= 1;
  await writeFile(file, data);
  await assert.rejects(decryptArtifact(file, f.key));
});
test('保存路径拒绝根目录和跳转', () => {
  for (const p of ['/', '/vol1', 'relative', '/x/../data', '/x\n']) assert.equal(validBackupPath(p), false);
  assert.equal(validBackupPath('/vol1/backups/app'), true);
});
test('部署配置内容变化即使文件长度相同也必须重新预检', async (t) => {
  const f = await fixture(t);
  f.config.configFiles = [path.join(f.source, '.env')];
  f.config.configDigests = await configurationDigests(f.config.configFiles, (x) => x);
  await writeFile(f.config.configFiles[0], 'PASSWORD=fixture-other');
  await assert.rejects(runBackup(f.config, f.options), /配置或环境文件已变化/);
  assert.equal(
    f.calls.some((c) => c.startsWith('stop:')),
    false,
  );
});
test('停止后 EndpointID 变化不等于网络配置变化，新增网络仍应识别', () => {
  const a = {
    Id: 'c',
    Config: {},
    HostConfig: {},
    Mounts: [],
    State: { Running: true },
    NetworkSettings: { Networks: { app: { NetworkID: 'net', EndpointID: 'old' } } },
  };
  const b = structuredClone(a);
  b.NetworkSettings.Networks.app.EndpointID = 'new';
  assert.deepEqual(containerIdentity(a), containerIdentity(b));
  b.NetworkSettings.Networks.other = { NetworkID: 'other' };
  assert.notDeepEqual(containerIdentity(a), containerIdentity(b));
});
test('Docker Mounts 的随机枚举顺序不应触发错误的配置变化', () => {
  const a = {
    Id: 'c',
    Config: {},
    HostConfig: {},
    Mounts: [
      { Type: 'volume', Name: 'data', Destination: '/data' },
      { Type: 'bind', Source: '/x', Destination: '/x' },
    ],
    State: { Running: true },
  };
  const b = structuredClone(a);
  b.Mounts.reverse();
  assert.deepEqual(containerIdentity(a), containerIdentity(b));
  b.Mounts[0].Source = '/different';
  assert.notDeepEqual(containerIdentity(a), containerIdentity(b));
});
test('按最终 Compose 依赖先停消费者后停依赖，不能只按镜像名称猜测', () => {
  const c = (service) => ({
    Id: service,
    Config: {
      Image: 'custom:1',
      Labels: {
        'com.docker.compose.project': 'app',
        'com.docker.compose.project.working_dir': '/app',
        'com.docker.compose.service': service,
      },
    },
  });
  const order = backupStopOrder(
    [c('database'), c('web'), c('gateway')],
    [
      {
        name: 'app',
        directory: '/app',
        model: {
          services: {
            database: {},
            web: { depends_on: { database: { condition: 'service_healthy' } } },
            gateway: { depends_on: { web: { condition: 'service_started' } } },
          },
        },
      },
    ],
  );
  assert.deepEqual(
    order.map((c) => c.Id),
    ['gateway', 'web', 'database'],
  );
});

for (const healthy of [true, false]) test(`恢复原运行状态必须验证健康，空 journal 不能绕过：${healthy}`, async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'recovery-health-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const directory = path.join(output, 'original');
  await mkdir(directory);
  await writeFile(path.join(directory, 'journal.json'), JSON.stringify({ resumeIds: [] }));
  const info = { Id: 'app', Image: 'sha256:original', Config: { Labels: {} }, HostConfig: {}, Mounts: [], State: { Running: true, Health: { Status: healthy ? 'healthy' : 'unhealthy' } } };
  const signature = createHash('sha256').update(JSON.stringify(containerIdentity({ ...info, State: { ...info.State, Running: false } }))).digest('hex');
  const config = { originalId: 'original', engineId: 'engine', originallyRunning: ['app'], originalIdentities: [{ id: 'app', signature }] };
  const options = { output, attempts: 1, wait: async () => {}, docker: { info: async () => ({ ID: 'engine' }), getContainer: () => ({ inspect: async () => info, start: async () => assert.fail('already running') }) } };
  if (healthy) assert.deepEqual(await runRecovery(config, options), { recovered: true });
  else await assert.rejects(runRecovery(config, options), /健康检查未通过/);
  await assert.rejects(runRecovery({ ...config, engineId: 'different' }, options), /Engine 身份/);
  await assert.rejects(runRecovery({ ...config, originalIdentities: [] }, options), /身份或配置/);
});
