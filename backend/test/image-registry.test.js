import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
const directory = await mkdtemp(path.join(os.tmpdir(), 'registry-check-'));
process.env.DB_PATH = path.join(directory, 'registry.db');
const { createRegistryClient, withRegistryTransport, normalizeCheckProxy, saveImageCheckSettings, imageCheckSettings } = await import('../src/services/image-registry.js');
const { compareRunningImage, classifyImageService, getProjectUpdates } = await import('../src/services/image-updater.js');
const sha = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex');
const response = (data) => {
  const text = JSON.stringify(data);
  return new Response(text, { headers: { 'docker-content-digest': sha(text) } });
};
test('GHCR 匿名授权使用实际仓库 pull scope，token 不进入结果', async () => {
  const calls = [];
  const client = createRegistryClient(async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers?.Authorization });
    if (String(url).startsWith('https://ghcr.io/token')) return Response.json({ access_token: 'do-not-expose' });
    if (!options.headers.Authorization) return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:wrong/image:push,pull"' } });
    return response({ schemaVersion: 2, config: { digest: 'sha256:' + 'a'.repeat(64) } });
  }, AbortSignal.timeout(1000));
  const result = await client.describe({ registry: 'ghcr.io', image: 'real/app', tag: 'latest' }, { os: 'linux', architecture: 'amd64' });
  assert.equal(result.configDigest, 'sha256:' + 'a'.repeat(64));
  assert.equal(new URL(calls[1].url).searchParams.get('scope'), 'repository:real/app:pull');
  assert.equal(calls[2].authorization, 'Bearer do-not-expose');
  assert.equal(JSON.stringify(result).includes('do-not-expose'), false);
});
test('多平台标签选择当前平台，以配置摘要比较运行镜像，兼容镜像加速仓库', async () => {
  const configId = 'sha256:' + 'a'.repeat(64);
  const amd64 = { schemaVersion: 2, config: { digest: configId } };
  const manifestDigest = sha(JSON.stringify(amd64));
  const calls = [];
  const client = createRegistryClient(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/latest')) return response({ manifests: [
      { digest: 'sha256:' + 'b'.repeat(64), platform: { os: 'linux', architecture: 'arm64' } },
      { digest: manifestDigest, platform: { os: 'linux', architecture: 'amd64' } },
    ] });
    return response(amd64);
  }, AbortSignal.timeout(1000));
  const remote = await client.describe({ registry: 'docker.io', image: 'library/nginx', tag: 'latest' }, { os: 'linux', architecture: 'amd64' });
  assert.ok(calls[1].endsWith(manifestDigest));
  const local = { Id: configId, RepoDigests: ['mirror.local/library/nginx@sha256:' + 'c'.repeat(64)] };
  assert.equal(compareRunningImage(local, remote, {}).status, 'current');
  assert.equal(compareRunningImage({ ...local, Id: 'sha256:' + 'd'.repeat(64) }, remote, {}).status, 'updated');
});
test('清单摘要错误和当前平台缺失不能误报已是最新', async () => {
  const corrupt = createRegistryClient(async () => new Response('{}', { headers: { 'docker-content-digest': 'sha256:' + 'f'.repeat(64) } }), AbortSignal.timeout(1000));
  await assert.rejects(corrupt.document({ registry: 'ghcr.io', image: 'a/b' }, 'latest'), /摘要校验失败/);
  const noPlatform = createRegistryClient(async () => response({ manifests: [] }), AbortSignal.timeout(1000));
  await assert.rejects(noPlatform.describe({ registry: 'ghcr.io', image: 'a/b', tag: 'latest' }, { os: 'linux', architecture: 'amd64' }), /未提供当前平台/);
});
test('本地构建仍要求明确拉取策略，不能因只读检测改变升级边界', () => {
  assert.equal(classifyImageService({ service: 'web', image: 'web:latest', build: true }).status, 'needs_policy');
  assert.equal(classifyImageService({ service: 'web', image: 'web:latest', build: true, pullPolicy: 'always' }).status, 'remote');
  assert.equal(classifyImageService({ service: 'web', image: 'web:latest', pullPolicy: 'never' }).status, 'local_only');
});

test('代理地址持久化，不接受认证文本、路径或 SOCKS 地址', () => {
  assert.equal(normalizeCheckProxy(' http://host.docker.internal:7890/ '), 'http://host.docker.internal:7890');
  for (const value of ['socks5://localhost:7890', 'http://user:secret@localhost:7890', 'http://localhost:7890/path']) assert.throws(() => normalizeCheckProxy(value));
  saveImageCheckSettings({ proxyUrl: 'http://localhost:7890' });
  assert.equal(imageCheckSettings().proxyUrl, 'http://localhost:7890');
  saveImageCheckSettings({ proxyUrl: '' });
});
test('真实 HTTP 请求经过配置的代理，不改变全局 fetch', async () => {
  const originalFetch = globalThis.fetch;
  const target = http.createServer((_req, res) => res.end('proxy-proof'));
  const proxy = http.createServer((req, res) => {
    forwarded++;
    const url = new URL(req.url);
    const outbound = http.get(url, (response) => { res.writeHead(response.statusCode); response.pipe(res); });
    outbound.on('error', () => res.destroy());
  });
  let forwarded = 0;
  proxy.on('connect', (req, socket, head) => {
    forwarded++;
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const result = await withRegistryTransport('http://127.0.0.1:' + proxy.address().port, async (request) => {
      const res = await request('http://127.0.0.1:' + target.address().port, { signal: AbortSignal.timeout(2000) });
      return res.text();
    });
    assert.equal(result, 'proxy-proof');
    assert.equal(forwarded, 1);
    assert.equal(globalThis.fetch, originalFetch);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  }
});
test('Compose 变量展开后按容器实际镜像 ID 比较，不能误用已被更新的标签', async () => {
  const { getActivityDocker } = await import('../src/services/docker-hosts.js');
  const docker = getActivityDocker();
  const original = { list: docker.listContainers, image: docker.getImage, fetch: globalThis.fetch };
  const root = path.join(directory, 'app');
  await mkdir(root);
  const file = path.join(root, 'compose.yml');
  await writeFile(file, 'services:\n  web:\n    image: ${APP_IMAGE}\n');
  await writeFile(path.join(root, '.env'), 'APP_IMAGE=registry.example.com/app/web:latest\n');
  const imageId = 'sha256:' + 'a'.repeat(64);
  const calls = [];
  docker.listContainers = async () => [{ Id: 'container-proof', ImageID: imageId, Image: 'registry.example.com/app/web:latest', Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.project.working_dir': root, 'com.docker.compose.service': 'web' } }];
  docker.getImage = (id) => { calls.push(id); return { inspect: async () => ({ Id: imageId, Os: 'linux', Architecture: 'amd64' }) }; };
  globalThis.fetch = async () => response({ schemaVersion: 2, config: { digest: imageId } });
  try {
    const result = await getProjectUpdates({ id: 'interpolated-proof', projectName: 'app', workingDir: root, mounted: true, composeFiles: [file] }, { force: true });
    assert.equal(result.images[0].image, 'registry.example.com/app/web:latest');
    assert.equal(result.images[0].status, 'current');
    assert.deepEqual(calls, [imageId]);
    const remoteId = 'sha256:' + 'b'.repeat(64);
    docker.getImage = id => { calls.push(id); return { inspect: async () => ({ Id: id === imageId ? imageId : remoteId, Os: 'linux', Architecture: 'amd64' }) }; };
    globalThis.fetch = async () => response({ schemaVersion: 2, config: { digest: remoteId } });
    const updated = await getProjectUpdates({ id: 'interpolated-proof', projectName: 'app', workingDir: root, mounted: true, composeFiles: [file] }, { force: true });
    assert.equal(updated.images[0].status, 'updated');
    assert.equal(updated.images[0].hasUpdate, true);
    assert.deepEqual(calls, [imageId, imageId]);
  } finally {
    docker.listContainers = original.list;
    docker.getImage = original.image;
    // eslint-disable-next-line require-atomic-updates -- restore the test network stub.
    globalThis.fetch = original.fetch;
  }
});
test.after(async () => {
  const { default: db } = await import('../src/lib/db.js');
  db.close();
  await rm(directory, { recursive: true, force: true });
});
