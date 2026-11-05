import { readFile, writeFile } from 'fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { setSetting, addComposeBackup, addOperation, COMPOSE_BACKUP_KEEP } from '../lib/db.js';
import { readCompose } from './compose-runner.js';
import { getActivityDocker } from './docker-hosts.js';
import { withRunner, readArchiveFile, putArchiveFile } from './compose-workspace.js';
import { withProjectOperationLock } from './project-operation-lock.js';

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

function classifyImageService(service) {
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

/** Docker Hub 匿名 token,供 manifest 拉取。 */
async function dockerHubToken(repo) {
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`registry token ${response.status}`);
    const data = await response.json();
    return data.token;
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取远程 manifest 的 digest(HEAD/GET + Docker-Content-Digest 头优先)。 */
export async function fetchRemoteDigest({ registry, image, tag }) {
  const base = registry === 'docker.io' ? 'https://registry-1.docker.io' : `https://${registry}`;
  // Docker Hub official images must retain the library/ namespace in their token scope.
  const repo = image;
  const endpoint = `${base}/v2/${image}/manifests/${tag}`;
  const accept = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = { Accept: accept };
    if (registry === 'docker.io') headers.Authorization = `Bearer ${await dockerHubToken(repo)}`;
    const response = await fetch(endpoint, { headers, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`registry ${response.status}`);
    const digest = response.headers.get('docker-content-digest');
    if (digest) return digest;
    // 兜底:计算 body sha256
    const body = await response.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', body);
    return `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  } finally {
    clearTimeout(timer);
  }
}

async function localImageInfo(docker, image) {
  try {
    return await docker.getImage(image).inspect();
  } catch {
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

async function readProjectComposeContents(project) {
  const files = Array.isArray(project.composeFiles) && project.composeFiles.length ? project.composeFiles : [project.composeFile].filter(Boolean);
  if (!files.length) throw new Error('项目没有可读取的 Compose 文件');
  if (project.mounted) {
    const contents = [];
    for (let i = 0; i < files.length; i += 1) contents.push((await readCompose(project, i)).content);
    return contents;
  }
  if (project.workspaceAvailable) {
    return withRunner(project, async (container) => Promise.all(files.map(async (file) => {
      const { content } = await readArchiveFile(container, file);
      return content;
    })));
  }
  throw Object.assign(new Error('当前项目的 Compose 文件不可读，无法安全检查镜像来源'), { statusCode: 409 });
}

/** 单项目镜像更新检测(带 1h 缓存)。 */
export async function getProjectUpdates(project, { force = false } = {}) {
  const cached = cache.get(project.id);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;
  const docker = getActivityDocker();
  const services = extractImageServices(await readProjectComposeContents(project));
  const images = [];
  const remoteDigests = new Map();
  for (const service of services) {
    const item = { service: service.service, image: service.image || '', status: service.status, hasUpdate: false, localDigest: null, remoteDigest: null, reachable: false, reason: service.reason || '' };
    if (service.status !== 'remote') {
      item.reachable = service.status === 'local_build' || service.status === 'pinned';
      images.push(item);
      continue;
    }
    const { parsed } = service;
    item.registry = parsed.registry;
    item.tag = parsed.tag;
    try {
      const local = await localImageInfo(docker, parsed.original);
      let remote = remoteDigests.get(parsed.original);
      if (remote === undefined) {
        remote = await fetchRemoteDigest(parsed);
        remoteDigests.set(parsed.original, remote);
      }
      Object.assign(item, compareImageDigests(local, remote, parsed), { reachable: true });
    } catch (error) {
      item.status = 'failed';
      item.error = error.message;
      item.reachable = false;
    }
    images.push(item);
  }
  const data = {
    projectId: project.id,
    projectName: project.projectName,
    checkedAt: Date.now(),
    images,
    hasUpdate: images.some((item) => item.hasUpdate),
  };
  cache.set(project.id, { ts: Date.now(), data });
  return data;
}

/** 全局检测所有可编辑项目(并发 3)。 */
export async function checkAllUpdates() {
  const { scanProjects } = await import('./scanner.js');
  const projects = (await scanProjects()).filter((project) => project.editable);
  const results = [];
  const queue = [...projects];
  async function worker() {
    while (queue.length) {
      const project = queue.shift();
      try {
        results.push(await getProjectUpdates(project, { force: true }));
      } catch (error) {
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
  for (const snapshot of snapshots) addComposeBackup(project.id, snapshot.file, snapshot.content, backupReason);
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
  const docker = getActivityDocker();
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

  let restored = 0;
  const failedFiles = [];
  for (const backup of backups) {
    if (!files.includes(backup.filePath)) {
      failedFiles.push(backup.filePath + '（已不属于当前 Compose 文件集）');
      continue;
    }
    const full = getComposeBackup(project.id, backup.id);
    if (typeof full?.content !== 'string') {
      failedFiles.push(backup.filePath + '（备份内容缺失）');
      continue;
    }
    try {
      if (project.mounted) {
        await writeFile(backup.filePath, full.content, 'utf8');
      } else if (project.workspaceAvailable) {
        await withRunner(project, async (container) => {
          const previous = await readArchiveFile(container, backup.filePath);
          await putArchiveFile(container, path.posix.dirname(backup.filePath), path.posix.basename(backup.filePath), full.content, previous.header);
        });
      } else {
        continue;
      }
      restored += 1;
    } catch (error) {
      failedFiles.push(backup.filePath + '（' + error.message + '）');
      console.warn('[image-updater] 恢复 Compose 备份失败(' + backup.filePath + '):', error.message);
    }
  }
  if (failedFiles.length || restored !== backups.length) {
    throw Object.assign(new Error('Compose 配置仅恢复 ' + restored + '/' + backups.length + ' 个文件；未执行容器重建。失败项：' + failedFiles.join('；')), { statusCode: 409 });
  }
  if (!restored) throw Object.assign(new Error('未找到可恢复的 Compose 备份文件'), { statusCode: 409 });

  const { spawnComposeCommand } = await import('./compose-runner.js');
  const { runWorkspaceComposeArgs } = await import('./compose-workspace.js');
  const code = project.mounted
    ? await runStep(spawnComposeCommand(project, ['up', '-d', '--force-recreate']), onOutput, onChild)
    : await runWorkspaceComposeArgs(project, ['up', '-d', '--force-recreate'], onOutput);
  cache.delete(project.id);
  addOperation({ projectId: project.id, projectName: project.projectName, action: 'images.rollback', status: code === 0 ? 'success' : 'failed', detail: '已恢复 ' + restored + ' 个 Compose 配置文件；不保证回退浮动 tag 对应的镜像版本' });
  return { code, restored };
}
