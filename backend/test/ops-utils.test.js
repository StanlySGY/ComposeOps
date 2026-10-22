import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-ops-test-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { parseImageRef, extractImageRefs, extractImageServices, compareImageDigests, fetchRemoteDigest } = await import('../src/services/image-updater.js');
const { flattenUpdateResults } = await import('../src/services/maintenance.js');
const { parseDockerDf, parseDockerDfOutput, pruneStorage } = await import('../src/services/docker-storage.js');
const { getActivityDocker } = await import('../src/services/docker-hosts.js');
const { removeDockerResource } = await import('../src/services/docker-resources.js');
const { renderBlueprintCompose, renderBlueprintEnv, getBlueprint, listBlueprints } = await import('../src/services/app-blueprints.js');
const { evaluateContainer, buildTitle, buildBody, stripDockerMultiplex } = await import('../src/services/health-alerter.js');
const { summarizePullImagesResult } = await import('../src/services/cron-scheduler.js');

test('cron pull-images: 全部成功时返回成功摘要', () => {
  assert.equal(summarizePullImagesResult(3, []), '已拉取 3 个项目的镜像');
});

test('cron pull-images: 部分失败必须抛错,使任务记录失败并触发告警', () => {
  assert.throws(
    () => summarizePullImagesResult(2, ['api', 'worker']),
    /部分失败: 2 个成功,2 个失败:api, worker/,
  );
});

test('cron pull-images: 全部失败必须抛错并保留失败项目', () => {
  assert.throws(
    () => summarizePullImagesResult(0, ['api', 'worker']),
    /全部失败:api, worker/,
  );
});

test('cron pull-images: 没有纳管项目时返回无工作摘要', () => {
  assert.equal(summarizePullImagesResult(0, []), '没有可拉取镜像的项目');
});


test('image-updater: parseImageRef 识别 registry/image/tag', () => {
  assert.deepEqual(parseImageRef('nginx:1.25'), { registry: 'docker.io', image: 'library/nginx', tag: '1.25', digest: null, original: 'nginx:1.25' });
  assert.deepEqual(parseImageRef('ghcr.io/gethomepage/homepage:latest'), { registry: 'ghcr.io', image: 'gethomepage/homepage', tag: 'latest', digest: null, original: 'ghcr.io/gethomepage/homepage:latest' });
  assert.deepEqual(parseImageRef('nginx'), { registry: 'docker.io', image: 'library/nginx', tag: 'latest', digest: null, original: 'nginx' });
  assert.deepEqual(parseImageRef('registry.example:5000/team/api:3.2'), { registry: 'registry.example:5000', image: 'team/api', tag: '3.2', digest: null, original: 'registry.example:5000/team/api:3.2' });
  assert.equal(parseImageRef(`ghcr.io/org/api@sha256:${'a'.repeat(64)}`).digest, `sha256:${'a'.repeat(64)}`);
  assert.equal(parseImageRef('${IMAGE}'), null);
});

test('image-updater: extractImageRefs 提取 compose 中 services.image', () => {
  const compose = `services:\n  web:\n    image: nginx:alpine\n  api:\n    image: ghcr.io/org/api:2.0\n  noimage:\n    build: ./app\n`;
  const refs = extractImageRefs(compose);
  assert.deepEqual(refs, ['nginx:alpine', 'ghcr.io/org/api:2.0']);
});

test('image-updater: 解析 YAML 服务来源、变量、pull_policy 和多文件覆盖', () => {
  const base = `services:\n  web:\n    image: nginx\n  api:\n    build: ./api\n  worker:\n    image: ghcr.io/org/worker:latest\n    build: ./worker\n  pinned:\n    image: ghcr.io/org/pinned@sha256:${'b'.repeat(64)}\n  templated:\n    image: '\${IMAGE_REF}'\n  config-only:\n    environment:\n      image: not-a-container-image\n`;
  const override = `services:\n  worker:\n    pull_policy: always\n  web:\n    image: nginx:1.27\n  local-only:\n    image: custom/api:dev\n    pull_policy: never\n  --unsafe:\n    image: alpine\n`;
  const services = extractImageServices([base, override]);
  const byName = Object.fromEntries(services.map((item) => [item.service, item]));
  assert.equal(byName.web.image, 'nginx:1.27');
  assert.equal(byName.web.status, 'remote');
  assert.equal(byName.api.status, 'local_build');
  assert.equal(byName.worker.status, 'remote');
  assert.equal(byName.pinned.status, 'pinned');
  assert.equal(byName.templated.status, 'unresolved');
  assert.equal(byName['local-only'].status, 'local_only');
  assert.equal(byName['--unsafe'].status, 'unresolved');
  assert.equal(byName['config-only'], undefined);
  assert.deepEqual(extractImageRefs([base, override]), ['nginx:1.27', 'ghcr.io/org/worker:latest']);
});

test('image-updater: 比较同一仓库的 RepoDigest；不把本地 Image ID 当作远端 digest', () => {
  const parsed = parseImageRef('nginx:latest');
  const digestA = `sha256:${'a'.repeat(64)}`;
  const digestB = `sha256:${'b'.repeat(64)}`;
  assert.deepEqual(compareImageDigests({ Id: digestA, RepoDigests: [`nginx@${digestA}`] }, digestA, parsed), {
    status: 'current', localDigest: digestA, remoteDigest: digestA, hasUpdate: false,
  });
  assert.deepEqual(compareImageDigests({ Id: digestA, RepoDigests: [`docker.io/library/nginx@${digestA}`] }, digestB, parsed), {
    status: 'updated', localDigest: digestA, remoteDigest: digestB, hasUpdate: true,
  });
  assert.equal(compareImageDigests(null, digestB, parsed).status, 'not_downloaded');
  assert.equal(compareImageDigests({ Id: digestA, RepoDigests: [] }, digestB, parsed).status, 'unknown');
});

test('image-updater: Docker Hub official image 的匿名 token 使用 library 仓库 scope，并请求 OCI manifest', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const digest = `sha256:${'c'.repeat(64)}`;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith('https://auth.docker.io/token?')) {
      return { ok: true, json: async () => ({ token: 'test-token' }) };
    }
    return { ok: true, headers: { get: (name) => (name.toLowerCase() === 'docker-content-digest' ? digest : null) } };
  };
  try {
    assert.equal(await fetchRemoteDigest(parseImageRef('nginx:alpine')), digest);
    assert.match(calls[0].url, /scope=repository%3Alibrary%2Fnginx%3Apull|scope=repository:library\/nginx:pull/);
    assert.match(calls[1].url, /\/v2\/library\/nginx\/manifests\/alpine$/);
    assert.match(calls[1].options.headers.Authorization, /^Bearer test-token$/);
    assert.match(calls[1].options.headers.Accept, /application\/vnd\.oci\.image\.index\.v1\+json/);
  } finally {
    // eslint-disable-next-line require-atomic-updates -- this test restores its temporary global fetch stub.
    globalThis.fetch = originalFetch;
  }
});

test('image-updater: 旧维护结果格式保留项目/服务，并将本地构建与检查失败分开', () => {
  const results = flattenUpdateResults([{ projectId: 'p1', projectName: 'demo', images: [
    { service: 'web', image: 'nginx:latest', hasUpdate: true, status: 'updated', localDigest: 'sha256:a', remoteDigest: 'sha256:b' },
    { service: 'api', image: '', hasUpdate: false, status: 'local_build', reason: 'build 配置' },
    { service: 'db', image: 'postgres:16', hasUpdate: false, status: 'failed', error: 'registry 401' },
  ] }]);
  assert.deepEqual(results.map(({ service, status }) => ({ service, status })), [
    { service: 'web', status: 'updated' }, { service: 'api', status: 'local_build' }, { service: 'db', status: 'failed' },
  ]);
  assert.equal(results[0].projectName, 'demo');
  assert.equal(results[2].error, 'registry 401');
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

test('docker-storage: scheduled 深度清理包含常规资源和构建缓存,但绝不清理数据卷', async () => {
  const docker = getActivityDocker();
  const originals = {
    pruneImages: docker.pruneImages,
    pruneContainers: docker.pruneContainers,
    pruneBuilds: docker.pruneBuilds,
    pruneVolumes: docker.pruneVolumes,
  };
  const calls = [];
  docker.pruneImages = async () => { calls.push('images'); return { SpaceReclaimed: 1024 }; };
  docker.pruneContainers = async () => { calls.push('containers'); return { SpaceReclaimed: 2048 }; };
  docker.pruneBuilds = async () => { calls.push('builds'); return { SpaceReclaimed: 4096 }; };
  docker.pruneVolumes = async () => { calls.push('volumes'); return { SpaceReclaimed: 8192 }; };
  try {
    const result = await pruneStorage('scheduled');
    assert.deepEqual(calls, ['images', 'containers', 'builds']);
    assert.equal(result.reclaimed.volumes, 0);
    assert.equal(result.reclaimedMB, 0);
    assert.equal(result.reclaimed.images, 1024);
    assert.equal(result.reclaimed.containers, 2048);
    assert.equal(result.reclaimed.buildCache, 4096);
  } finally {
    for (const [name, method] of Object.entries(originals)) {
      if (method === undefined) delete docker[name];
      else docker[name] = method;
    }
  }
});

test('docker-resources: 即使调用方传 force=true,镜像与数据卷也不强制删除', async () => {
  const docker = getActivityDocker();
  const originalGetImage = docker.getImage;
  const originalGetVolume = docker.getVolume;
  const calls = [];
  docker.getImage = (id) => ({ remove: async (options) => calls.push(['image', id, options]) });
  docker.getVolume = (id) => ({ remove: async (options) => calls.push(['volume', id, options]) });
  try {
    await removeDockerResource('image', 'image-id', true);
    await removeDockerResource('volume', 'volume-id', true);
    assert.deepEqual(calls, [
      ['image', 'image-id', { force: false }],
      ['volume', 'volume-id', { force: false }],
    ]);
  } finally {
    if (originalGetImage === undefined) delete docker.getImage;
    else docker.getImage = originalGetImage;
    if (originalGetVolume === undefined) delete docker.getVolume;
    else docker.getVolume = originalGetVolume;
  }
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
