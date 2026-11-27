import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import tar from 'tar-stream';
import { readConfigArchive } from '../lib/config-file-read.js';
import docker from './docker.js';
import { ACTIONS, assertComposeVersion, composeProjectOptions, replaceComposeWithBackup, withComposeFileLock } from './compose-runner.js';
import { assertProjectOperationAllowed, withProjectOperationLock } from './project-operation-lock.js';
import { demuxStream } from '../lib/docker-streams.js';
import { validateYaml } from '../lib/files.js';
import { addComposeBackup } from '../lib/db.js';
import { configuredComposeProjectRoots, safeProjectMountPath } from './mount-plan.js';
import { getActiveHostId, getActiveHost, getDockerForHost, getProjectHost, assertProjectHostUnchanged } from './docker-hosts.js';
import { sshExec, sshReadFile, sshWriteFile, sshListDirectory } from './remote-shell.js';

import { normalizeHostDirectory, hostDirectoryInspector } from './host-directory-paths.js';

let runnerImagePromise;
const workspaceRunners = new Map();
const workspaceIdleMs = boundedNumber(process.env.COMPOSEOPS_WORKSPACE_IDLE_MS, 90_000, 5_000, 15 * 60_000);
const workspaceCacheMax = boundedNumber(process.env.COMPOSEOPS_WORKSPACE_CACHE_MAX, 8, 1, 64);

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function projectPaths(project) {
  const root = safeProjectMountPath(project.workingDir);
  if (!root) throw Object.assign(new Error('项目工作目录过宽、缺失或不是安全的绝对路径'), { statusCode: 409 });
  const files = (project.composeFiles || []).map((file) => path.posix.normalize(file));
  if (!files.length || files.some((file) => !path.posix.isAbsolute(file) ||
      (file !== root && !file.startsWith(`${root}/`)))) {
    throw Object.assign(new Error('Compose 文件不在项目工作目录内'), { statusCode: 403 });
  }
  return { root, files };
}

/** 在访问/写入工作区前解析真实路径，防止项目内的 Compose 符号链接指向项目外。 */
export async function validateWorkspaceProjectPaths(project, resolvePath = realpath) {
  const { root, files } = projectPaths(project);
  let actualRoot;
  try {
    actualRoot = await resolvePath(root);
    for (const file of files) {
      const actualFile = await resolvePath(file);
      if (actualFile !== actualRoot && !actualFile.startsWith(`${actualRoot.replace(/\/$/, '')}/`)) {
        throw Object.assign(new Error('Compose 文件真实路径不在项目工作目录内（可能存在符号链接逃逸）'), { statusCode: 403 });
      }
    }
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error(`无法验证 Compose 文件真实路径: ${error.message}`), { statusCode: 403 });
  }
  return { root, files, actualRoot };
}

async function runnerImage() {
  if (process.env.COMPOSEOPS_RUNNER_IMAGE) return process.env.COMPOSEOPS_RUNNER_IMAGE;
  const hostname = process.env.HOSTNAME?.trim();
  if (!hostname) throw Object.assign(new Error('宿主机运行请配置 COMPOSEOPS_RUNNER_IMAGE，当前无法识别面板容器镜像'), { statusCode: 409 });
  if (!runnerImagePromise) {
    runnerImagePromise = docker.getContainer(hostname).inspect()
      .then((inspection) => inspection.Config?.Image)
      .then((image) => {
        if (!image) throw new Error('无法识别 ComposeOps 当前镜像');
        return image;
      })
      .catch((error) => {
        runnerImagePromise = undefined;
        throw error;
      });
  }
  return runnerImagePromise;
}

async function createRunner(project, readOnly) {
  const { root } = projectPaths(project);
  const container = await docker.createContainer({
    Image: await runnerImage(),
    // AutoRemove 是异常退出的兜底；正常情况下由空闲计时器提前清理。
    Cmd: ['sleep', '3600'],
    WorkingDir: root,
    Labels: { 'composeops.helper': 'compose-workspace', 'composeops.project': project.id,
      'composeops.host': project.hostId || getActiveHostId(), 'composeops.workspace-mode': readOnly ? 'read' : 'execute' },
    HostConfig: {
      AutoRemove: true,
      ...(readOnly ? { ReadonlyRootfs: true, NetworkMode: 'none' } : {}),
      Mounts: [
        { Type: 'bind', Source: root, Target: root, ReadOnly: readOnly },
        ...(!readOnly ? [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock', ReadOnly: false }] : []),
      ],
      SecurityOpt: ['no-new-privileges:true'],
    },
  });
  try { await container.start(); }
  catch (error) {
    // AutoRemove only applies after a successful start; failed starts otherwise leak containers.
    await container.remove({ force: true }).catch(() => {});
    throw error;
  }
  return container;
}

function runnerKey(project, readOnly) {
  return `${project.hostId || getActiveHostId()}\0${project.id}\0${projectPaths(project).root}\0${readOnly ? 'read' : 'execute'}`;
}

function retireRunner(entry) {
  if (entry.retired) return;
  entry.retired = true;
  clearTimeout(entry.idleTimer);
  if (workspaceRunners.get(entry.key) === entry) workspaceRunners.delete(entry.key);
}

async function destroyRunner(entry) {
  if (entry.destroyPromise) return entry.destroyPromise;
  entry.destroyPromise = (async () => {
    const container = await entry.containerPromise.catch(() => null);
    if (!container) return;
    await container.remove({ force: true }).catch(() => {});
  })();
  return entry.destroyPromise;
}

function scheduleRunnerCleanup(entry) {
  clearTimeout(entry.idleTimer);
  if (entry.active > 0) return;
  if (entry.retired) {
    void destroyRunner(entry);
    return;
  }
  entry.idleTimer = setTimeout(() => {
    retireRunner(entry);
    if (entry.active === 0) void destroyRunner(entry);
  }, workspaceIdleMs);
  entry.idleTimer.unref?.();
}

function releaseRunner(entry) {
  entry.active = Math.max(0, entry.active - 1);
  entry.lastUsedAt = Date.now();
  scheduleRunnerCleanup(entry);
}

function trimRunnerCache() {
  if (workspaceRunners.size < workspaceCacheMax) return;
  const idle = [...workspaceRunners.values()]
    .filter((entry) => entry.active === 0)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  while (workspaceRunners.size >= workspaceCacheMax && idle.length) {
    const entry = idle.shift();
    retireRunner(entry);
    void destroyRunner(entry);
  }
}

function createRunnerEntry(project, key, readOnly) {
  trimRunnerCache();
  const entry = {
    key,
    projectId: project.id,
    hostId: project.hostId || getActiveHostId(),
    readOnly,
    root: projectPaths(project).root,
    active: 0,
    lastUsedAt: Date.now(),
    idleTimer: null,
    retired: false,
    destroyPromise: null,
    containerPromise: createRunner(project, readOnly),
  };
  // 创建失败时立即移出缓存，下一次请求可以重新创建。
  entry.containerPromise.catch(() => retireRunner(entry));
  workspaceRunners.set(key, entry);
  return entry;
}

async function acquireRunner(project, readOnly) {
  const key = runnerKey(project, readOnly);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let entry = workspaceRunners.get(key);
    const reused = !!entry;
    if (!entry || entry.retired) entry = createRunnerEntry(project, key, readOnly);
    clearTimeout(entry.idleTimer);
    entry.active += 1;
    try {
      const container = await entry.containerPromise;
      if (reused) {
        const inspection = await container.inspect();
        if (!inspection.State?.Running) throw new Error('Compose 工作容器已经失效');
      }
      return { entry, container };
    } catch (error) {
      retireRunner(entry);
      releaseRunner(entry);
      if (attempt === 1) throw error;
    }
  }
  throw new Error('无法创建 Compose 工作容器');
}

async function withRunner(project, callback, { readOnly = false } = {}) {
  assertProjectOperationAllowed(project.id);
  assertProjectHostUnchanged(project);
  const host = getProjectHost(project);
  const hostType = host.type;
  if (hostType === 'tcp') throw Object.assign(new Error('TCP 节点仅支持容器操作，不能运行本地工作容器'), { statusCode: 409 });
  if (hostType === 'ssh') {
    try {
      await validateWorkspaceProjectPaths(project, async (remotePath) => {
        const result = await sshExec(host, ['realpath', '-e', '--', remotePath], { timeoutMs: 15000 });
        if (result.code !== 0) throw new Error(result.stderr?.trim() || `realpath 无法解析 ${remotePath}`);
        return result.stdout.trim();
      });
      assertProjectHostUnchanged(project);
      return await callback({ __ssh: true, host });
    } catch (error) {
      if (!error.statusCode) error.statusCode = 409;
      throw error;
    }
  }
  let lease;
  try {
    lease = await acquireRunner(project, readOnly);
    // Compose 文件路径属于 Docker daemon 所在主机，而不是必然属于
    // ComposeOps backend 容器的文件系统。通过 daemon 创建的 workspace
    // runner 解析真实路径，避免 backend 容器看不到宿主机目录时误报 ENOENT。
    await validateWorkspaceProjectPaths(project, async (remotePath) => {
      const result = await execInRunner(lease.container, ['realpath', '-e', '--', remotePath], { timeoutMs: 15000 });
      if (result.code !== 0) throw new Error(result.stderr?.trim() || `realpath 无法解析 ${remotePath}`);
      return result.stdout.trim();
    });
    assertProjectHostUnchanged(project);
    return await callback(lease.container);
  } catch (error) {
    if (error.statusCode === 504 && lease) {
      retireRunner(lease.entry);
      await destroyRunner(lease.entry);
    }
    if (!error.statusCode) error.statusCode = 409;
    throw error;
  } finally {
    if (lease) releaseRunner(lease.entry);
  }
}

/** File browsing must not create a writable, networked Docker execution environment. */
export function withReadOnlyRunner(project, callback) {
  return withRunner(project, callback, { readOnly: true });
}

/** 目录来自 Docker 宿主机而非面板容器；本地 helper 只读、无网络、无 socket。 */
export async function inspectHostDirectory(host, directory, options = {}) {
  const requested = normalizeHostDirectory(directory);
  if (host.type === 'tcp') throw Object.assign(new Error('TCP 节点不支持宿主机目录浏览，请切换到本地或 SSH 节点'), { statusCode: 409 });
  if (host.type === 'ssh') return sshListDirectory(host, requested, options);
  let helper;
  try {
    helper = await getDockerForHost(host.id).createContainer({
      Image: await runnerImage(), Cmd: ['sleep', '60'],
      Labels: { 'composeops.helper': 'directory-browser' },
      HostConfig: { AutoRemove: true, ReadonlyRootfs: true, NetworkMode: 'none',
        Mounts: [{ Type: 'bind', Source: '/', Target: '/host', ReadOnly: true }],
        SecurityOpt: ['no-new-privileges:true'], CapDrop: ['ALL'], CapAdd: ['DAC_OVERRIDE'],
      },
    });
    await helper.start();
    const response = await execInRunner(helper, ['node', '-e', '(' + hostDirectoryInspector.toString() + ')()', requested,
      options.resolveOnly ? '1' : '0', options.allowMissing ? '1' : '0', options.after || ''], { timeoutMs: 15000 });
    const result = JSON.parse(response.stdout || '{}');
    if (response.code !== 0 || !result.path) throw Object.assign(new Error('无法读取宿主机目录，请检查目录是否存在及访问权限'), { statusCode: 409, code: result.error });
    normalizeHostDirectory(result.path);
    return result;
  } finally { if (helper) await helper.remove({ force: true }).catch(() => {}); }
}

export async function browseHostDirectories({ directory = '/', expectedHostId, after = '' } = {}) {
  const host = getActiveHost();
  const identity = { hostId: expectedHostId, activeHostAtScan: expectedHostId };
  if (!expectedHostId || host.id !== expectedHostId) throw Object.assign(new Error('Docker 节点已变化，请重新选择目录'), { statusCode: 409, code: 'HOST_CHANGED' });
  assertProjectHostUnchanged(identity);
  const result = await inspectHostDirectory(host, directory, { after });
  assertProjectHostUnchanged(identity);
  return { ...result, hostId: host.id, hostName: host.name, parent: result.path === '/' ? null : path.posix.dirname(result.path) };
}

/** 首次部署原子创建独立子目录；helper 仅写所选父目录，已有目录不覆盖。 */
export async function withNewWorkspace(project, callback) {
  const { root, files } = projectPaths(project);
  const creationRoot = normalizeHostDirectory(project.creationRoot || '/projects');
  if (
      path.posix.dirname(root) !== creationRoot || files.some(file => path.posix.dirname(file) !== root)) {
    throw Object.assign(new Error('项目目录必须是所选父目录下的独立子目录'), { statusCode: 403 });
  }
  assertProjectHostUnchanged(project);
  const host = getProjectHost(project);
  if (host.type === 'tcp') throw Object.assign(new Error('TCP 节点不支持创建应用工作区'), { statusCode: 409 });
  let container;
  let writeRoot = root;
  try {
    if (host.type === 'ssh') {
      if (configuredComposeProjectRoots().includes(creationRoot)) {
        const parent = await sshExec(host, ['mkdir', '-p', '--', creationRoot], { timeoutMs: 15000 });
        if (parent.code !== 0) throw Object.assign(new Error('无法创建远端项目根目录，请检查写入权限'), { statusCode: 409 });
      }
      const verifiedRoot = await sshExec(host, ['realpath', '-e', '--', creationRoot], { timeoutMs: 15000 });
      if (verifiedRoot.code !== 0 || verifiedRoot.stdout.trim() !== creationRoot) {
        throw Object.assign(new Error('项目根目录无法通过真实路径校验，拒绝创建'), { statusCode: 403 });
      }
      container = { __ssh: true, host };
    } else {
      const parent = await inspectHostDirectory(host, creationRoot, { resolveOnly: true, allowMissing: configuredComposeProjectRoots().includes(creationRoot) });
      if (parent.path !== creationRoot) throw Object.assign(new Error('目录包含符号链接，请浏览并选择解析后的真实目录：' + parent.path), { statusCode: 409 });
      if (!parent.exists && creationRoot.includes(':')) throw Object.assign(new Error('请先在宿主机创建该目录，再浏览选择'), { statusCode: 400 });
      assertProjectHostUnchanged(project);
      writeRoot = path.posix.join('/workspace', path.posix.basename(root));
      container = await getDockerForHost(host.id).createContainer({
        Image: await runnerImage(), Cmd: ['sleep', '300'],
        Labels: { 'composeops.helper': 'blueprint-init', 'composeops.project': project.id },
        HostConfig: {
          AutoRemove: true, ReadonlyRootfs: true, NetworkMode: 'none',
          ...(parent.exists ? { Mounts: [{ Type: 'bind', Source: creationRoot, Target: '/workspace', ReadOnly: false }] }
            : { Binds: [creationRoot + ':/workspace:rw'] }),
          SecurityOpt: ['no-new-privileges:true'],
        },
      });
      await container.start();
      container.__creationDirectory = { source: root, target: writeRoot };
    }
    assertProjectHostUnchanged(project);
    const created = await execInRunner(container, [
      'sh', '-c', 'if [ -e "$1" ] || [ -L "$1" ]; then exit 17; fi; umask 077; mkdir -- "$1"',
      'composeops-init', writeRoot,
    ], { timeoutMs: 15000 });
    if (created.code !== 0) {
      throw Object.assign(new Error(created.code === 17
        ? `项目目录 ${root} 已存在，为避免覆盖配置，请查看原项目或换一个项目名`
        : `无法创建项目目录 ${root}，请检查目录是否已存在及写入权限`), { statusCode: 409 });
    }
    try {
      assertProjectHostUnchanged(project);
      return await callback(container);
    } catch (error) {
      error.directoryCreated = true;
      throw error;
    }
  } finally {
    if (container && !container.__ssh) await container.remove({ force: true }).catch(() => {});
  }
}

export { withRunner, execInRunner, readArchiveFile, putArchiveFile };

export function pruneWorkspaceRunners(allowedProjectIds = [], hostId) {
  const allowed = new Set(allowedProjectIds);
  for (const entry of workspaceRunners.values()) {
    if ((hostId && entry.hostId !== hostId) || allowed.has(entry.projectId)) continue;
    retireRunner(entry);
    if (entry.active === 0) void destroyRunner(entry);
  }
}

export async function closeAllWorkspaceRunners() {
  const entries = [...workspaceRunners.values()];
  for (const entry of entries) retireRunner(entry);
  await Promise.all(entries.map((entry) => destroyRunner(entry)));
}

/** 完整备份前只回收所选项目的空闲工作容器，不能强杀正在执行的命令。 */
export async function closeIdleProjectRunners(projectIds, { waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const entries = [...workspaceRunners.values()].filter((entry) => projectIds.includes(entry.projectId));
    if (!entries.some((entry) => entry.active > 0)) {
      for (const entry of entries) retireRunner(entry);
      await Promise.all(entries.map((entry) => destroyRunner(entry)));
      return;
    }
    if (Date.now() >= deadline)
      throw Object.assign(new Error('所选应用有正在执行的工作区命令，请等待完成'), { statusCode: 409 });
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}

export function workspaceRunnerStats() {
  return {
    idleMs: workspaceIdleMs,
    maxEntries: workspaceCacheMax,
    entries: [...workspaceRunners.values()].map((entry) => ({
      projectId: entry.projectId,
      hostId: entry.hostId,
      mode: entry.readOnly ? 'read' : 'execute',
      active: entry.active,
      retired: entry.retired,
    })),
  };
}

async function execInRunner(container, cmd, { input, onOutput = () => {}, onExec = null, timeoutMs = 300000, signal } = {}) {
  signal?.throwIfAborted();
  if (container?.__ssh) {
    if (input !== undefined) {
      throw Object.assign(new Error('远端 SSH 执行不接受标准输入'), { statusCode: 400 });
    }
    return sshExec(container.host, cmd, { onOutput, onExec, timeoutMs, signal });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('命令期限必须为正数');
  const controller = new AbortController();
  let timer;
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', rejectAborted, { once: true });
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('Compose 工作命令执行超时，已执行操作需核对'), { statusCode: 504 });
      reject(error); controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([executeDockerCommand(container, cmd, { input, onOutput, onExec, abortSignal: controller.signal }), timedOut, aborted]);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAborted); controller.abort();
  }
}

async function executeDockerCommand(container, cmd, { input, onOutput, onExec, abortSignal }) {
  abortSignal.throwIfAborted();
  const instance = await container.exec({
    abortSignal,
    Cmd: cmd,
    AttachStdin: input !== undefined,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Env: ['COMPOSE_HTTP_TIMEOUT=300', 'COMPOSE_PROGRESS=plain'],
  });
  abortSignal.throwIfAborted();
  const stream = await instance.start({ hijack: input !== undefined, stdin: input !== undefined, abortSignal });
  if (abortSignal.aborted) { stream.destroy?.(); throw abortSignal.reason; }
  const demux = demuxStream();
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const maxOutputBytes = 1024 * 1024;
  demux.stdout.on('data', (chunk) => {
    if (stdoutBytes < maxOutputBytes) {
      const part = chunk.subarray(0, maxOutputBytes - stdoutBytes);
      stdout.push(part);
      stdoutBytes += part.length;
    }
    onOutput('stdout', chunk.toString('utf8').slice(-20000));
  });
  demux.stderr.on('data', (chunk) => {
    if (stderrBytes < maxOutputBytes) {
      const part = chunk.subarray(0, maxOutputBytes - stderrBytes);
      stderr.push(part);
      stderrBytes += part.length;
    }
    onOutput('stderr', chunk.toString('utf8').slice(-20000));
  });
  let rejectCancelled;
  const onStreamError = error => rejectCancelled?.(error);
  const onAbort = () => rejectCancelled?.(abortSignal.reason);
  const onStreamClose = () => {
    if (!stream.readableEnded) rejectCancelled?.(Object.assign(new Error('Compose 输出连接已中断，执行结果需核对'), { code: 'STREAM_CLOSED' }));
  };
  try {
    const outputDone = Promise.all([
      new Promise((resolve, reject) => demux.stdout.on('end', resolve).on('error', reject)),
      new Promise((resolve, reject) => demux.stderr.on('end', resolve).on('error', reject)),
    ]);
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    abortSignal.addEventListener('abort', onAbort, { once: true });
    stream.once('error', onStreamError);
    stream.once('close', onStreamClose);
    const completion = Promise.race([outputDone, cancelled]);
    // 断流仅停止本次等待，无法保证远端进程回滚。先安装监听再交付句柄，
    // 避免初始化期间已取消的请求同步 kill 后等待到 5 分钟超时。
    if (typeof onExec === 'function') onExec({ kill: () => {
      rejectCancelled(Object.assign(new Error('Compose 输出已断开，已执行操作需在项目中核对'), { name: 'AbortError' }));
      try { stream.destroy?.(); demux.destroy?.(); } catch { /* 尽力而为 */ }
    } });
    if (abortSignal.aborted) onAbort();
    if (!stream.destroyed) stream.pipe(demux);
    if (input !== undefined && !stream.destroyed) stream.end(input);
    await completion;
    // 退出检查也受同一命令期限约束。
    const result = await Promise.race([instance.inspect({ abortSignal }), cancelled]);
    return {
      code: result.ExitCode ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
  } catch (error) {
    try { stream.destroy?.(); } catch { /* 超时清理时 stream 可能已经结束。 */ }
    demux.destroy?.();
    throw error;
  } finally {
    abortSignal.removeEventListener('abort', onAbort);
    stream.off('error', onStreamError);
    stream.off('close', onStreamClose);
  }
}

async function readArchiveFile(container, filePath, options = {}) {
  if (container?.__ssh) return sshReadFile(container.host, filePath, options);
  return readConfigArchive(container, filePath, options);
}

async function putArchiveFile(container, directory, name, content, header) {
  if (container?.__ssh) {
    if (typeof name !== 'string' || !name || name.includes('/') || name.includes('..')) {
      throw Object.assign(new Error('远端文件名不合法'), { statusCode: 400 });
    }
    return sshWriteFile(container.host, path.posix.join(directory, name), content, header);
  }
  if (container?.__creationDirectory) {
    if (directory !== container.__creationDirectory.source) throw new Error('创建文件必须位于新项目目录');
    directory = container.__creationDirectory.target;
  }
  const pack = tar.pack();
  pack.entry({
    name,
    type: 'file',
    mode: header.mode,
    uid: header.uid,
    gid: header.gid,
    size: Buffer.byteLength(content),
  }, content);
  pack.finalize();
  await container.putArchive(pack, { path: directory });
}

function selectedFile(project, fileIndex) {
  const { files } = projectPaths(project);
  const index = Number(fileIndex);
  if (!Number.isInteger(index) || index < 0 || index >= files.length) {
    throw Object.assign(new Error('Compose 文件不存在'), { statusCode: 404 });
  }
  return { index, filePath: files[index], files };
}

export async function readWorkspaceCompose(project, fileIndex = 0) {
  const { index, filePath } = selectedFile(project, fileIndex);
  return withReadOnlyRunner(project, async (container) => {
    const { content } = await readArchiveFile(container, filePath);
    return { fileIndex: index, path: filePath, content };
  });
}

export async function saveWorkspaceCompose(project, fileIndex, content, reason = 'save', expectedContent = undefined) {
  if (typeof content !== 'string' || content.length === 0 || Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    throw Object.assign(new Error('Compose 内容为空或超过 2MB'), { statusCode: 400 });
  }
  validateYaml(content);
  const { index, filePath, files } = selectedFile(project, fileIndex);
  return withProjectOperationLock(project.id, () => withComposeFileLock(`${project.id}:${filePath}`, () => withRunner(project, async (container) => {
    const previous = await readArchiveFile(container, filePath);
    assertComposeVersion(previous.content, expectedContent);
    const tempName = `.composeops-${randomBytes(8).toString('hex')}.tmp`;
    const tempPath = path.posix.join(path.posix.dirname(filePath), tempName);
    await putArchiveFile(container, path.posix.dirname(filePath), tempName, content, previous.header);
    try {
      const checkFiles = [...files];
      checkFiles[index] = tempPath;
      const check = await execInRunner(container, ['docker', 'compose', ...composeProjectOptions(project, checkFiles), 'config', '--quiet']);
      if (check.code !== 0) throw Object.assign(new Error(check.stderr.trim() || `docker compose config 退出码 ${check.code}`), { statusCode: 422 });
      await replaceComposeWithBackup({
        replace: async () => {
          const move = await execInRunner(container, ['mv', '-f', '--', tempPath, filePath]);
          if (move.code !== 0) throw new Error(move.stderr.trim() || 'Compose 文件替换失败');
          await execInRunner(container, ['chmod', previous.header.mode.toString(8), filePath]).catch(() => {});
          await execInRunner(container, ['chown', `${previous.header.uid}:${previous.header.gid}`, filePath]).catch(() => {});
        },
        backup: () => addComposeBackup(project.id, filePath, previous.content, reason),
        rollback: async () => {
          const rollbackName = `.composeops-${randomBytes(8).toString('hex')}.rollback`;
          const rollbackPath = path.posix.join(path.posix.dirname(filePath), rollbackName);
          try {
            await putArchiveFile(container, path.posix.dirname(filePath), rollbackName, previous.content, previous.header);
            const restore = await execInRunner(container, ['mv', '-f', '--', rollbackPath, filePath]);
            if (restore.code !== 0) throw new Error(restore.stderr.trim() || '恢复原 Compose 文件失败');
            await execInRunner(container, ['chmod', previous.header.mode.toString(8), filePath]).catch(() => {});
            await execInRunner(container, ['chown', `${previous.header.uid}:${previous.header.gid}`, filePath]).catch(() => {});
          } finally {
            await execInRunner(container, ['rm', '-f', '--', rollbackPath]).catch(() => {});
          }
        },
      });
    } catch (error) {
      await execInRunner(container, ['rm', '-f', '--', tempPath]).catch(() => {});
      throw error;
    }
    return { ok: true, path: filePath };
  })));
}

export async function runWorkspaceComposeArgs(project, args, onOutput = () => {}, options = {}) {
  options.signal?.throwIfAborted();
  const { files } = projectPaths(project);
  if (!Array.isArray(args) || !args.length) throw Object.assign(new Error('无效的 Compose 参数'), { statusCode: 400 });
  return withRunner(project, async (container) => {
    options.signal?.throwIfAborted();
    options.beforeExecute?.();
    const result = await execInRunner(container, ['docker', 'compose', ...composeProjectOptions(project, files), ...args], { onOutput, onExec: options.onExec, timeoutMs: options.timeoutMs, signal: options.signal });
    return result.code;
  });
}

export async function runWorkspaceCompose(project, action, onOutput = () => {}, options = {}) {
  const { files } = projectPaths(project);
  const actionArgs = ACTIONS[action];
  if (!actionArgs) throw Object.assign(new Error('不支持的 Compose 操作'), { statusCode: 400 });
  return withRunner(project, async (container) => {
    const result = await execInRunner(container, ['docker', 'compose', ...composeProjectOptions(project, files), ...actionArgs], { onOutput, onExec: options.onExec, timeoutMs: options.timeoutMs });
    return result.code;
  });
}
