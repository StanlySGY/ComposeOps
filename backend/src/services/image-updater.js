import { readFile, writeFile, copyFile } from 'fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setSetting, addComposeBackup, addOperation } from '../lib/db.js';
import { readCompose } from './compose-runner.js';
import { getActivityDocker } from './docker-hosts.js';
import { withRunner, readArchiveFile, putArchiveFile } from './compose-workspace.js';
import { withProjectOperationLock } from './project-operation-lock.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h,避免 Registry Rate Limit
const cache = new Map(); // projectId -> { ts, data }

/** 解析镜像引用为 { registry, image, tag }。非镜像行(变量/$)返回 null。 */
export function parseImageRef(ref = '') {
  const cleaned = String(ref).trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
  if (!cleaned || cleaned.startsWith('$') || cleaned.startsWith('#') || cleaned.includes('\\')) return null;
  if (!cleaned.includes('/') && !cleaned.includes(':') && !cleaned.includes('.')) return null;
  let registry = 'docker.io';
  let image = cleaned;
  let tag = 'latest';
  const lastColon = image.lastIndexOf(':');
  if (lastColon > -1 && !image.slice(lastColon + 1).includes('/') && /^[\w][\w.-]*$/.test(image.slice(lastColon + 1))) {
    tag = image.slice(lastColon + 1);
    image = image.slice(0, lastColon);
  }
  const firstSlash = image.indexOf('/');
  if (firstSlash > -1) {
    const maybeReg = image.slice(0, firstSlash);
    if (maybeReg.includes('.') || maybeReg.includes(':') || maybeReg === 'localhost') {
      registry = maybeReg;
      image = image.slice(firstSlash + 1);
    }
  }
  if (registry === 'docker.io' && !image.includes('/')) image = `library/${image}`;
  return { registry, image, tag, original: cleaned };
}

/** 从 Compose 内容提取全部镜像引用(services.*.image 与 build 之外)。 */
export function extractImageRefs(composeContent = '') {
  const refs = new Set();
  const lines = String(composeContent).split('\n');
  let inServices = false;
  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (/^services:\s*$/.test(trimmed)) { inServices = true; continue; }
    if (!inServices) continue;
    // 顶层非缩进键(如 volumes:/networks:)表示 services 块已结束
    if (!line.startsWith(' ') && !line.startsWith('\t') && trimmed.length > 0 && !trimmed.startsWith('#')) {
      inServices = false;
      continue;
    }
    if (!/^image:/.test(trimmed)) continue;
    const value = trimmed.slice('image:'.length).trim();
    const parsed = parseImageRef(value);
    if (parsed) refs.add(parsed.original);
  }
  return [...refs];
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
  const repo = registry === 'docker.io' ? image.replace(/^library\//, '') : image;
  const endpoint = `${base}/v2/${image}/manifests/${tag}`;
  const accept = 'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/json';
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

async function localImageId(docker, image) {
  try {
    const info = await docker.getImage(image).inspect();
    return info.Id || '';
  } catch {
    return null;
  }
}

/** 单项目镜像更新检测(带 1h 缓存)。 */
export async function getProjectUpdates(project, { force = false } = {}) {
  const cached = cache.get(project.id);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;
  const docker = getActivityDocker();
  let composeContent = '';
  if (project.mounted) {
    try { composeContent = (await readCompose(project, 0)).content; } catch { /* 本地 Compose 不可读时尝试 workspace。 */ }
  } else if (project.workspaceAvailable) {
    try {
      composeContent = await withRunner(project, async (container) => {
        const { content } = await readArchiveFile(container, project.composeFiles[0]);
        return content;
      });
      composeContent = composeContent || '';
    } catch { /* workspace Compose 不可读时返回无配置结果。 */ }
  }
  const refs = extractImageRefs(composeContent);
  const images = [];
  for (const ref of refs) {
    try {
      const parsed = parseImageRef(ref);
      if (!parsed) continue;
      const local = await localImageId(docker, ref).catch(() => null);
      let remote = null;
      let error = '';
      try { remote = await fetchRemoteDigest(parsed); } catch (e) { error = e.message; }
      images.push({
        image: ref,
        registry: parsed.registry,
        tag: parsed.tag,
        localDigest: local,
        remoteDigest: remote,
        hasUpdate: !!(local && remote && local !== remote),
        reachable: !error,
        error,
      });
    } catch {
      // 跳过无法解析的镜像
    }
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
      try { results.push(await getProjectUpdates(project, { force: true })); } catch { /* 单项目失败不影响全局 */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, projects.length) }, () => worker()));
  setSetting('updates.last_radar_check', String(Date.now()));
  return { projects: results };
}

async function writeUpgradeBackups(project) {
  const stamp = `.backup.upgrade.${Date.now()}.${randomBytes(3).toString('hex')}`;
  const backups = [];
  if (project.mounted) {
    for (let i = 0; i < project.composeFiles.length; i += 1) {
      const file = project.composeFiles[i];
      try {
        const content = await readFile(file, 'utf8');
        const backupPath = `${file}${stamp}`;
        await writeFile(backupPath, content, 'utf8');
        addComposeBackup(project.id, file, content, 'upgrade');
        backups.push({ path: backupPath, file, content });
      } catch { /* 单个备份文件不可读时继续扫描其他文件。 */ }
    }
    const envPath = path.posix.join(project.workingDir, '.env');
    try {
      const content = await readFile(envPath, 'utf8');
      const backupPath = `${envPath}${stamp}`;
      await copyFile(envPath, backupPath);
      backups.push({ path: backupPath, file: envPath, content });
    } catch { /* env 备份不可读时继续扫描其他文件。 */ }
  }
  return backups;
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
  return withProjectOperationLock(project.id, () => upgradeProjectLocked(project, options));
}

async function upgradeProjectLocked(project, { onOutput = () => {}, onChild = () => {} } = {}) {
  const backups = await writeUpgradeBackups(project);
  const { spawnComposeCommand } = await import('./compose-runner.js');
  const { runWorkspaceComposeArgs } = await import('./compose-workspace.js');
  let code;
  if (project.mounted) {
    code = await runStep(spawnComposeCommand(project, ['pull']), onOutput, onChild);
    if (code !== 0) return { code, upgraded: false, degraded: true, rollbackAvailable: backups.length > 0, backups };
    code = await runStep(spawnComposeCommand(project, ['up', '-d']), onOutput, onChild);
  } else {
    code = await runWorkspaceComposeArgs(project, ['pull'], onOutput);
    if (code !== 0) return { code, upgraded: false, degraded: true, rollbackAvailable: backups.length > 0, backups };
    code = await runWorkspaceComposeArgs(project, ['up', '-d'], onOutput);
  }
  if (code !== 0) return { code, upgraded: false, degraded: true, rollbackAvailable: backups.length > 0, backups };

  // 健康轮询 15s:全部 running 且(如有 health)非 unhealthy 视为健康
  const docker = getActivityDocker();
  const deadline = Date.now() + 15000;
  let degraded = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const checks = await Promise.all(project.containers.map(async (item) => {
      try {
        const inspection = await docker.getContainer(item.id).inspect();
        const state = inspection.State || {};
        const health = state.Health?.Status === 'healthy' || !state.Health;
        const paused = state.Status === 'running' || state.Status === 'paused';
        return { id: item.id, name: item.name, ok: paused && health };
      } catch { return { id: item.id, name: item.name, ok: false }; }
    }));
    degraded = checks.some((item) => !item.ok);
    if (!degraded) break;
  }
  addOperation({
    projectId: project.id,
    projectName: project.projectName,
    action: 'images.upgrade',
    status: degraded ? 'failed' : 'success',
    detail: degraded ? '升级后容器未通过健康检查' : '已平滑升级并恢复健康',
  });
  return { code, upgraded: true, degraded, rollbackAvailable: backups.length > 0, backups };
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

/** 从最近一次 upgrade 备份恢复 compose/.env 并 up -d。持项目操作锁,与升级/重启互斥。 */
export async function rollbackProject(project, options = {}) {
  if (!project?.managed || !project.editable) {
    throw Object.assign(new Error('当前节点下该项目不支持回滚'), { statusCode: 403 });
  }
  return withProjectOperationLock(project.id, () => rollbackProjectLocked(project, options));
}

async function rollbackProjectLocked(project, { onOutput = () => {}, onChild = () => {} } = {}) {
  const { listComposeBackups, getComposeBackup } = await import('../lib/db.js');
  const backups = listComposeBackups(project.id).filter((item) => item.reason === 'upgrade');
  if (!backups.length && !cache.get(project.id)?.data) {
    throw Object.assign(new Error('没有可用的升级备份'), { statusCode: 409 });
  }
  // 恢复 compose 备份(最近一份)。listComposeBackups 不返回 content(只有 size),
  // 必须经 getComposeBackup 取正文,否则写入 undefined 恒抛错被吞、回滚恒 409。
  let restored = 0;
  if (project.mounted) {
    for (const backup of backups.slice(0, 1)) {
      try {
        const filePath = backup.filePath;
        const index = project.composeFiles.indexOf(filePath);
        if (index < 0) continue;
        const full = getComposeBackup(project.id, backup.id);
        if (typeof full?.content !== 'string') continue;
        await writeFile(filePath, full.content, 'utf8');
        restored += 1;
      } catch (error) {
        console.warn(`[image-updater] 恢复 compose 备份失败(${backup.filePath}):`, error.message);
      }
    }
  } else {
    for (const backup of backups.slice(0, 1)) {
      try {
        const index = project.composeFiles.indexOf(backup.filePath);
        if (index < 0) continue;
        const full = getComposeBackup(project.id, backup.id);
        if (typeof full?.content !== 'string') continue;
        await withRunner(project, async (container) => {
          const previous = await readArchiveFile(container, backup.filePath);
          await putArchiveFile(container, path.posix.dirname(backup.filePath), path.posix.basename(backup.filePath), full.content, previous.header);
        });
        restored += 1;
      } catch (error) {
        console.warn(`[image-updater] 容器内恢复 compose 备份失败(${backup.filePath}):`, error.message);
      }
    }
  }
  if (!restored) throw Object.assign(new Error('未找到可恢复的 Compose 备份'), { statusCode: 409 });
  const { spawnComposeCommand } = await import('./compose-runner.js');
  const { runWorkspaceComposeArgs } = await import('./compose-workspace.js');
  const code = project.mounted
    ? await runStep(spawnComposeCommand(project, ['up', '-d', '--force-recreate']), onOutput, onChild)
    : await runWorkspaceComposeArgs(project, ['up', '-d', '--force-recreate'], onOutput);
  addOperation({ projectId: project.id, projectName: project.projectName, action: 'images.rollback', status: code === 0 ? 'success' : 'failed' });
  return { code, restored };
}
