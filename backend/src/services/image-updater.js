import { readFile, writeFile } from 'fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { setSetting, addComposeBackupBatch, addOperation, COMPOSE_BACKUP_KEEP } from '../lib/db.js';
import { readCompose, spawnComposeCommand, composeProjectOptions } from './compose-runner.js';
import { getProjectDocker } from './docker-hosts.js';
import { withRunner, withReadOnlyRunner, readArchiveFile, putArchiveFile, execInRunner } from './compose-workspace.js';
import { withProjectOperationLock } from './project-operation-lock.js';

import { fetchRemoteDescription, imageCheckSettings, registryError } from './image-registry.js';
export { fetchRemoteDigest } from './image-registry.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h,避免 Registry Rate Limit
const cache = new Map(); // projectId -> { ts, data }

/** 解析 Docker 镜像引用。变量、无效引用返回 null；无标签引用按 latest 处理。 */
export function parseImageRef(ref = '') {
  const cleaned = String(ref).trim().replace(/^["']|["']$/g, '');
  if (!cleaned || cleaned.startsWith('#') || /[\s\\${}]/.test(cleaned)) return null;
  const at = cleaned.indexOf('@');
  if (at !== -1 && cleaned.indexOf('@', at + 1) !== -1) return null;
  const digest = at === -1 ? null : cleaned.slice(at + 1);
  if (digest && !/^[A-Za-z][A-Za-z0-9_+.-]*:[a-fA-F0-9]+$/.test(digest)) return null;
  let image = at === -1 ? cleaned : cleaned.slice(0, at);
  if (!image) return null;
  let tag = 'latest';
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  if (lastColon > lastSlash) {
    const candidate = image.slice(lastColon + 1);
    if (!/^[\w][\w.-]*$/.test(candidate)) return null;
    tag = candidate;
    image = image.slice(0, lastColon);
  }
  if (!image || image.startsWith('/') || image.endsWith('/')) return null;
  let registry = 'docker.io';
  const firstSlash = image.indexOf('/');
  if (firstSlash > -1) {
    const maybeReg = image.slice(0, firstSlash);
    if (maybeReg.includes('.') || maybeReg.includes(':') || maybeReg === 'localhost') {
      registry = maybeReg;
      image = image.slice(firstSlash + 1);
    }
  }
  if (registry === 'docker.io' && !image.includes('/')) image = `library/${image}`;
  if (!image || image.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return { registry, image, tag, digest, original: cleaned };
}

export function classifyImageService(service) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service.service)) {
    return { ...service, status: 'unresolved', reason: '服务名称格式不支持安全的自动升级' };
  }
  if (!service.image) return service.build
    ? { ...service, status: 'local_build', reason: '服务通过 build 配置本地构建' }
    : { ...service, status: 'unsupported', reason: '服务没有 image 配置' };
  if (service.build && service.pullPolicy !== 'always') {
    return service.pullPolicy
      ? { ...service, status: 'local_build', reason: `pull_policy=${service.pullPolicy}，不按远端镜像更新处理` }
      : { ...service, status: 'needs_policy', reason: '同时配置了 image 和 build，请明确设置 pull_policy 后再探测远端更新' };
  }
  if (service.pullPolicy === 'never') {
    return service.build
      ? { ...service, status: 'local_build', reason: 'pull_policy=never，优先使用本地构建镜像' }
      : { ...service, status: 'local_only', reason: 'pull_policy=never，仅使用已存在的本地镜像' };
  }
  if (service.pullPolicy === 'build') {
    return { ...service, status: 'local_build', reason: `pull_policy=${service.pullPolicy}，不检查远端更新` };
  }
  const parsed = parseImageRef(service.image);
  if (!parsed) return { ...service, status: 'unresolved', reason: '镜像引用包含变量或格式无法识别' };
  if (parsed.digest) return { ...service, parsed, status: 'pinned', reason: '镜像已固定到 digest；更新需修改 Compose 配置' };
  return { ...service, parsed, status: 'remote' };
}

/** 解析并合并 Compose 文件中的服务镜像字段，避免误读注释/环境变量中的 image 文本。 */
export function extractImageServices(composeContents = '') {
  const contents = (Array.isArray(composeContents) ? composeContents : [composeContents]).filter((item) => typeof item === 'string');
  const services = new Map();
  for (const content of contents) {
    const document = parseYaml(content);
    for (const [name, config] of Object.entries(document?.services || {})) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
      const current = services.get(name) || { service: name, image: null, build: false, pullPolicy: null };
      if (Object.hasOwn(config, 'image')) current.image = typeof config.image === 'string' ? config.image.trim() : null;
      if (Object.hasOwn(config, 'build')) current.build = config.build !== null && config.build !== false;
      if (Object.hasOwn(config, 'pull_policy')) current.pullPolicy = String(config.pull_policy || '').toLowerCase();
      services.set(name, current);
    }
  }
  return [...services.values()].map(classifyImageService).filter((item) => item.status !== 'unsupported');
}

/** 兼容旧调用方：只返回策略明确为远端可探测的镜像引用。 */
export function extractImageRefs(composeContent = '') {
  return [...new Set(extractImageServices(composeContent)
    .filter((item) => item.status === 'remote')
    .map((item) => item.parsed.original))];
}

// Bound waiting even if a Docker transport ignores its abort signal. The work is
// read-only; a late result must never resume the check or replace cached data.
async function waitForCheck(task, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return task(); }), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function localImageInfo(docker, image, signal) {
  try {
    return await waitForCheck(() => docker.getImage(image).inspect({ abortSignal: signal }), signal);
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

function normalizeRepository(value) {
  let name = String(value || '').split('@')[0];
  if (name.startsWith('index.docker.io/')) name = `docker.io/${name.slice('index.docker.io/'.length)}`;
  if (name.startsWith('docker.io/')) {
    const rest = name.slice('docker.io/'.length);
    return `docker.io/${rest.includes('/') ? rest : `library/${rest}`}`;
  }
  const first = name.split('/')[0];
  if (first.includes('.') || first.includes(':') || first === 'localhost') return name;
  return `docker.io/${name.includes('/') ? name : `library/${name}`}`;
}

/** 只在同一 Registry/repository 的 RepoDigest 与远端 manifest digest 之间作比较。 */
export function compareImageDigests(localInfo, remoteDigest, parsed) {
  if (!localInfo) return { status: 'not_downloaded', localDigest: null, remoteDigest, hasUpdate: true };
  const expectedRepo = normalizeRepository(`${parsed.registry}/${parsed.image}`);
  const repoDigest = (localInfo.RepoDigests || []).find((value) => {
    const [repo, digest] = String(value).split('@');
    return !!digest && normalizeRepository(repo) === expectedRepo;
  });
  if (!repoDigest) {
    return { status: 'unknown', localDigest: null, localImageId: localInfo.Id || null, remoteDigest, hasUpdate: false, reason: '本地镜像没有同一仓库的 RepoDigest，无法可靠比较' };
  }
  const localDigest = repoDigest.split('@').at(-1);
  const same = localDigest === remoteDigest;
  return { status: same ? 'current' : 'updated', localDigest, remoteDigest, hasUpdate: !same };
}

/** Image config SHA is the running image ID, even when it was pulled via a mirror. */
export function compareRunningImage(localInfo, remote, parsed) {
  if (!localInfo) return { status: 'unknown', hasUpdate: false, reason: '无法读取容器正在使用的本地镜像' };
  const config = remote.configDigest;
  if (config) {
    return { status: localInfo.Id === config ? 'current' : 'updated', hasUpdate: localInfo.Id !== config,
      localImageId: localInfo.Id, remoteImageId: config, remoteDigest: remote.digest, platformDigest: remote.platformDigest,
      reason: '已按当前平台的镜像内容与容器实际使用的镜像比较' };
  }
  const compared = compareImageDigests(localInfo, remote.digest, parsed);
  if (compared.status === 'unknown') {
    const digest = (localInfo.RepoDigests || []).map((d) => d.split('@').at(-1));
    if (digest.includes(remote.digest) || digest.includes(remote.platformDigest))
      return { status: 'current', hasUpdate: false, remoteDigest: remote.digest, localImageId: localInfo.Id };
  }
  return compared;
}

function environmentArgs(containers) {
  return [...new Set(containers.flatMap((c) => String(c.Labels?.['com.docker.compose.project.environment_file'] || '').split(',').filter(Boolean)))].flatMap((file) => ['--env-file', file]);
}
async function resolvedImageServices(project, containers, signal) {
  const args = [...environmentArgs(containers), 'config', '--format', 'json', '--no-env-resolution'];
  let output;
  if (project.mounted) {
    output = await new Promise((resolve, reject) => {
      const child = spawnComposeCommand(project, args);
      let text = '';
      const stop = () => { child.kill('SIGTERM'); reject(signal.reason); };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      child.stdout.on('data', (chunk) => {
        text += chunk;
        if (text.length > 8 * 1024 * 1024) { child.kill('SIGTERM'); reject(new Error('Compose 模型过大')); }
      });
      // Config output can contain secrets: never echo stderr or the model in responses/logs.
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) => {
        signal.removeEventListener('abort', stop);
        code === 0 ? resolve(text) : reject(new Error('Compose 镜像变量展开失败'));
      });
    });
  } else {
    output = await withReadOnlyRunner(project, async (container) => {
      signal.throwIfAborted();
      let cancel;
      try {
        const result = await execInRunner(container,
          ['docker', 'compose', ...composeProjectOptions(project), ...args], { timeoutMs: 10_000, onExec: handle => {
            cancel = () => handle.kill();
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
          } });
        if (result.code !== 0) throw new Error('Compose 镜像变量展开失败');
        return result.stdout;
      } finally { if (cancel) signal.removeEventListener('abort', cancel); }
    });
  }
  signal.throwIfAborted();
  const model = JSON.parse(output);
  return extractImageServices(JSON.stringify({ services: model.services || {} }));
}

export function clearImageUpdateCache() { cache.clear(); }

async function readProjectComposeContents(project) {
  const files = Array.isArray(project.composeFiles) && project.composeFiles.length ? project.composeFiles : [project.composeFile].filter(Boolean);
  if (!files.length) throw new Error('项目没有可读取的 Compose 文件');
  if (project.mounted) {
    const contents = [];
    for (let i = 0; i < files.length; i += 1) contents.push((await readCompose(project, i)).content);
    return contents;
  }
  if (project.workspaceAvailable) {
    return withReadOnlyRunner(project, async (container) => Promise.all(files.map(async (file) => {
      const { content } = await readArchiveFile(container, file);
      return content;
    })));
  }
  throw Object.assign(new Error('当前项目的 Compose 文件不可读，无法安全检查镜像来源'), { statusCode: 409 });
}

/** 单项目镜像更新检测(带 1h 缓存)。 */
export async function getProjectUpdates(project, { force = false, signal: callerSignal, timeoutMs = 30_000 } = {}) {
  if (!project?.managed || !project.editable) throw Object.assign(new Error('镜像检查需要已纳管并启用 Compose 目录能力的项目'), { statusCode: 403 });
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new TypeError('镜像检查期限必须为 1–30000 毫秒');
  const signal = AbortSignal.any([...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(timeoutMs)]);
  signal?.throwIfAborted();
  const docker = getProjectDocker(project);
  const containers = (await waitForCheck(() => docker.listContainers({ all: true, abortSignal: signal }), signal)).filter((c) =>
    !c.Labels?.['composeops.helper'] && c.Labels?.['com.docker.compose.project'] === project.projectName &&
    c.Labels?.['com.docker.compose.project.working_dir'] === project.workingDir);
  let services;
  try { services = await waitForCheck(() => resolvedImageServices(project, containers, signal), signal); }
  catch {
    signal.throwIfAborted();
    services = extractImageServices(await waitForCheck(() => readProjectComposeContents(project), signal));
  }
  signal?.throwIfAborted();
  const { proxyUrl } = imageCheckSettings();
  const fingerprint = createHash('sha256').update(JSON.stringify({ hostId: project.hostId, proxyUrl, services,
    containers: containers.map((c) => [c.Id, c.ImageID || c.Image]).sort((a, b) => a[0].localeCompare(b[0])),
  })).digest('hex');
  const cached = cache.get(project.id);
  if (!force && cached?.fingerprint === fingerprint && Date.now() - cached.ts < cached.ttl) return cached.data;
  const remoteDigests = new Map();
  const localImages = new Map();
  async function checkService(service) {
    callerSignal?.throwIfAborted();
    const item = { service: service.service, image: service.image || '', status: service.status, hasUpdate: false, localDigest: null, remoteDigest: null, reachable: false, canUpgrade: service.canUpgrade !== false, reason: service.reason || '' };
    if (service.status !== 'remote') {
      item.reachable = service.status === 'local_build' || service.status === 'pinned';
      return item;
    }
    const { parsed } = service;
    item.registry = parsed.registry;
    item.tag = parsed.tag;
    try {
      const members = containers.filter((c) => c.Labels?.['com.docker.compose.service'] === service.service);
      if (!members.length) {
        item.status = 'not_deployed';
        item.reason = '服务尚未创建容器，没有正在使用的镜像可比较';
        return item;
      }
      signal.throwIfAborted();
      const results = [];
      for (const container of members) {
        // Inspect by immutable ID: the tag may already point to a newer, unused image.
        signal.throwIfAborted();
        const imageId = container.ImageID || (await waitForCheck(() => docker.getContainer(container.Id).inspect({ abortSignal: signal }), signal)).Image;
        if (!localImages.has(imageId)) localImages.set(imageId, localImageInfo(docker, imageId, signal));
        const local = await localImages.get(imageId);
        const platform = { os: local?.Os || 'linux', architecture: local?.Architecture || 'amd64', variant: local?.Variant || '' };
        const key = parsed.original + JSON.stringify(platform);
        if (!remoteDigests.has(key)) remoteDigests.set(key, waitForCheck(() => fetchRemoteDescription(parsed, { signal, proxyUrl, platform }), signal));
        const remote = await remoteDigests.get(key);
        results.push({ containerId: container.Id, ...compareRunningImage(local, remote, parsed) });
      }
      const representative = results.find((r) => r.hasUpdate) || results.find((r) => r.status === 'unknown') || results[0];
      Object.assign(item, representative, { containers: results, reachable: true, reason: [service.reason, representative.reason].filter(Boolean).join('；') });
    } catch (error) {
      // A caller cancellation aborts the whole request. Our own deadline keeps
      // completed results and marks all unfinished services explicitly failed.
      callerSignal?.throwIfAborted();
      item.status = service.build && [401, 403, 404].includes(error.registryStatus) ? 'local_build' : 'failed';
      item.error = item.status === 'local_build' ? '' : signal.aborted
        ? '本次检查已到期限，该服务未完成比较；请稍后重新检查'
        : registryError(error);
      if (item.status === 'local_build') item.reason = '本地构建镜像的远端标签不可匿名读取；更新需按项目源码构建';
      item.reachable = false;
    }
    return item;
  }
  const images = new Array(services.length);
  let next = 0;
  async function worker() {
    while (next < services.length) {
      const index = next++;
      images[index] = await checkService(services[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, services.length) }, worker));
  const data = {
    projectId: project.id,
    projectName: project.projectName,
    checkedAt: Date.now(),
    images,
    hasUpdate: images.some((item) => item.hasUpdate),
    incomplete: images.some((item) => item.status === 'failed'),
  };
  callerSignal?.throwIfAborted();
  if (imageCheckSettings().proxyUrl === proxyUrl)
    cache.set(project.id, { ts: Date.now(), data, fingerprint, ttl: images.some((i) => i.status === 'failed') ? 30_000 : CACHE_TTL_MS });
  return data;
}

/** 全局检测所有可编辑项目(并发 3)。 */
export async function checkAllUpdates({ signal } = {}) {
  signal?.throwIfAborted();
  const { scanAllProjects: scanProjects } = await import('./scanner.js');
  const projects = (await scanProjects()).filter((project) => project.editable);
  signal?.throwIfAborted();
  const results = [];
  const queue = [...projects];
  async function worker() {
    while (queue.length) {
      signal?.throwIfAborted();
      const project = queue.shift();
      try {
        results.push(await getProjectUpdates(project, { force: true, signal }));
      } catch (error) {
        signal?.throwIfAborted();
        // 全局巡检不能把读取 Compose / YAML 解析失败的项目静默当成“无更新”。
        results.push({
          projectId: project.id,
          projectName: project.projectName,
          checkedAt: Date.now(),
          images: [{ service: 'Compose 文件', image: '—', status: 'failed', hasUpdate: false, reachable: false, error: error.message }],
          hasUpdate: false,
          error: error.message,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, projects.length) }, () => worker()));
  signal?.throwIfAborted();
  setSetting('updates.last_radar_check', String(Date.now()));
  return { projects: results };
}

async function writeUpgradeBackups(project) {
  const files = Array.isArray(project.composeFiles) && project.composeFiles.length
    ? project.composeFiles
    : [project.composeFile].filter(Boolean);
  if (!files.length) throw Object.assign(new Error('项目没有可备份的 Compose 配置文件'), { statusCode: 409 });
  if (files.length > COMPOSE_BACKUP_KEEP) throw Object.assign(new Error('Compose 文件数量超过备份保留上限，已中止升级'), { statusCode: 409 });

  const snapshots = [];
  try {
    if (project.mounted) {
      for (const file of files) snapshots.push({ file, content: await readFile(file, 'utf8') });
    } else if (project.workspaceAvailable) {
      await withRunner(project, async (container) => {
        for (const file of files) {
          const { content } = await readArchiveFile(container, file);
          snapshots.push({ file, content });
        }
      });
    } else {
      throw new Error('当前项目没有可读取 Compose 文件的挂载或工作区');
    }
  } catch (error) {
    throw Object.assign(new Error('无法完整备份升级前 Compose 配置：' + error.message), { statusCode: 409 });
  }

  if (snapshots.length !== files.length || snapshots.some((item) => typeof item.content !== 'string')) {
    throw Object.assign(new Error('升级前 Compose 配置备份不完整，已中止升级'), { statusCode: 409 });
  }

  const backupReason = 'upgrade:' + Date.now() + ':' + randomBytes(3).toString('hex');
  try {
    addComposeBackupBatch(project.id, snapshots.map((snapshot) => ({
      filePath: snapshot.file,
      content: snapshot.content,
    })), backupReason);
  } catch (error) {
    throw Object.assign(new Error('无法原子保存完整的升级前 Compose 备份，已中止升级：' + error.message), { statusCode: 409 });
  }
  return snapshots;
}

/**
 * 平滑升级:备份 -> compose pull -> up -d -> 健康轮询(15s)。
 * 返回 { code, upgraded, degraded, rollbackAvailable, backups }。
 * 持项目操作锁:升级的 pull/up 与停止/重启/env.apply 并发会互相踩踏。
 */
export async function upgradeProject(project, options = {}) {
  if (!project?.managed || !project.editable) {
    throw Object.assign(new Error('当前节点下该项目不支持平滑升级(需要 Compose 能力)'), { statusCode: 403 });
  }
  if (!Array.isArray(options.services) || !options.services.length || options.services.some((service) => typeof service !== 'string' || !service.trim())) {
    throw Object.assign(new Error('请至少选择一个有更新的 Compose 服务'), { statusCode: 400 });
  }
  if (new Set(options.services).size !== options.services.length) {
    throw Object.assign(new Error('升级服务列表包含重复项'), { statusCode: 400 });
  }
  return withProjectOperationLock(project.id, () => upgradeProjectLocked(project, options));
}

async function upgradeProjectLocked(project, { services, onOutput = () => {}, onChild = () => {} } = {}) {
  const latest = await getProjectUpdates(project, { force: true });
  const updateable = new Set(latest.images.filter((item) => item.hasUpdate).map((item) => item.service));
  const selected = [...new Set(services || [])];
  const stale = selected.filter((service) => !updateable.has(service));
  if (stale.length) {
    throw Object.assign(new Error(`这些服务当前没有可确认的镜像更新，请重新检查：${stale.join(', ')}`), { statusCode: 409 });
  }
  const backups = await writeUpgradeBackups(project);
  const expectedComposeFiles = Array.isArray(project.composeFiles) && project.composeFiles.length
    ? project.composeFiles
    : [project.composeFile].filter(Boolean);
  if (!expectedComposeFiles.length || backups.length !== expectedComposeFiles.length) {
    throw Object.assign(new Error('升级前 Compose 配置备份不完整，已中止升级；未执行镜像拉取或容器重建'), { statusCode: 409 });
  }
  const { spawnComposeCommand } = await import('./compose-runner.js');
  const { runWorkspaceComposeArgs } = await import('./compose-workspace.js');
  let code;
  if (project.mounted) {
    code = await runStep(spawnComposeCommand(project, ['pull', ...selected]), onOutput, onChild);
    if (code !== 0) return { code, upgraded: false, degraded: true, rollbackAvailable: backups.length > 0, backups };
    code = await runStep(spawnComposeCommand(project, ['up', '-d', '--no-deps', ...selected]), onOutput, onChild);
  } else {
    code = await runWorkspaceComposeArgs(project, ['pull', ...selected], onOutput);
    if (code !== 0) return { code, upgraded: false, degraded: true, rollbackAvailable: backups.length > 0, backups };
    code = await runWorkspaceComposeArgs(project, ['up', '-d', '--no-deps', ...selected], onOutput);
  }
  if (code !== 0) return { code, upgraded: false, degraded: true, rollbackAvailable: backups.length > 0, backups };

  // 健康轮询 15s:全部 running 且(如有 health)非 unhealthy 视为健康
  const docker = getProjectDocker(project);
  const deadline = Date.now() + 15000;
  let degraded = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const currentContainers = await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${project.projectName}`] } });
    const targets = currentContainers.filter((item) => selected.includes(item.Labels?.['com.docker.compose.service']));
    const checks = await Promise.all(targets.map(async (item) => {
      try {
        const inspection = await docker.getContainer(item.Id).inspect();
        const state = inspection.State || {};
        const health = state.Health?.Status === 'healthy' || !state.Health;
        const running = state.Status === 'running';
        return { id: item.Id, name: (item.Names?.[0] || '').replace(/^\//, ''), ok: running && health };
      } catch { return { id: item.Id, name: (item.Names?.[0] || '').replace(/^\//, ''), ok: false }; }
    }));
    degraded = checks.length === 0 || checks.some((item) => !item.ok);
    if (!degraded) break;
  }
  addOperation({
    projectId: project.id,
    projectName: project.projectName,
    action: 'images.upgrade',
    status: degraded ? 'failed' : 'success',
    detail: degraded ? `所选服务升级后未通过健康检查：${selected.join(', ')}` : `已升级并通过健康检查：${selected.join(', ')}`,
  });
  cache.delete(project.id);
  return { code, upgraded: true, degraded, services: selected, rollbackAvailable: backups.length > 0, backups };
}

function runStep(child, onOutput, onChild) {
  return new Promise((resolve, reject) => {
    onChild(child);
    child.stdout.on('data', (chunk) => onOutput('stdout', chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => onOutput('stderr', chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
  });
}

/** 恢复前要求当前 Compose 文件集与备份批次一一对应，避免混用新旧配置。 */
export function hasMatchingComposeBackupFiles(backups = [], files = []) {
  if (!Array.isArray(backups) || !Array.isArray(files) || !files.length || backups.length !== files.length) return false;
  const backupFiles = new Set(backups.map((item) => item?.filePath).filter((file) => typeof file === 'string'));
  const currentFiles = new Set(files);
  return backupFiles.size === backups.length
    && currentFiles.size === files.length
    && backupFiles.size === currentFiles.size
    && [...backupFiles].every((file) => currentFiles.has(file));
}

/** 从备份列表中选择最近一次完整升级批次；兼容旧版按时间戳分组的 upgrade 记录。 */
export function selectLatestUpgradeBackupBatch(backups = []) {
  const upgrades = (Array.isArray(backups) ? backups : []).filter((item) => (
    item?.reason === 'upgrade' || (typeof item?.reason === 'string' && item.reason.startsWith('upgrade:'))
  ));
  const latest = upgrades[0];
  if (!latest) return [];
  return upgrades.filter((item) => item.reason === latest.reason && (
    latest.reason !== 'upgrade' || item.createdAt === latest.createdAt
  ));
}

/**
 * 按批次恢复 Compose 内容；某个文件写入失败时，尽力将已触及文件恢复到操作前内容。
 * currentContents 必须在任何写入发生前完整读取，避免读取失败后留下半批恢复。
 */
export async function restoreComposeBackupBatch(backups, currentContents, writeContent) {
  if (!Array.isArray(backups) || !backups.length || !Array.isArray(currentContents)
    || backups.length !== currentContents.length || typeof writeContent !== 'function') {
    throw Object.assign(new Error('Compose 恢复批次不完整'), { statusCode: 409 });
  }
  const currentByPath = new Map();
  for (const snapshot of currentContents) {
    if (!snapshot || typeof snapshot.filePath !== 'string' || typeof snapshot.content !== 'string'
      || currentByPath.has(snapshot.filePath)) {
      throw Object.assign(new Error('当前 Compose 配置快照不完整或包含重复文件'), { statusCode: 409 });
    }
    currentByPath.set(snapshot.filePath, snapshot);
  }
  if (backups.some((backup) => !backup || typeof backup.filePath !== 'string'
    || typeof backup.content !== 'string' || !currentByPath.has(backup.filePath))
    || new Set(backups.map((backup) => backup.filePath)).size !== backups.length) {
    throw Object.assign(new Error('升级备份与当前 Compose 配置快照不匹配'), { statusCode: 409 });
  }

  const attempted = [];
  try {
    for (const backup of backups) {
      attempted.push(backup.filePath);
      await writeContent(backup.filePath, backup.content, currentByPath.get(backup.filePath));
    }
  } catch (error) {
    const compensationFailures = [];
    for (const filePath of attempted.reverse()) {
      try {
        const previous = currentByPath.get(filePath);
        await writeContent(filePath, previous.content, previous);
      } catch (restoreError) {
        compensationFailures.push(filePath + '（' + restoreError.message + '）');
      }
    }
    const compensationMessage = compensationFailures.length
      ? '；操作前配置补偿恢复也失败：' + compensationFailures.join('；')
      : '；已将本次触及的文件恢复为操作前内容';
    throw Object.assign(new Error('恢复 Compose 配置失败：' + error.message + compensationMessage), {
      statusCode: 409,
      cause: error,
      compensationFailures,
    });
  }
  return backups.length;
}

/** 从最近一次升级批次恢复全部 Compose 文件并 up -d。持项目操作锁,与升级/重启互斥。 */
export async function rollbackProject(project, options = {}) {
  if (!project?.managed || !project.editable) {
    throw Object.assign(new Error('当前节点下该项目不支持回滚'), { statusCode: 403 });
  }
  return withProjectOperationLock(project.id, () => rollbackProjectLocked(project, options));
}

async function rollbackProjectLocked(project, { onOutput = () => {}, onChild = () => {} } = {}) {
  const { listComposeBackups, getComposeBackup } = await import('../lib/db.js');
  const files = Array.isArray(project.composeFiles) && project.composeFiles.length
    ? project.composeFiles
    : [project.composeFile].filter(Boolean);
  // 新备份使用唯一 batch reason；旧版 reason='upgrade' 按 createdAt 分组。
  const backups = selectLatestUpgradeBackupBatch(listComposeBackups(project.id));
  if (!backups.length) throw Object.assign(new Error('没有可用的升级前 Compose 备份'), { statusCode: 409 });
  if (!hasMatchingComposeBackupFiles(backups, files)) {
    throw Object.assign(new Error('当前 Compose 文件集与升级备份不一致；为避免混合配置，已停止恢复，请先人工核对文件列表'), { statusCode: 409 });
  }

  const backupContents = [];
  for (const backup of backups) {
    const full = getComposeBackup(project.id, backup.id);
    if (typeof full?.content !== 'string') {
      throw Object.assign(new Error('升级备份内容缺失：' + backup.filePath + '；未修改当前配置'), { statusCode: 409 });
    }
    backupContents.push({ filePath: backup.filePath, content: full.content });
  }

  const currentContents = [];
  try {
    if (project.mounted) {
      for (const backup of backupContents) {
        currentContents.push({ filePath: backup.filePath, content: await readFile(backup.filePath, 'utf8') });
      }
    } else if (project.workspaceAvailable) {
      await withRunner(project, async (container) => {
        for (const backup of backupContents) {
          const current = await readArchiveFile(container, backup.filePath);
          currentContents.push({ filePath: backup.filePath, content: current.content, header: current.header });
        }
      });
    } else {
      throw new Error('当前项目没有可写入的挂载或工作区');
    }
  } catch (error) {
    throw Object.assign(new Error('无法完整读取当前 Compose 配置，恢复已取消且未修改文件：' + error.message), { statusCode: 409 });
  }

  if (project.mounted) {
    await restoreComposeBackupBatch(backupContents, currentContents, (filePath, content) => writeFile(filePath, content, 'utf8'));
  } else {
    await withRunner(project, async (container) => restoreComposeBackupBatch(
      backupContents,
      currentContents,
      (filePath, content, previous) => putArchiveFile(
        container,
        path.posix.dirname(filePath),
        path.posix.basename(filePath),
        content,
        previous.header,
      ),
    ));
  }
  const restored = backupContents.length;

  const { spawnComposeCommand } = await import('./compose-runner.js');
  const { runWorkspaceComposeArgs } = await import('./compose-workspace.js');
  const code = project.mounted
    ? await runStep(spawnComposeCommand(project, ['up', '-d', '--force-recreate']), onOutput, onChild)
    : await runWorkspaceComposeArgs(project, ['up', '-d', '--force-recreate'], onOutput);
  cache.delete(project.id);
  addOperation({ projectId: project.id, projectName: project.projectName, action: 'images.rollback', status: code === 0 ? 'success' : 'failed', detail: '已恢复 ' + restored + ' 个 Compose 配置文件；不保证回退浮动 tag 对应的镜像版本' });
  return { code, restored };
}
