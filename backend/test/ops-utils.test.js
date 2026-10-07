import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-ops-test-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { parseImageRef, extractImageRefs } = await import('../src/services/image-updater.js');
const { parseDockerDf, parseDockerDfOutput } = await import('../src/services/docker-storage.js');
const { renderBlueprintCompose, renderBlueprintEnv, getBlueprint, listBlueprints } = await import('../src/services/app-blueprints.js');
const { evaluateContainer, buildTitle, buildBody, stripDockerMultiplex } = await import('../src/services/health-alerter.js');

test('image-updater: parseImageRef 识别 registry/image/tag', () => {
  assert.deepEqual(parseImageRef('nginx:1.25'), { registry: 'docker.io', image: 'library/nginx', tag: '1.25', original: 'nginx:1.25' });
  assert.deepEqual(parseImageRef('ghcr.io/gethomepage/homepage:latest'), { registry: 'ghcr.io', image: 'gethomepage/homepage', tag: 'latest', original: 'ghcr.io/gethomepage/homepage:latest' });
  assert.equal(parseImageRef('${IMAGE}'), null);
});

test('image-updater: extractImageRefs 提取 compose 中 services.image', () => {
  const compose = `services:\n  web:\n    image: nginx:alpine\n  api:\n    image: ghcr.io/org/api:2.0\n  noimage:\n    build: ./app\n`;
  const refs = extractImageRefs(compose);
  assert.deepEqual(refs, ['nginx:alpine', 'ghcr.io/org/api:2.0']);
});

test('docker-storage: parseDockerDf 解析 df json 并汇总 reclaimable', () => {
  const data = {
    Images: [{ Size: 1000, Containers: 0 }, { Size: 500, Containers: 1 }],
    Containers: [{ SizeRw: 200, State: 'exited' }, { SizeRw: 100, State: 'running' }],
    Volumes: [{ Name: 'v1', UsageData: { Size: 300, RefCount: 0 } }, { Name: 'v2', UsageData: { Size: 400, RefCount: 1 } }],
    BuildCache: [{ Size: 50, InUse: false }, { Size: 25, InUse: true }],
  };
  const parsed = parseDockerDf(data);
  assert.equal(parsed.images.total, 1500);
  assert.equal(parsed.images.reclaimable, 1000);
  assert.equal(parsed.volumes.orphans, 1);
  assert.equal(parsed.volumes.reclaimable, 300);
  assert.equal(parsed.buildCache.reclaimable, 50);
  assert.equal(parsed.reclaimable, 1000 + 200 + 300 + 50);
});

test('docker-storage: parseDockerDf 空数据返回 0', () => {
  const parsed = parseDockerDf({});
  assert.equal(parsed.total, 0);
  assert.equal(parsed.reclaimable, 0);
});

test('blueprints: 内置模板 ≥15 且分类完整', async () => {
  const blueprints = await listBlueprints();
  assert.ok(blueprints.length >= 15);
  const categories = new Set(blueprints.map((b) => b.category));
  for (const c of ['Media', 'Tools', 'AI', 'Database', 'Network']) assert.ok(categories.has(c));
});

test('blueprints: renderBlueprintCompose 替换 env 变量', async () => {
  const blueprint = await getBlueprint('uptime-kuma');
  const compose = renderBlueprintCompose(blueprint, { PORT: '8088', DATA_PATH: '/srv/kuma' });
  assert.match(compose, /"8088:3001"/);
  assert.match(compose, /\/srv\/kuma:\/app\/data/);
});

test('blueprints: renderBlueprintEnv 隐藏空秘密并输出普通字段', async () => {
  const blueprint = await getBlueprint('meilisearch');
  const env = renderBlueprintEnv(blueprint, { PORT: '7700', MASTER_KEY: '' });
  assert.match(env, /PORT=7700/);
  assert.match(env, /# MASTER_KEY=\(请填写\)/);
});

test('health-alerter: evaluateContainer 判定 exit/oom/unhealthy 事件', () => {
  const exited = evaluateContainer({ name: 'web', state: 'exited', exitCode: 1, oomKilled: false }, null);
  assert.equal(exited.triggered, true);
  assert.ok(exited.events.includes('exit'));
  const oom = evaluateContainer({ name: 'db', state: 'exited', exitCode: 137, oomKilled: true }, null);
  assert.ok(oom.events.includes('oom'));
  const unhealthy = evaluateContainer({ name: 'app', state: 'running', health: 'unhealthy' }, null);
  assert.ok(unhealthy.events.includes('unhealthy'));
  const healthy = evaluateContainer({ name: 'app', state: 'running', health: 'healthy' }, null);
  assert.equal(healthy.triggered, false);
});

test('health-alerter: buildTitle/buildBody 包含项目、容器、退出码与日志', () => {
  const project = { projectName: 'myapp' };
  const container = { name: 'web', state: 'exited', exitCode: 1 };
  const title = buildTitle(project, container, 'exit');
  assert.match(title, /容器异常退出.*myapp \/ web/);
  const body = buildBody(project, container, 'exit', 'Error: connect refused\n  at stack');
  assert.match(body, /项目:myapp/);
  assert.match(body, /退出码:1/);
  assert.match(body, /最近日志[\s\S]*Error: connect refused/);
});

test('health-alerter: stripDockerMultiplex 去掉 8 字节头', () => {
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(5, 4);
  const payload = Buffer.from('hello', 'utf8');
  const frame = Buffer.concat([header, payload, header, Buffer.from('world', 'utf8')]);
  assert.equal(stripDockerMultiplex(frame), 'helloworld');
});

test('docker-storage: parseDockerDfOutput 解析整体 JSON(--format json)', () => {
  const raw = JSON.stringify({
    Images: [{ Size: 1000, Containers: 0 }, { Size: 500, Containers: 1 }],
    Containers: [{ SizeRw: 200, State: 'exited' }, { SizeRw: 100, State: 'running' }],
    Volumes: [{ Name: 'v1', UsageData: { Size: 300, RefCount: 0 } }],
    BuildCache: [{ Size: 50, InUse: false }],
  });
  const parsed = parseDockerDfOutput(raw);
  assert.equal(parsed.images.total, 1500);
  assert.equal(parsed.images.reclaimable, 1000);
  assert.equal(parsed.reclaimable, 1000 + 200 + 300 + 50);
});

test('docker-storage: parseDockerDfOutput 解析 NDJSON 多行独立对象', () => {
  const raw = [
    JSON.stringify({ Type: 'Images', TotalCount: 2, ActiveCount: 1, Size: 1200, Reclaimable: 800 }),
    JSON.stringify({ Type: 'Containers', TotalCount: 1, ActiveCount: 1, Size: 300, Reclaimable: 0 }),
    JSON.stringify({ Type: 'Volumes', TotalCount: 1, ActiveCount: 0, Size: 500, Reclaimable: 500 }),
    JSON.stringify({ Type: 'BuildCache', TotalCount: 1, ActiveCount: 0, Size: 100, Reclaimable: 100 }),
  ].join('\n');
  const parsed = parseDockerDfOutput(raw);
  // NDJSON 模式:Size 作为 total,Reclaimable>0 的块计入 reclaimable
  assert.equal(parsed.images.total, 1200);
  assert.equal(parsed.images.reclaimable, 800);
  assert.equal(parsed.volumes.total, 500);
  assert.equal(parsed.buildCache.reclaimable, 100);
});

test('docker-storage: 解析新版 Docker NDJSON 的人类可读容量与汇总数量', () => {
  const raw = [
    JSON.stringify({ Type: 'Images', TotalCount: '22', Active: '13', Size: '28.76GB', Reclaimable: '25.81GB (89%)' }),
    JSON.stringify({ Type: 'Containers', TotalCount: '13', Active: '12', Size: '6.555GB', Reclaimable: '4.096kB (0%)' }),
    JSON.stringify({ Type: 'Local Volumes', TotalCount: '5', Active: '3', Size: '826MB', Reclaimable: '4.041kB (0%)' }),
    JSON.stringify({ Type: 'Build Cache', TotalCount: '497', Active: '0', Size: '17.39GB', Reclaimable: '14.21GB' }),
  ].join('\n');
  const parsed = parseDockerDfOutput(raw);
  assert.equal(parsed.images.count, 22);
  assert.equal(parsed.images.total, 28.76 * 1024 ** 3);
  assert.equal(parsed.images.reclaimable, 25.81 * 1024 ** 3);
  assert.equal(parsed.containers.count, 13);
  assert.equal(parsed.volumes.count, 5);
  assert.equal(parsed.volumes.orphans, 2);
  assert.equal(parsed.buildCache.count, 497);
  assert.equal(parsed.buildCache.total, 17.39 * 1024 ** 3);
  assert.equal(parsed.buildCache.reclaimable, 14.21 * 1024 ** 3);
});

test('docker-storage: parseDockerDfOutput 容忍 WARNING/ANSI 脏输出', () => {
  const raw = '\x1b[2J WARNING: Error getting usage insights\n' + JSON.stringify({
    Images: [{ Size: 10, Containers: 0 }],
  }) + '\n';
  const parsed = parseDockerDfOutput(raw);
  assert.equal(parsed.images.total, 10);
});

test('docker-storage: parseDockerDfOutput 回退纯文本表格解析', () => {
  const raw = [
    'TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE',
    'Images          5         2         1.2GB     800MB (66.6%)',
    'Containers      3         1         50MB      10MB (20%)',
    'Local Volumes   2         1         5MB       5MB (100%)',
    'Build Cache     4         0         0B        0B',
  ].join('\n');
  const parsed = parseDockerDfOutput(raw);
  assert.ok(Math.abs(parsed.images.total - 1.2 * 1024 ** 3) < 1);
  assert.ok(Math.abs(parsed.images.reclaimable - 800 * 1024 ** 2) < 1);
  assert.equal(parsed.containers.count, 3);
  assert.ok(Math.abs(parsed.volumes.total - 5 * 1024 ** 2) < 1);
  assert.ok(Math.abs(parsed.total - (1.2 * 1024 ** 3 + 50 * 1024 ** 2 + 5 * 1024 ** 2)) < 1);
});

test('docker-storage: parseDockerDfOutput 空/不可解析输出安全返回全 0', () => {
  for (const raw of ['', '\n', 'WARNING: something\n', 'not json at all']) {
    const parsed = parseDockerDfOutput(raw);
    assert.equal(parsed.total, 0);
    assert.equal(parsed.reclaimable, 0);
    assert.deepEqual(parsed.images, { count: 0, total: 0, reclaimable: 0 });
  }
});
