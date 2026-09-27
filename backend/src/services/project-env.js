import { readFile, rename, writeFile, unlink } from 'fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseDotenv, serializeDotenv, validateDotenv } from '../lib/dotenv.js';
import { spawnComposeCommand } from './compose-runner.js';
import { withRunner, execInRunner, readArchiveFile, putArchiveFile, runWorkspaceComposeArgs } from './compose-workspace.js';
import { addOperation } from '../lib/db.js';
import { withProjectOperationLock } from './project-operation-lock.js';

const ENV_FILE = '.env';
const ENV_EXAMPLE = '.env.example';
const MAX_ENV_BYTES = 256 * 1024;
// 环境变量文件族:.env / *.env / .env.example(如 multi.env、.env.production)
const ENV_FILE_PATTERN = /^(\.env(\.example)?|[\w][\w.-]{0,63}\.env|\.[\w.-]{0,63}\.env)$/;

/** 校验文件名属于 env 文件族且无路径穿越;非法返回 null。 */
export function normalizeEnvFileName(file) {
  const name = String(file || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return ENV_FILE_PATTERN.test(name) ? name : null;
}

/** 列出项目根目录下的 env 文件族(mounted 走宿主目录,workspace 走容器内 ls)。 */
export async function listProjectEnvFiles(project) {
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  const root = projectEnvRoot(project);
  const names = new Set([ENV_FILE]);
  if (project.mounted) {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(root).catch(() => []);
    for (const entry of entries) if (ENV_FILE_PATTERN.test(entry)) names.add(entry);
  } else {
    if (!project.editable || !project.workspaceAvailable) {
      throw Object.assign(new Error('项目未启用 Compose 目录能力,无法读取环境变量'), { statusCode: 403 });
    }
    return withRunner(project, async (container) => {
      const result = await execInRunner(container, ['ls', '-1A', '--', root]).catch(() => ({ stdout: '' }));
      for (const line of String(result.stdout || '').split('\n')) {
        const name = line.trim();
        if (name && ENV_FILE_PATTERN.test(name)) names.add(name);
      }
      return [...names].sort().map((name) => ({ name, exists: true }));
    });
  }
  return [...names].sort().map((name) => ({ name, exists: true }));
}

function projectEnvRoot(project) {
  const root = project.workingDir;
  if (!root || typeof root !== 'string' || !path.posix.isAbsolute(root)) {
    throw Object.assign(new Error('项目工作目录缺失,无法定位 .env'), { statusCode: 409 });
  }
  return path.posix.normalize(root);
}

async function readHostFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readContainerFile(container, filePath, { missingOk = false } = {}) {
  try {
    const { content } = await readArchiveFile(container, filePath);
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
  return withRunner(project, async (container) => {
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
export async function saveProjectEnv(project, { raw, entries }, fileName = ENV_FILE) {
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  const target = normalizeEnvFileName(fileName);
  if (!target) throw Object.assign(new Error('环境变量文件名不合法'), { statusCode: 400 });
  const content = raw != null ? raw : buildRawFromEntries(entries || []);
  if (typeof content !== 'string' || content.length > MAX_ENV_BYTES) {
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

  if (project.mounted) {
    const previous = await readHostFile(envPath) ?? '';
    const tempPath = `${envPath}.tmp.${randomBytes(4).toString('hex')}`;
    try {
      await writeFile(backupPath, previous, 'utf8');
      await writeFile(tempPath, content, 'utf8');
      await rename(tempPath, envPath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw Object.assign(new Error(`写入 ${target} 失败:${error.message}`), { statusCode: 500 });
    }
    addOperation({ projectId: project.id, projectName: project.projectName, action: 'env.save', status: 'success', detail: backupName });
    return { ok: true, path: envPath, backup: backupName };
  }
  // workspace 容器模式:在容器内读旧内容 → 写备份文件 → 写目标文件
  return withRunner(project, async (container) => {
    const previous = await readContainerFile(container, envPath, { missingOk: true }) ?? '';
    // 备份文件写在项目根(容器内与宿主机同路径绑定)
    await putArchiveFile(container, root, backupName, previous, { mode: 0o600, uid: 0, gid: 0 });
    try {
      await putArchiveFile(container, root, target, content, { mode: 0o600, uid: 0, gid: 0 });
    } catch (error) {
      await execInRunner(container, ['rm', '-f', '--', backupPath]).catch(() => {});
      throw Object.assign(new Error(`写入 ${target} 失败:${error.message}`), { statusCode: 500 });
    }
    addOperation({ projectId: project.id, projectName: project.projectName, action: 'env.save', status: 'success', detail: backupName });
    return { ok: true, path: envPath, backup: backupName };
  });
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
