import { spawn } from 'child_process';
import { chmod, chown, readFile, realpath, rename, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { validateYaml } from '../lib/files.js';
import { addComposeBackup } from '../lib/db.js';
import { composeEnv, getActiveHost } from './docker-hosts.js';

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

/** 替换文件与备份目录协调:失败时恢复原内容,避免留下误导性的备份记录。 */
export async function replaceComposeWithBackup({ replace, backup, rollback }) {
  try {
    await replace();
  } catch (replaceError) {
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
  const hostEnv = composeEnv(project?.host || getActiveHost());
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

export function composeArgs(project, action, overrideFiles = null) {
  const actionArgs = ACTIONS[action];
  if (!actionArgs) throw Object.assign(new Error('不支持的 Compose 操作'), { statusCode: 400 });
  const files = overrideFiles || project.composeFiles;
  return [...composeBase().slice(1), ...files.flatMap((file) => ['-f', file]), ...actionArgs];
}

export function spawnComposeCommand(project, args, overrideFiles = null) {
  const base = composeBase();
  const files = overrideFiles || project.composeFiles;
  return spawn(base[0], [...base.slice(1), ...files.flatMap((file) => ['-f', file]), ...args], {
    cwd: project.workingDir,
    env: nodeEnv(project),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export const COMPOSE_OPERATION_TIMEOUT_MS = 300000;

export function spawnCompose(project, action) {
  const base = composeBase();
  return spawn(base[0], composeArgs(project, action), {
    cwd: project.workingDir,
    env: nodeEnv(project),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runConfigCheck(project, files) {
  return new Promise((resolve, reject) => {
    const base = composeBase();
    const args = [...base.slice(1), ...files.flatMap((file) => ['-f', file]), 'config', '--quiet'];
    const child = spawn(base[0], args, {
      cwd: project.workingDir,
      env: nodeEnv(project),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(stderr.trim() || `docker compose config 退出码 ${code}`), {
        statusCode: 422,
      }));
    });
  });
}

export async function readCompose(project, fileIndex = 0) {
  const filePath = await resolveProjectFile(project, fileIndex);
  return { fileIndex: Number(fileIndex), path: filePath, content: await readFile(filePath, 'utf8') };
}

export async function saveCompose(project, fileIndex, content, reason = 'save', expectedContent = undefined) {
  if (typeof content !== 'string' || content.length === 0 || content.length > 2 * 1024 * 1024) {
    throw Object.assign(new Error('Compose 内容为空或超过 2MB'), { statusCode: 400 });
  }
  validateYaml(content);
  const filePath = await resolveProjectFile(project, fileIndex);
  return withComposeFileLock(filePath, async () => {
    const previous = await readFile(filePath, 'utf8');
    assertComposeVersion(previous, expectedContent);
    const currentStat = await stat(filePath);
    const tempPath = path.join(path.dirname(filePath), `.composeops-${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(tempPath, content, { encoding: 'utf8', mode: currentStat.mode });
    try {
      const checkFiles = [...project.composeFiles];
      checkFiles[Number(fileIndex)] = tempPath;
      await runConfigCheck(project, checkFiles);
      await chown(tempPath, currentStat.uid, currentStat.gid).catch(() => {});
      await replaceComposeWithBackup({
        replace: async () => {
          await rename(tempPath, filePath);
          await chmod(filePath, currentStat.mode);
        },
        backup: () => addComposeBackup(project.id, filePath, previous, reason),
        rollback: async () => {
          const rollbackPath = path.join(path.dirname(filePath), `.composeops-${randomBytes(8).toString('hex')}.rollback`);
          try {
            await writeFile(rollbackPath, previous, { encoding: 'utf8', mode: currentStat.mode });
            await chown(rollbackPath, currentStat.uid, currentStat.gid).catch(() => {});
            await rename(rollbackPath, filePath);
            await chmod(filePath, currentStat.mode);
          } finally {
            await unlink(rollbackPath).catch(() => {});
          }
        },
      });
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
    return { ok: true, path: filePath };
  });
}

export { ACTIONS };
