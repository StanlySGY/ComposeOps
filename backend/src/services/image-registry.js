import { createHash } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { getSetting, setSetting } from '../lib/db.js';

const ACCEPT = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';
const DIGEST = /^sha256:[a-f0-9]{64}$/i;
const settingKey = 'updates.check_proxy';
export function normalizeCheckProxy(value = '') {
  if (typeof value !== 'string') throw Object.assign(new Error('代理地址必须为文本'), { statusCode: 400 });
  const text = value.trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { /* validated below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search || url.hash || (url.pathname && url.pathname !== '/'))
    throw Object.assign(new Error('请输入 HTTP/HTTPS 代理地址，例如 http://host.docker.internal:7890；地址不能包含账号、密码或路径'), { statusCode: 400 });
  return url.origin;
}
export function imageCheckSettings() {
  return { proxyUrl: getSetting(settingKey, '') };
}
export function saveImageCheckSettings(input) {
  const proxyUrl = normalizeCheckProxy(input.proxyUrl);
  setSetting(settingKey, proxyUrl);
  return { proxyUrl };
}

/** Per-check dispatcher: proxy settings never affect AI, sync, or Docker daemon traffic. */
export async function withRegistryTransport(proxyUrl, task) {
  const proxy = normalizeCheckProxy(proxyUrl);
  const dispatcher = proxy ? new ProxyAgent({ uri: proxy, connections: 6, connectTimeout: 10_000 }) : null;
  const request = (url, options = {}) => dispatcher ? undiciFetch(url, { ...options, dispatcher }) : fetch(url, options);
  try { return await task(request); }
  finally { if (dispatcher) await dispatcher.destroy(); }
}

export function registryError(error) {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return '镜像仓库响应超时，请检查代理或网络后重试';
  if (error.registryStatus === 401 || error.registryStatus === 403) return '仓库拒绝匿名访问：请核对镜像地址，私有镜像需要仓库授权';
  if (error.registryStatus === 404) return '远端仓库或标签不存在，请核对 Compose 镜像名称';
  if (error.registryStatus === 429) return '镜像仓库请求过于频繁，请稍后重试';
  if (error.message === 'fetch failed') return '连接镜像仓库失败，请检查代理地址及服务器网络';
  return error.message;
}
function statusError(status) {
  return Object.assign(new Error(`镜像仓库返回 HTTP ${status}`), { registryStatus: status });
}
export function parseBearerChallenge(header = '') {
  if (!/^Bearer\s/i.test(header)) return null;
  const parameters = Object.fromEntries([...header.matchAll(/(realm|service|scope)="([^"\r\n]*)"/gi)]
    .map((m) => [m[1].toLowerCase(), m[2]]));
  if (!parameters.realm) return null;
  const realm = new URL(parameters.realm);
  if (realm.protocol !== 'https:' || realm.username || realm.password || realm.hash)
    throw new Error('镜像仓库返回的授权地址不符合 HTTPS 要求');
  return { ...parameters, realm: realm.toString() };
}
function registryBase(registry) {
  return registry === 'docker.io' ? 'https://registry-1.docker.io' : `https://${registry}`;
}
async function discard(response) { await response.body?.cancel().catch(() => {}); }

/** Standard Registry v2 anonymous Bearer handshake, including GHCR and mirrors. */
export function createRegistryClient(request, signal) {
  const tokens = new Map();
  async function document(parsed, reference) {
    signal.throwIfAborted();
    const key = parsed.registry + '/' + parsed.image;
    const endpoint = `${registryBase(parsed.registry)}/v2/${parsed.image}/manifests/${reference}`;
    const headers = { Accept: ACCEPT };
    if (tokens.has(key)) headers.Authorization = 'Bearer ' + tokens.get(key);
    let response = await request(endpoint, { headers, signal, redirect: 'error' });
    if (response.status === 401) {
      const challenge = parseBearerChallenge(response.headers.get('www-authenticate') || '');
      await discard(response);
      if (!challenge) throw statusError(401);
      const tokenUrl = new URL(challenge.realm);
      if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
      // Scope always targets this repository, never requests the challenge's push scope.
      tokenUrl.searchParams.set('scope', `repository:${parsed.image}:pull`);
      const auth = await request(tokenUrl, { signal, redirect: 'error' });
      if (!auth.ok) { await discard(auth); throw statusError(auth.status); }
      const body = await auth.json();
      const token = body.token || body.access_token;
      if (typeof token !== 'string' || !token || token.length > 65536) throw new Error('仓库授权未返回有效令牌');
      tokens.set(key, token);
      response = await request(endpoint, { headers: { ...headers, Authorization: 'Bearer ' + token }, signal, redirect: 'error' });
    }
    if (!response.ok) { await discard(response); throw statusError(response.status); }
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > 8 * 1024 * 1024) throw new Error('镜像清单超过读取限制');
    const digest = 'sha256:' + createHash('sha256').update(raw).digest('hex');
    const declared = response.headers.get('docker-content-digest');
    if (declared && (!DIGEST.test(declared) || declared.toLowerCase() !== digest)) throw new Error('仓库镜像清单摘要校验失败');
    if (reference.startsWith('sha256:') && reference !== digest) throw new Error('平台镜像清单与声明摘要不一致');
    return { digest, data: JSON.parse(raw.toString('utf8')) };
  }
  return {
    document,
    async describe(parsed, platform) {
      const root = await document(parsed, parsed.digest || parsed.tag);
      let manifest = root;
      if (Array.isArray(root.data.manifests)) {
        const candidates = root.data.manifests.filter((m) => m.platform?.os === platform.os && m.platform?.architecture === platform.architecture);
        const selected = candidates.find((m) => (m.platform.variant || '') === (platform.variant || '')) || (!platform.variant && candidates.length === 1 ? candidates[0] : null);
        if (!selected || !DIGEST.test(selected.digest)) throw new Error(`远端标签未提供当前平台 ${platform.os}/${platform.architecture}${platform.variant ? '/' + platform.variant : ''}`);
        manifest = await document(parsed, selected.digest);
      }
      const configDigest = manifest.data.config?.digest;
      return { digest: root.digest, platformDigest: manifest.digest, configDigest: DIGEST.test(configDigest || '') ? configDigest : null };
    },
  };
}
export async function fetchRemoteDescription(parsed, { signal, proxyUrl = imageCheckSettings().proxyUrl, platform } = {}) {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
  return withRegistryTransport(proxyUrl, (request) => createRegistryClient(request, bounded).describe(parsed, platform));
}
export async function fetchRemoteDigest(parsed, { signal, proxyUrl = imageCheckSettings().proxyUrl } = {}) {
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
  return withRegistryTransport(proxyUrl, async (request) => (await createRegistryClient(request, bounded).document(parsed, parsed.digest || parsed.tag)).digest);
}
export async function testImageCheckProxy(input) {
  const proxyUrl = normalizeCheckProxy(input.proxyUrl);
  const targets = [
    { name: 'Docker Hub', registry: 'docker.io', image: 'library/nginx', tag: 'alpine' },
    { name: 'GHCR', registry: 'ghcr.io', image: 'gethomepage/homepage', tag: 'latest' },
  ];
  const results = await Promise.all(targets.map(async (target) => {
    const start = Date.now();
    try {
      const digest = await fetchRemoteDigest(target, { proxyUrl });
      return { name: target.name, ok: true, milliseconds: Date.now() - start, digest };
    } catch (error) { return { name: target.name, ok: false, milliseconds: Date.now() - start, message: registryError(error) }; }
  }));
  return { ok: results.every((r) => r.ok), results };
}
