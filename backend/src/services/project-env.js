import { open, rename, writeFile, unlink, lstat, chmod, chown } from 'fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseDotenv, serializeDotenv, validateDotenv } from '../lib/dotenv.js';
import { spawnComposeCommand } from './compose-runner.js';
import { withRunner, withReadOnlyRunner, execInRunner, readArchiveFile, putArchiveFile, runWorkspaceComposeArgs } from './compose-workspace.js';
import { addOperation } from '../lib/db.js';
import { withProjectOperationLock } from './project-operation-lock.js';

const ENV_FILE = '.env';
const ENV_EXAMPLE = '.env.example';
const MAX_ENV_BYTES = 256 * 1024;
const envFileLocks = new Map();

export function envFileVersion(raw) {
  // Missing and empty are distinct versions. The token contains no env values.
  return createHash('sha256').update(JSON.stringify([raw !== null, raw])).digest('hex');
}

function assertEnvVersion(raw, expectedVersion) {
  if (expectedVersion === undefined) return;
  if (typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion)) {
    throw Object.assign(new Error('环境变量文件版本无效，请重新读取'), { statusCode: 400, code: 'ENV_INVALID_VERSION' });
  }
  if (envFileVersion(raw) !== expectedVersion) {
    throw Object.assign(new Error('环境变量文件已被其他窗口或程序修改，当前草稿已保留，请重新读取并合并后保存'), { statusCode: 409, code: 'ENV_VERSION_CONFLICT' });
  }
}

async function withEnvFileLock(filePath, task) {
  const previous = envFileLocks.get(filePath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  envFileLocks.set(filePath, current);
  await previous;
  try { return await task(); }
  finally {
    release();
    if (envFileLocks.get(filePath) === current) envFileLocks.delete(filePath);
  }
}

async function assertRegularEnvTarget(filePath) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw Object.assign(new Error('环境变量目标必须是普通文件，拒绝写入符号链接或特殊文件'), { statusCode: 403, code: 'ENV_UNSAFE_TARGET' });
    }
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Isolated filesystem transaction so failure paths can be tested deterministically.
export async function replaceEnvFileWithBackup({ envPath, backupPath, content, existingStat, expectedVersion, fsOps = {} }) {
  const ops = { writeFile, rename, unlink, chmod, chown, assertTarget: assertRegularEnvTarget, ...fsOps };
  const previousRaw = existingStat ? await readHostFile(envPath) : null;
  assertEnvVersion(previousRaw, expectedVersion);
  const previous = previousRaw ?? '';
  const tempPath = `${envPath}.tmp.${randomBytes(8).toString('hex')}`;
  let backupAttempted = false;
  let backupCreated = false;
  try {
    backupAttempted = true;
    await ops.writeFile(backupPath, previous, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    backupCreated = true;
    await ops.writeFile(tempPath, content, { encoding: 'utf8', mode: existingStat?.mode ?? 0o600, flag: 'wx' });
    if (existingStat) {
      await ops.chown(tempPath, existingStat.uid, existingStat.gid).catch(() => {});
      await ops.chmod(tempPath, existingStat.mode & 0o777);
    }
    const latest = await ops.assertTarget(envPath);
    if (!!latest !== !!existingStat || (latest && (latest.ino !== existingStat.ino || latest.dev !== existingStat.dev))) {
      throw Object.assign(new Error('环境变量文件在保存期间发生变化，请刷新后重试'), { statusCode: 409, code: 'ENV_VERSION_CONFLICT' });
    }
    assertEnvVersion(await readHostFile(envPath), envFileVersion(previousRaw));
    await ops.rename(tempPath, envPath);
  } catch (error) {
    await ops.unlink(tempPath).catch(() => {});
    // A failed write may leave a partial backup; preserve any pre-existing collision.
    if (backupCreated || (backupAttempted && error.code !== 'EEXIST')) await ops.unlink(backupPath).catch(() => {});
    throw Object.assign(error, { statusCode: error.statusCode || 500, message: error.statusCode ? error.message : `写入 .env 失败:${error.message}` });
  }
  return { tempPath };
}

// Workspace/SSH equivalent, with the remote filesystem operations injectable for failure tests.
export async function replaceWorkspaceEnvWithBackup({ container, root, envPath, backupPath, backupName, content, expectedVersion, ops = {} }) {
  const remote = {
    exec: (target, args) => execInRunner(target, args),
    read: (target, filePath) => readArchiveFile(target, filePath, { maxBytes: MAX_ENV_BYTES }),
    put: (target, directory, name, data, options) => putArchiveFile(target, directory, name, data, options),
    ...ops,
  };
  const safeTarget = await remote.exec(container, ['test', '!', '-L', envPath]);
  if (safeTarget.code !== 0) {
    throw Object.assign(new Error('环境变量目标是符号链接或无法安全验证，拒绝读取/写入'), { statusCode: 403, code: 'ENV_UNSAFE_TARGET' });
  }
  const targetExists = await remote.exec(container, ['test', '-e', envPath]);
  if (targetExists.code === 0) {
    const regularTarget = await remote.exec(container, ['test', '-f', envPath]);
    if (regularTarget.code !== 0) {
      throw Object.assign(new Error('环境变量目标必须是普通文件，拒绝写入目录或特殊文件'), { statusCode: 403, code: 'ENV_UNSAFE_TARGET' });
    }
  } else if (targetExists.code !== 1) {
    throw Object.assign(new Error('无法安全验证环境变量目标，拒绝写入'), { statusCode: 403, code: 'ENV_UNSAFE_TARGET' });
  }
  const previousFile = await remote.read(container, envPath).catch((error) => {
    if (error.statusCode === 404) return null;
    throw error;
  });
  const previous = previousFile?.content ?? '';
  assertEnvVersion(previousFile?.content ?? null, expectedVersion);
  const header = previousFile?.header ?? { mode: 0o600, uid: 0, gid: 0 };
  const tempName = `.composeops-${randomBytes(8).toString('hex')}.envtmp`;
  const tempPath = path.posix.join(root, tempName);
  let backupAttempted = false;
  let backupCreated = false;
  try {
    backupAttempted = true;
    await remote.put(container, root, backupName, previous, { mode: 0o600, uid: header.uid, gid: header.gid });
    backupCreated = true;
    await remote.put(container, root, tempName, content, { mode: 0o600, uid: header.uid, gid: header.gid });
    const safeAgain = await remote.exec(container, ['test', '!', '-L', envPath]);
    if (safeAgain.code !== 0) throw Object.assign(new Error('环境变量目标在保存期间变为符号链接，拒绝写入'), { statusCode: 409, code: 'ENV_VERSION_CONFLICT' });
    const latest = await remote.read(container, envPath).catch(error => { if (error.statusCode === 404) return null; throw error; });
    assertEnvVersion(latest?.content ?? null, envFileVersion(previousFile?.content ?? null));
    const moved = await remote.exec(container, ['mv', '-f', '--', tempPath, envPath]);
    if (moved.code !== 0) throw new Error(moved.stderr?.trim() || '环境变量文件原子替换失败');
    await remote.exec(container, ['chmod', (header.mode & 0o777).toString(8), envPath]).catch(() => {});
    await remote.exec(container, ['chown', `${header.uid}:${header.gid}`, envPath]).catch(() => {});
  } catch (error) {
    await remote.exec(container, ['rm', '-f', '--', tempPath]).catch(() => {});
    if (backupCreated || (backupAttempted && error.code !== 'EEXIST')) await remote.exec(container, ['rm', '-f', '--', backupPath]).catch(() => {});
    throw Object.assign(error, { statusCode: error.statusCode || 500, message: error.statusCode ? error.message : `写入环境变量文件失败:${error.message}` });
  }
  return { ok: true, path: envPath, backup: backupName };
}
// 环境变量文件族:.env / *.env / .env.example(如 multi.env、.env.production)
const ENV_FILE_PATTERN = /^(\.env(?:\.[\w][\w.-]{0,63})?|[\w][\w.-]{0,63}\.env|\.[\w.-]{0,63}\.env)$/;

/** 校验文件名属于 env 文件族且无路径穿越;非法返回 null。 */
export function normalizeEnvFileName(file) {
  const name = String(file || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (/\.backup\.\d+\.[a-f0-9]{6}$/.test(name)) return null;
  return ENV_FILE_PATTERN.test(name) ? name : null;
}

/** 列出项目根目录下的 env 文件族(mounted 走宿主目录,workspace 走容器内 ls)。 */
export async function listProjectEnvFiles(project) {
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  const root = projectEnvRoot(project);
  const names = new Set();
  const files = () => [...new Set([ENV_FILE, ...names])].sort().map(name => ({ name, exists: names.has(name) }));
  if (project.mounted) {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(root);
    for (const entry of entries) if (normalizeEnvFileName(entry)) names.add(entry);
  } else {
    if (!project.editable || !project.workspaceAvailable) {
      throw Object.assign(new Error('项目未启用 Compose 目录能力,无法读取环境变量'), { statusCode: 403 });
    }
    return withReadOnlyRunner(project, async (container) => {
      const result = await execInRunner(container, ['ls', '-1A', '--', root]);
      if (result.code !== 0) throw Object.assign(new Error('读取环境变量文件列表失败，请检查目录权限'), { statusCode: 502 });
      for (const line of String(result.stdout || '').split('\n')) {
        const name = line.trim();
        if (normalizeEnvFileName(name)) names.add(name);
      }
      return files();
    });
  }
  return files();
}

function projectEnvRoot(project) {
  const root = project.workingDir;
  if (!root || typeof root !== 'string' || !path.posix.isAbsolute(root)) {
    throw Object.assign(new Error('项目工作目录缺失,无法定位 .env'), { statusCode: 409 });
  }
  return path.posix.normalize(root);
}

export async function readHostFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw Object.assign(new Error('环境变量目标必须是普通文件'), { statusCode: 403, code: 'ENV_UNSAFE_TARGET' });
    if (info.size > MAX_ENV_BYTES) throw Object.assign(new Error('环境变量文件超过 256KB'), { statusCode: 413 });
    const buffer = Buffer.alloc(MAX_ENV_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_ENV_BYTES) throw Object.assign(new Error('环境变量文件超过 256KB'), { statusCode: 413 });
    return buffer.subarray(0, size).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw Object.assign(new Error('环境变量目标是符号链接，拒绝读取'), { statusCode: 403, code: 'ENV_UNSAFE_TARGET' });
    throw error;
  } finally { await handle?.close(); }
}

async function readContainerFile(container, filePath, { missingOk = false } = {}) {
  try {
    const safe = await execInRunner(container, ['test', '!', '-L', filePath]);
    if (safe.code !== 0) throw Object.assign(new Error('环境变量目标是符号链接，拒绝读取'), { statusCode: 403, code: 'ENV_UNSAFE_TARGET' });
    const exists = await execInRunner(container, ['test', '-e', filePath]);
    if (exists.code === 1 && missingOk) return null;
    const regular = await execInRunner(container, ['test', '-f', filePath]);
    if (exists.code !== 0 || regular.code !== 0) throw Object.assign(new Error('环境变量目标不是可读取的普通文件'), { statusCode: 403, code: 'ENV_UNSAFE_TARGET' });
    const size = await execInRunner(container, ['stat', '-c', '%s', '--', filePath]);
    if (size.code !== 0 || !/^\d+$/.test(size.stdout.trim())) throw Object.assign(new Error('无法验证环境变量文件大小'), { statusCode: 403 });
    if (Number(size.stdout.trim()) > MAX_ENV_BYTES) throw Object.assign(new Error('环境变量文件超过 256KB'), { statusCode: 413 });
    const { content } = await readArchiveFile(container, filePath, { maxBytes: MAX_ENV_BYTES });
    if (Buffer.byteLength(content, 'utf8') > MAX_ENV_BYTES) throw Object.assign(new Error('环境变量文件超过 256KB'), { statusCode: 413 });
    return content;
  } catch (error) {
    if (missingOk && error.statusCode === 404) return null;
    throw error;
  }
}

/** 读取项目 env 文件族中的一个文件(.env 默认;.env.example 作为 .env 的模板)。 */
export async function readProjectEnv(project, fileName = ENV_FILE) {
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  const target = normalizeEnvFileName(fileName);
  if (!target) throw Object.assign(new Error('环境变量文件名不合法'), { statusCode: 400 });
  const root = projectEnvRoot(project);
  const envPath = path.posix.join(root, target);
  const examplePath = path.posix.join(root, ENV_EXAMPLE);
  const readExample = target === ENV_FILE; // 只有主 .env 才有模板概念

  if (project.mounted) {
    const raw = await readHostFile(envPath);
    const exampleRaw = readExample ? await readHostFile(examplePath) : null;
    return buildEnvPayload({ file: target, envPath, examplePath: readExample ? examplePath : null, raw, exampleRaw });
  }
  if (!project.editable || !project.workspaceAvailable) {
    throw Object.assign(new Error('项目未启用 Compose 目录能力,无法读取环境变量'), { statusCode: 403 });
  }
  return withReadOnlyRunner(project, async (container) => {
    const raw = await readContainerFile(container, envPath, { missingOk: true });
    const exampleRaw = readExample ? await readContainerFile(container, examplePath, { missingOk: true }) : null;
    return buildEnvPayload({ file: target, envPath, examplePath: readExample ? examplePath : null, raw, exampleRaw });
  });
}

function buildEnvPayload({ file, envPath, examplePath, raw, exampleRaw }) {
  return {
    file: file || ENV_FILE,
    path: envPath,
    examplePath: examplePath || '',
    exists: raw != null,
    version: envFileVersion(raw),
    raw: raw ?? '',
    exampleRaw: exampleRaw ?? '',
    entries: parseDotenv(raw ?? ''),
    template: parseDotenv(exampleRaw ?? ''),
    exampleExists: exampleRaw != null,
  };
}

/** 把结构化条目合并为 raw(表格模式保存时使用)。 */
export function buildRawFromEntries(entries) {
  return serializeDotenv(entries);
}

/**
 * 保存 .env:先校验,再在项目根生成 .env.backup.<ts>,原子替换。
 * @param {object} project
 * @param {string} raw  新内容(优先)或 entries 生成
 * @param {Array} [entries]
 */
export async function saveProjectEnv(project, { raw, entries, expectedVersion }, fileName = ENV_FILE) {
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  const target = normalizeEnvFileName(fileName);
  if (!target) throw Object.assign(new Error('环境变量文件名不合法'), { statusCode: 400 });
  const content = raw != null ? raw : buildRawFromEntries(entries || []);
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_ENV_BYTES) {
    throw Object.assign(new Error('环境变量内容为空或超过 256KB'), { statusCode: 400 });
  }
  const validation = validateDotenv(content);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.errors.join('; ')), { statusCode: 422 });
  }
  const root = projectEnvRoot(project);
  const envPath = path.posix.join(root, target);
  const backupName = `${target}.backup.${Date.now()}.${randomBytes(3).toString('hex')}`;
  const backupPath = path.posix.join(root, backupName);

  return withProjectOperationLock(project.id, () => withEnvFileLock(`${project.id}:${envPath}`, async () => {
    if (project.mounted) {
      const existingStat = await assertRegularEnvTarget(envPath);
      try {
        await replaceEnvFileWithBackup({ envPath, backupPath, content, existingStat, expectedVersion });
      } catch (error) {
        throw Object.assign(error, { statusCode: error.statusCode || 500, message: error.statusCode ? error.message : `写入 ${target} 失败:${error.message}` });
      }
      addOperation({ projectId: project.id, projectName: project.projectName, action: 'env.save', status: 'success', detail: backupName });
      return { ok: true, path: envPath, backup: backupName, version: envFileVersion(content) };
    }

    if (!project.editable || !project.workspaceAvailable) {
      throw Object.assign(new Error('项目未启用 Compose 目录能力，无法写入环境变量'), { statusCode: 403 });
    }
    return withRunner(project, async (container) => {
      const result = await replaceWorkspaceEnvWithBackup({ container, root, envPath, backupPath, backupName, content, expectedVersion });
      addOperation({ projectId: project.id, projectName: project.projectName, action: 'env.save', status: 'success', detail: backupName });
      return { ...result, version: envFileVersion(content) };
    });
  }));
}


/**
 * 触发 .env 生效:执行 docker compose up -d --force-recreate。
 * 返回 Promise<number>(退出码),onOutput 流式回调。
 * 持项目操作锁:force-recreate 与 stop/restart/升级并发会互相踩踏。
 */
export async function applyProjectEnv(project, { onOutput = () => {}, onChild = () => {} } = {}) {
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  return withProjectOperationLock(project.id, async () => {
    if (project.mounted) {
      return new Promise((resolve, reject) => {
        const child = spawnComposeCommand(project, ['up', '-d', '--force-recreate']);
        onChild(child);
        child.stdout.on('data', (chunk) => onOutput('stdout', chunk.toString('utf8')));
        child.stderr.on('data', (chunk) => onOutput('stderr', chunk.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
      });
    }
    return runWorkspaceComposeArgs(project, ['up', '-d', '--force-recreate'], onOutput);
  });
}

/** 供项目 action 校验复用:env.apply 需要 editable。 */
export function assertEnvAccess(project) {
  if (!project?.managed) throw Object.assign(new Error('项目尚未加入管理'), { statusCode: 403 });
  if (!project.editable) {
    throw Object.assign(new Error('Compose 项目路径缺失或权限范围过宽,无法安全读写环境变量'), { statusCode: 403 });
  }
}
