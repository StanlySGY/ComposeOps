import { spawn } from 'child_process';
import { open, realpath, rename, lstat, unlink } from 'fs/promises';
import { constants } from 'node:fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { validateYaml } from '../lib/files.js';
import { addComposeBackup, getProjectPreference, getProjectMountEnabled } from '../lib/db.js';
import { CONFIG_FILE_MAX_BYTES, readHostConfigFile } from '../lib/config-file-read.js';
import { composeEnv, getProjectHost, assertProjectHostUnchanged } from './docker-hosts.js';
import { withProjectOperationLock } from './project-operation-lock.js';

const COMPOSE_BIN = process.env.COMPOSE_BIN || 'docker';

// 同一进程内对同一 Compose 文件的保存/恢复串行化，避免校验与替换交错。
const composeFileLocks = new Map();
export async function withComposeFileLock(filePath, task) {
  const previous = composeFileLocks.get(filePath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  composeFileLocks.set(filePath, current);
  await previous;
  try { return await task(); }
  finally {
    release();
    if (composeFileLocks.get(filePath) === current) composeFileLocks.delete(filePath);
  }
}

export function assertComposeVersion(currentContent, expectedContent) {
  if (expectedContent !== undefined && currentContent !== expectedContent) {
    throw Object.assign(new Error('Compose 文件已被其他操作修改，请刷新后重新编辑；本次保存未覆盖现有内容'), { statusCode: 409, code: 'COMPOSE_VERSION_CONFLICT' });
  }
}

export function assertComposeMetadata(current, expected, fields = ['mode', 'uid', 'gid']) {
  if (fields.some(key => current[key] !== expected[key])) {
    throw Object.assign(new Error('Compose 文件身份、所有者或权限已变化，请重新读取后操作'), { statusCode: 409, code: 'COMPOSE_VERSION_CONFLICT' });
  }
}

/** 替换文件与备份目录协调:失败时恢复原内容,避免留下误导性的备份记录。 */
export async function replaceComposeWithBackup({ replace, backup, rollback }) {
  try {
    await replace();
  } catch (replaceError) {
    if (replaceError.writeApplied === false) throw replaceError;
    await restoreOrThrow(rollback, replaceError, 'Compose 替换失败且原文件恢复失败');
    throw replaceError;
  }
  try {
    return await backup();
  } catch (backupError) {
    await restoreOrThrow(rollback, backupError, 'Compose 备份写入失败且原文件恢复失败');
    throw backupError;
  }
}

async function restoreOrThrow(rollback, cause, message) {
  try {
    await rollback();
  } catch (rollbackError) {
    const error = new Error(`${message}: ${rollbackError.message}`, { cause });
    error.code = 'COMPOSE_SAVE_ROLLBACK_FAILED';
    error.statusCode = 500;
    error.rollbackError = rollbackError;
    throw error;
  }
}

/** 组合节点环境变量(DOCKER_HOST)与 Compose 超时变量。 */
export function nodeEnv(project) {
  assertProjectHostUnchanged(project);
  const hostEnv = composeEnv(getProjectHost(project));
  return {
    ...process.env,
    ...hostEnv,
    COMPOSE_HTTP_TIMEOUT: '300',
    COMPOSE_PROGRESS: 'plain',
  };
}

const ACTIONS = {
  up: ['up', '-d'],
  stop: ['stop'],
  restart: ['restart'],
  pull: ['pull'],
  ps: ['ps'],
};

function composeBase() {
  if (COMPOSE_BIN === 'docker') return ['docker', 'compose'];
  if (COMPOSE_BIN === 'docker-compose') return ['docker-compose'];
  const parts = COMPOSE_BIN.trim().split(/\s+/);
  if (!parts[0]) throw new Error('COMPOSE_BIN 配置无效');
  return parts;
}

export async function resolveProjectFile(project, fileIndex = 0) {
  const index = Number(fileIndex);
  if (!Number.isInteger(index) || index < 0 || index >= project.composeFiles.length) {
    throw Object.assign(new Error('Compose 文件不存在'), { statusCode: 404 });
  }
  const root = await realpath(project.workingDir);
  const expected = await Promise.all(project.composeFiles.map((file) => realpath(file)));
  const selected = expected[index];
  if (!(selected === root || selected.startsWith(`${root}${path.sep}`))) {
    throw Object.assign(new Error('Compose 文件不在项目目录内'), { statusCode: 403 });
  }
  return selected;
}

export function composeProjectOptions(project, files = project.composeFiles) {
  // Discovered project identity must win over directory names, .env and a
  // changed top-level `name:`. Otherwise `up` can create a different stack.
  const name = project.projectName;
  return [...(name ? ['--project-name', name] : []), ...files.flatMap((file) => ['-f', file])];
}

export function composeArgs(project, action, overrideFiles = null) {
  const actionArgs = ACTIONS[action];
  if (!actionArgs) throw Object.assign(new Error('不支持的 Compose 操作'), { statusCode: 400 });
  const files = overrideFiles || project.composeFiles;
  return [...composeBase().slice(1), ...composeProjectOptions(project, files), ...actionArgs];
}

export function spawnComposeCommand(project, args, overrideFiles = null) {
  const base = composeBase();
  const files = overrideFiles || project.composeFiles;
  return spawn(base[0], [...base.slice(1), ...composeProjectOptions(project, files), ...args], {
    cwd: project.workingDir,
    env: nodeEnv(project),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export const COMPOSE_OPERATION_TIMEOUT_MS = 30000;

export function spawnCompose(project, action) {
  const base = composeBase();
  return spawn(base[0], composeArgs(project, action), {
    cwd: project.workingDir,
    env: nodeEnv(project),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runConfigCheck(project, files, { timeoutMs = COMPOSE_OPERATION_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const base = composeBase();
    const args = [...base.slice(1), ...composeProjectOptions(project, files), 'config', '--quiet'];
    const child = spawn(base[0], args, {
      cwd: project.workingDir,
      env: nodeEnv(project),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.resume();
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error('Compose 校验超时，请检查节点连接后重试'), { statusCode: 504 }));
      try { assertProjectHostUnchanged(project); } catch (error) { reject(error); return; }
      if (code === 0) resolve();
      else reject(Object.assign(new Error(stderr.trim() || `docker compose config 退出码 ${code}`), {
        statusCode: 422,
      }));
    });
  });
}

export async function readCompose(project, fileIndex = 0) {
  const filePath = await resolveProjectFile(project, fileIndex);
  return { fileIndex: Number(fileIndex), path: filePath, content: (await readHostConfigFile(filePath)).content };
}

export function assertComposeWriteAccess(project) {
  assertProjectHostUnchanged(project);
  if (!project?.managed || !project.editable || !getProjectPreference(project.id).managed || !getProjectMountEnabled(project.id)) {
    throw Object.assign(new Error('该项目的纳管或 Compose 目录授权已失效，请重新确认权限'), { statusCode: 403 });
  }
}

// Stage privately and recheck immediately before rename. This catches edits
// during validation; it does not claim a cross-process filesystem CAS.
export async function replaceHostComposeFile(filePath, content, previous, { validate = async () => {}, beforeReplace = async () => {} } = {}) {
  const tempPath = path.join(path.dirname(filePath), `.composeops-${randomBytes(8).toString('hex')}.tmp`);
  let handle, published = false;
  try {
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const identity = await handle.stat();
    await handle.writeFile(content, 'utf8');
    await validate(tempPath);
    await handle.chown(previous.stat.uid, previous.stat.gid);
    await handle.chmod(previous.stat.mode & 0o7777);
    await handle.sync();
    await beforeReplace();
    const current = await readHostConfigFile(filePath);
    assertComposeVersion(current.content, previous.content);
    assertComposeMetadata(current.stat, previous.stat, ['dev', 'ino', 'mode', 'uid', 'gid']);
    const staged = await lstat(tempPath);
    if (!staged.isFile() || staged.dev !== identity.dev || staged.ino !== identity.ino) {
      throw Object.assign(new Error('临时配置文件已被替换，已中止保存'), { statusCode: 409 });
    }
    await rename(tempPath, filePath);
    published = true;
    return { content, stat: await handle.stat() };
  } catch (error) {
    error.writeApplied = published;
    throw error;
  } finally {
    await handle?.close();
    if (!published) await unlink(tempPath).catch(() => {});
  }
}

export async function saveCompose(project, fileIndex, content, reason = 'save', expectedContent = undefined) {
  assertComposeWriteAccess(project);
  if (typeof content !== 'string' || !content.length) throw Object.assign(new Error('Compose 内容为空'), { statusCode: 400 });
  if (Buffer.byteLength(content, 'utf8') > CONFIG_FILE_MAX_BYTES) throw Object.assign(new Error('Compose 内容超过 2MiB'), { statusCode: 413 });
  validateYaml(content);
  return withProjectOperationLock(project.id, async () => {
    assertComposeWriteAccess(project);
    const filePath = await resolveProjectFile(project, fileIndex);
    return withComposeFileLock(filePath, async () => {
      const previous = await readHostConfigFile(filePath);
      assertComposeVersion(previous.content, expectedContent);
      await replaceComposeWithBackup({
        replace: () => replaceHostComposeFile(filePath, content, previous, {
          validate: tempPath => {
            const checkFiles = [...project.composeFiles];
            checkFiles[Number(fileIndex)] = tempPath;
            return runConfigCheck(project, checkFiles);
          },
          beforeReplace: async () => {
            assertComposeWriteAccess(project);
            if (await resolveProjectFile(project, fileIndex) !== filePath) throw Object.assign(new Error('Compose 文件路径已变化，请重新读取'), { statusCode: 409, code: 'COMPOSE_VERSION_CONFLICT' });
          },
        }),
        backup: () => addComposeBackup(project.id, filePath, previous.content, reason),
        rollback: async () => {
          const written = await readHostConfigFile(filePath);
          assertComposeVersion(written.content, content);
          await replaceHostComposeFile(filePath, previous.content, { ...written, stat: { ...written.stat, uid: previous.stat.uid, gid: previous.stat.gid, mode: previous.stat.mode } });
        },
      });
      return { ok: true, path: filePath };
    });
  });
}

export { ACTIONS };
