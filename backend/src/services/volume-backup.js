/**
 * 数据卷备份:用一次性 helper 容器(busybox)把项目的命名卷打包为 tar.gz。
 *
 * - 备份目录:setting 'backup.volume_dir',默认 <backend/data>/volume-backups;
 *   该路径始终解析在**当前激活 Docker 宿主**的文件系统上(远程 SSH/TCP 宿主同理)。
 * - 仅备份命名卷(compose 顶层 volumes / 服务引用的命名卷);bind mount 与
 *   变量引用会被跳过并在结果里注明原因。
 * - 恢复 = helper 容器反向 untar(覆盖卷内容,路由层必须先经用户确认)。
 * - 每个卷保留最近 20 份,与 compose 文件备份策略一致。
 */

import { mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { getActiveHost, getDockerForHost, getHost } from './docker-hosts.js';
import { readCompose } from './compose-runner.js';
import { readWorkspaceCompose } from './compose-workspace.js';
import { collectDockerOutput, demuxStream } from '../lib/docker-streams.js';
import { getSetting, addOperation, addVolumeBackup, listVolumeBackups, getVolumeBackup, deleteVolumeBackupRow, pruneVolumeBackups, updateVolumeBackupVerify } from '../lib/db.js';

const HELPER_IMAGE = 'busybox:1.36';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getBackupDir(host = null) {
  const hostId = host?.id || 'local';
  return getSetting(`backup.volume_dir.${hostId}`, getSetting('backup.volume_dir', '')) || path.join(__dirname, '../../data/volume-backups');
}

function hostForId(hostId) {
  const host = getHost(hostId || 'local');
  if (!host) throw Object.assign(new Error(`备份所属 Docker 节点不存在:${hostId}`), { statusCode: 409 });
  return host;
}

function isLocalHost(host) {
  return (host?.id || 'local') === 'local' || host?.type === 'local';
}

/**
 * 从 Compose 内容解析"值得备份"的命名卷(纯函数,便于单测)。
 * 返回 [{ name, external, skip }] —— skip 非空表示该引用不会纳入备份及原因。
 */
export function parseProjectVolumes(composeContent) {
  let doc;
  try {
    doc = parseYaml(String(composeContent || ''));
  } catch {
    return { volumes: [], error: 'compose 文件不是合法 YAML' };
  }
  if (!doc || typeof doc !== 'object') return { volumes: [], error: '' };
  const topVolumes = doc.volumes && typeof doc.volumes === 'object' ? doc.volumes : {};
  const merged = new Map();
  for (const [name, def] of Object.entries(topVolumes)) {
    const definition = def && typeof def === 'object' ? def : {};
    merged.set(name, {
      name,
      composeName: name,
      dockerName: typeof definition.name === 'string' ? definition.name.trim() : '',
      external: !!definition.external,
      skip: '',
    });
  }
  const services = doc.services && typeof doc.services === 'object' ? doc.services : {};
  for (const [serviceName, service] of Object.entries(services)) {
    const mounts = Array.isArray(service?.volumes) ? service.volumes : [];
    for (const mount of mounts) {
      const isString = typeof mount === 'string';
      const source = isString ? String(mount).split(':')[0] : String(mount?.source || '');
      const type = isString ? '' : String(mount?.type || '');
      if (!source) continue;
      if (!isString && type === 'bind' || source.startsWith('.') || source.startsWith('/') || source.startsWith('~')) {
        merged.set(source, { name: source, external: false, skip: `bind mount(${serviceName})不纳入备份` });
        continue;
      }
      if (!isString && (type === 'tmpfs' || type === 'npipe')) {
        merged.set(source, { name: source, external: false, skip: `${type}挂载(${serviceName})不纳入备份` });
        continue;
      }
      if (source.startsWith('$')) {
        merged.set(source, { name: source, external: false, skip: `变量引用(${serviceName})无法解析` });
        continue;
      }
      if (merged.has(source)) continue;
      merged.set(source, { name: source, composeName: source, dockerName: '', external: false, skip: '' });
    }
  }
  return { volumes: [...merged.values()], error: '' };
}

/**
 * 将 Compose 中的逻辑卷键解析为 Docker 实际卷名。
 * 普通卷默认带 Compose 项目前缀,external 卷不带前缀,显式 name 优先;
 * 已存在清单只用于判断期望卷是否存在,不会把同名裸卷误认成项目卷。
 */
export function resolveProjectVolumeNames(volumes, projectName = '', existingNames = []) {
  const existing = new Set(existingNames);
  const prefix = String(projectName || '').trim();
  return (Array.isArray(volumes) ? volumes : []).map((item) => {
    if (item?.skip) return { ...item, composeName: item.composeName || item.name, exists: null };
    const composeName = String(item?.composeName || item?.name || '').trim();
    const candidates = [];
    const addCandidate = (value) => {
      const candidate = String(value || '').trim();
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    };
    if (item?.dockerName) addCandidate(item.dockerName);
    else if (item?.external) addCandidate(composeName);
    else if (prefix) addCandidate(`${prefix}_${composeName}`);
    else addCandidate(composeName);
    const name = candidates[0] || composeName;
    const existingName = candidates.find((candidate) => existing.has(candidate));
    return {
      ...item,
      name: existingName || name,
      composeName,
      exists: existing.has(existingName || name),
    };
  });
}

function composeReaderForProject(project) {
  if (project?.composeMode === 'direct') return readCompose;
  if (project?.composeMode === 'workspace') return readWorkspaceCompose;
  throw Object.assign(
    new Error('当前 Docker 节点没有可安全读取的 Compose 工作区,无法列出数据卷'),
    { statusCode: 409, code: 'COMPOSE_WORKSPACE_REQUIRED' },
  );
}

/** 列出项目可备份卷:解析 compose + 校验卷在当前宿主上存在。 */
export async function listProjectVolumes(project) {
  const compose = await composeReaderForProject(project)(project);
  const { volumes, error } = parseProjectVolumes(compose.content);
  if (error) throw Object.assign(new Error(error), { statusCode: 400 });
  const host = getActiveHost();
  const docker = getDockerForHost(host.id);
  const existing = new Set();
  try {
    const all = await docker.listVolumes();
    for (const volume of all?.Volumes || all || []) existing.add(volume.Name);
  } catch { /* Docker API 不可列出卷时仅返回未确认存在。 */ }
  return resolveProjectVolumeNames(volumes, project.projectName, existing);
}

function safeFileName(projectName, volume, timestamp = Date.now()) {
  const clean = (value) => String(value || 'x').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  return `${clean(projectName)}_${clean(volume)}_${timestamp}.tar.gz`;
}

function assertBackupFileName(file) {
  const value = String(file || '');
  if (!value || value.length > 255 || !/^[A-Za-z0-9_.-]+\.tar\.gz$/.test(value) || /[\\/\0]/.test(value)) {
    throw Object.assign(new Error('备份文件名不合法'), { statusCode: 409 });
  }
  return value;
}

function assertVolumeName(volume) {
  const value = String(volume || '');
  if (!value || value.length > 255 || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw Object.assign(new Error('卷名不合法'), { statusCode: 400 });
  }
  return value;
}

async function ensureHelperImage(docker) {
  try {
    await docker.getImage(HELPER_IMAGE).inspect();
    return;
  } catch { /* helper 镜像已存在或检查失败时继续 pull 流程。 */ }
  const stream = await docker.pull(HELPER_IMAGE);
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
  });
}

/** 跑一次性 helper 容器执行命令,返回 { exitCode, output }。 */
async function runHelper(docker, cmd, binds) {
  await ensureHelperImage(docker);
  const container = await docker.createContainer({
    Image: HELPER_IMAGE,
    Cmd: ['sh', '-c', cmd],
    HostConfig: { Binds: binds },
    Labels: { 'composeops.role': 'volume-backup' },
  });
  try {
    await container.start();
    const wait = await container.wait();
    const logStream = await container.logs({ stdout: true, stderr: true, follow: false });
    const output = await collectDockerOutput(logStream);
    return { exitCode: wait.StatusCode ?? wait, output: output.trim() };
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}


/** 将应用容器内的备份目录映射为 Docker daemon 所在宿主机上的真实路径。 */
export function resolveMountedHostPath(containerInfo, targetPath) {
  const target = path.posix.resolve(targetPath);
  const mounts = Array.isArray(containerInfo?.Mounts) ? containerInfo.Mounts : [];
  const matches = mounts
    .filter((mount) => typeof mount?.Destination === 'string' && typeof mount?.Source === 'string')
    .map((mount) => ({ ...mount, destination: path.posix.resolve(mount.Destination) }))
    .filter((mount) => {
      const relative = path.posix.relative(mount.destination, target);
      return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
    })
    .sort((a, b) => b.destination.length - a.destination.length);
  if (!matches.length) {
    throw Object.assign(new Error('备份目录 ' + target + ' 不在应用容器的任何挂载点内；请将目录放入持久化挂载或配置宿主机可访问的目录'), { statusCode: 400 });
  }
  const mount = matches[0];
  return path.posix.resolve(mount.Source, path.posix.relative(mount.destination, target));
}

async function resolveBackupDirForDocker(docker, host, dir) {
  if (!isLocalHost(host)) return dir;
  try {
    const appContainer = await docker.getContainer(process.env.HOSTNAME).inspect();
    return resolveMountedHostPath(appContainer, dir);
  } catch (error) {
    if (error?.statusCode === 400) throw error;
    if (existsSync('/.dockerenv')) {
      throw Object.assign(new Error('无法读取当前应用容器的挂载信息，拒绝把容器内路径误用为宿主机 bind mount 源'), { statusCode: 502 });
    }
    return dir;
  }
}

async function volumeBinds(volume, mode, host = getActiveHost(), docker = getDockerForHost(host?.id || 'local')) {
  const backupHostPath = await resolveBackupDirForDocker(docker, host, getBackupDir(host));
  return [volume + ':/src:' + mode, backupHostPath + ':/backup'];
}


/** 备份单个命名卷,返回新纪录。 */
export async function createVolumeBackup(project, volumeName) {
  volumeName = assertVolumeName(volumeName);
  const host = getActiveHost();
  const hostId = host?.id || 'local';
  const dir = getBackupDir(host);
  const docker = getDockerForHost(hostId);
  if (isLocalHost(host)) await mkdir(dir, { recursive: true });
  const file = safeFileName(project.projectName, volumeName);
  const started = Date.now();
  const { exitCode, output } = await runHelper(
    docker,
    `tar czf "/backup/${file}" -C /src . && du -b "/backup/${file}" | cut -f1`,
    await volumeBinds(volumeName, 'ro', host, docker),
  ).catch((error) => {
    throw Object.assign(new Error(`helper 容器执行失败:${error.message}`), { statusCode: 502 });
  });
  if (exitCode !== 0) {
    throw Object.assign(new Error(`卷备份失败(exit ${exitCode}):${output.slice(0, 200)}`), { statusCode: 502 });
  }
  let bytes = Number(output.split('\n').pop()) || 0;
  if (!bytes && isLocalHost(host)) {
    bytes = (await stat(path.join(dir, file)).catch(() => null))?.size || 0;
  }
  const id = addVolumeBackup({ projectId: project.id, projectName: project.projectName, volume: volumeName, file, bytes, host: hostId });
  addOperation({ action: 'volume.backup', status: 'success', detail: `${project.projectName}/${volumeName} → ${file}` });
  // 清理同卷超限的旧备份(记录+文件)
  for (const stale of pruneVolumeBackups(project.id, volumeName, { host: hostId })) {
    try {
      await removeBackupFile(stale.file, stale.host);
      deleteVolumeBackupRow(stale.id);
    } catch (error) {
      console.error('[volume-backup] 旧备份清理失败,保留记录供重试:', error.message);
    }
  }
  return { id, file, bytes, durationMs: Date.now() - started };
}

async function removeBackupFile(file, hostId = 'local') {
  file = assertBackupFileName(file);
  const host = hostForId(hostId);
  const docker = getDockerForHost(host.id);
  const { exitCode, output } = await runHelper(docker, `rm -f "/backup/${file}"`, [`${getBackupDir(host)}:/backup`]);
  if (exitCode !== 0) throw Object.assign(new Error(`删除备份文件失败(exit ${exitCode}):${output.slice(0, 200)}`), { statusCode: 502 });
}

/** 恢复:把备份 tar 解回卷(覆盖现有内容)。 */
export async function restoreVolumeBackup(id) {
  const record = getVolumeBackup(id);
  if (!record) throw Object.assign(new Error('备份记录不存在'), { statusCode: 404 });
  const file = assertBackupFileName(record.file);
  const volume = assertVolumeName(record.volume);
  const host = hostForId(record.host);
  const docker = getDockerForHost(host.id);
  const { exitCode, output } = await runHelper(
    docker,
    `tar xzf "/backup/${file}" -C /src`,
    await volumeBinds(volume, 'rw', host, docker),
  ).catch((error) => {
    throw Object.assign(new Error(`helper 容器执行失败:${error.message}`), { statusCode: 502 });
  });
  if (exitCode !== 0) {
    throw Object.assign(new Error(`卷恢复失败(exit ${exitCode}):${output.slice(0, 200)}`), { statusCode: 502 });
  }
  addOperation({ action: 'volume.restore', status: 'success', detail: `${record.projectName}/${record.volume} ← ${record.file}` });
  return { ok: true, volume: record.volume };
}

/**
 * 还原演练(备份自证):不动原卷,把备份真实地解进一个一次性临时卷验证可用性。
 * 两步法:① tar tzf 读完整个压缩包(gzip CRC + tar 结构全量校验)并统计条目;
 * ② 解进一次性卷统计文件数。任何一步失败都把 verify_status 落库为 failed。
 * "能还原的备份才叫备份"——演练结果随备份记录持久化,供 UI 展示可信度。
 */
export async function verifyVolumeBackup(id) {
  const record = getVolumeBackup(id);
  if (!record) throw Object.assign(new Error('备份记录不存在'), { statusCode: 404 });
  const file = assertBackupFileName(record.file);
  const host = hostForId(record.host);
  const docker = getDockerForHost(host.id);
  const started = Date.now();
  const fail = (message) => {
    updateVolumeBackupVerify(record.id, { status: 'failed', files: null });
    addOperation({ action: 'volume.verify', status: 'failed', detail: `${record.projectName}/${record.volume} ← ${record.file}: ${message}` });
    return Object.assign(new Error(message), { statusCode: 502 });
  };

  // ① 压缩包完整性:列出全部条目(gzip CRC 校验贯穿整个解压过程)
  const listing = await runHelper(
    docker,
    `tar tzf "/backup/${file}" | wc -l`,
    [`${getBackupDir(host)}:/backup:ro`],
  ).catch((error) => { throw fail(`helper 容器执行失败:${error.message}`); });
  if (listing.exitCode !== 0) {
    throw fail(`备份已损坏(exit ${listing.exitCode}):${listing.output.slice(0, 200)}`);
  }
  const entries = Number(listing.output.split('\n').pop()) || 0;

  // ② 还原演练:解进一次性临时卷并统计文件数
  const tmpVolume = `composeops-verify-${randomBytes(4).toString('hex')}`;
  await docker.createVolume({ Name: tmpVolume, Labels: { 'composeops.role': 'volume-verify' } });
  try {
    const restore = await runHelper(
      docker,
      `tar xzf "/backup/${file}" -C /src && find /src -type f | wc -l && du -sh /src | cut -f1`,
      [`${tmpVolume}:/src:rw`, `${getBackupDir(host)}:/backup:ro`],
    ).catch((error) => { throw fail(`helper 容器执行失败:${error.message}`); });
    if (restore.exitCode !== 0) {
      throw fail(`还原演练失败(exit ${restore.exitCode}):${restore.output.slice(0, 200)}`);
    }
    const lines = restore.output.split('\n').filter((line) => line.trim() !== '');
    const files = Number(lines[lines.length - 2]) || 0;
    const sizeHuman = lines[lines.length - 1] || '';
    const status = files > 0 ? 'verified' : 'empty';
    updateVolumeBackupVerify(record.id, { status, files });
    addOperation({ action: 'volume.verify', status: 'success', detail: `${record.projectName}/${record.volume} ← ${file}:${files} 个文件` });
    return { ok: true, status, entries, files, sizeHuman, durationMs: Date.now() - started };
  } finally {
    await docker.getVolume(tmpVolume).remove().catch(() => {});
  }
}

export async function deleteVolumeBackup(id) {
  const record = getVolumeBackup(id);
  if (!record) throw Object.assign(new Error('备份记录不存在'), { statusCode: 404 });
  await removeBackupFile(record.file, record.host);
  deleteVolumeBackupRow(id);
  addOperation({ action: 'volume.backup.delete', status: 'success', detail: `${record.projectName}/${record.volume} × ${record.file}` });
  return { ok: true };
}

export async function listBackups(projectId = '') {
  return listVolumeBackups(projectId);
}

/** 备份文件是否存在且可下载。 */
async function resolveBackupFile(record) {
  const file = assertBackupFileName(record.file);
  const host = hostForId(record.host);
  const isLocal = isLocalHost(host);
  if (isLocal) {
    const target = path.join(getBackupDir(host), file);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw Object.assign(new Error('备份文件已不存在(可能被清理)'), { statusCode: 410 });
    return { kind: 'local', path: target, bytes: info.size };
  }
  return { kind: 'remote' };
}

/** 下载备份文件:本地宿主走文件流;远程宿主经 helper 容器 cat 流式转发。 */
export async function streamBackupToReply(id, reply) {
  const record = getVolumeBackup(id);
  if (!record) throw Object.assign(new Error('备份记录不存在'), { statusCode: 404 });
  const file = assertBackupFileName(record.file);
  const resolved = await resolveBackupFile(record);
  reply.header('Content-Type', 'application/gzip');
  reply.header('Content-Disposition', `attachment; filename="${file}"`);
  if (resolved.kind === 'local') {
    reply.header('Content-Length', resolved.bytes);
    return reply.send(createReadStream(resolved.path));
  }
  // 远程宿主:一次性 helper 容器读取文件,demux 后只把 stdout 转发给浏览器
  const host = hostForId(record.host);
  const docker = getDockerForHost(host.id);
  await ensureHelperImage(docker);
  const volume = assertVolumeName(record.volume);
  const container = await docker.createContainer({
    Image: HELPER_IMAGE,
    Cmd: ['sh', '-c', `cat "/backup/${file}"`],
    HostConfig: { Binds: await volumeBinds(volume, 'ro', host, docker) },
    Labels: { 'composeops.role': 'volume-backup' },
  });
  let attach = null;
  let demux = null;
  let cleaned = false;
  let containerFinished = false;
  let stdoutFinished = false;
  let stderrFinished = false;
  let finishTimer = null;
  const cleanup = async (endReply = false) => {
    if (cleaned) return;
    cleaned = true;
    if (finishTimer) clearTimeout(finishTimer);
    reply.raw.off?.('close', onReplyClose);
    demux?.stdout?.unpipe(reply.raw);
    demux?.stdout?.destroy();
    demux?.stderr?.destroy();
    demux?.destroy();
    attach?.destroy?.();
    await container.remove({ force: true }).catch(() => {});
    if (endReply && !reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  };
  const onReplyClose = () => { void cleanup(); };
  const abortStream = () => {
    if (cleaned) return;
    void cleanup().finally(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.destroy();
    });
  };
  const markStreamFinished = () => {
    if (stdoutFinished && stderrFinished) finishNormally();
  };
  const finishNormally = () => {
    if (!containerFinished || !stdoutFinished || !stderrFinished || cleaned) return;
    void cleanup(true);
  };
  try {
    reply.raw.once('close', onReplyClose);
    attach = await container.attach({ stream: true, stdout: true, stderr: true, logs: false });
    await container.start();
    if (cleaned) throw new Error('客户端已断开');
    demux = demuxStream();
    attach.on('error', abortStream);
    demux.on('error', abortStream);
    demux.stdout.on('error', abortStream);
    demux.stderr.on('error', abortStream);
    demux.stdout.once('end', () => {
      stdoutFinished = true;
      markStreamFinished();
    });
    demux.stderr.once('end', () => {
      stderrFinished = true;
      markStreamFinished();
    });
    attach.pipe(demux);
    demux.stderr.resume();
    demux.stdout.pipe(reply.raw, { end: false });
    const onContainerFinished = (result) => {
      if (result && result.StatusCode !== undefined && Number(result.StatusCode) !== 0) {
        abortStream();
        return;
      }
      containerFinished = true;
      finishNormally();
      if ((!stdoutFinished || !stderrFinished) && !cleaned) {
        finishTimer = setTimeout(abortStream, 5000);
        finishTimer.unref?.();
      }
    };
    void container.wait().then(onContainerFinished, abortStream);
    return reply;
  } catch (error) {
    await cleanup();
    reply.raw.destroy();
    throw Object.assign(new Error(`远程备份读取失败:${error.message}`), { statusCode: 502 });
  }
}

/** 兼容旧调用:本地宿主文件流(仅用于测试与本地快捷路径)。 */
export async function openBackupStream(id) {
  const record = getVolumeBackup(id);
  if (!record) throw Object.assign(new Error('备份记录不存在'), { statusCode: 404 });
  const resolved = await resolveBackupFile(record);
  if (resolved.kind !== 'local') {
    throw Object.assign(new Error('远程宿主上的备份请使用流式下载'), { statusCode: 400 });
  }
  return { stream: createReadStream(resolved.path), fileName: record.file, bytes: resolved.bytes };
}
