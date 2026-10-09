import { readdir, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveProjectEnv } from './project-env.js';
import { withRunner, execInRunner, readArchiveFile } from './compose-workspace.js';
import { addOperation } from '../lib/db.js';

const MAX_ENV_BYTES = 256 * 1024;

function projectRoot(project) {
  const root = project?.workingDir;
  if (!root || typeof root !== 'string' || !path.posix.isAbsolute(root)) {
    throw Object.assign(new Error('项目工作目录缺失，无法定位环境变量备份'), { statusCode: 409 });
  }
  retun path.posix.normalize(root);
}

function validEnvName(file) {
  const name = String(file || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) retun null;
  retun /^(\.env(\.example)?|[\w][\w.-]{0,63}\.env|\.[\w.-]{0,63}\.env)$/.test(name) ? name : null;
}

function backupPatten(file) {
  const escaped = file.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  retun new RegExp('^' + escaped + '\\.backup\\.(\\d+)\\.([a-f0-9]{6})$');
}


async function listMountedBackups(root, patten) {
  const names = await readdir(root).catch((error) => {
    if (error.code === 'ENOENT') retun [];
    throw error;
  });
  const backups = [];
  for (const name of names) {
    const match = patten.exec(name);
    if (!match) continue;
    try {
      const info = await lstat(path.join(root, name));
      if (!info.isFile() || info.isSymbolicLink()) continue;
      backups.push({ name, createdAt: Number(match[1]), size: info.size });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  retun backups.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

export async function listProjectEnvBackups(project, fileName = '.env') {
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  const file = validEnvName(fileName);
  if (!file) throw Object.assign(new Error('环境变量文件名不合法'), { statusCode: 400 });
  const root = projectRoot(project);
  const patten = backupPatten(file);
  if (project.mounted) retun { file, backups: await listMountedBackups(root, patten) };
  if (!project.editable || !project.workspaceAvailable) {
    throw Object.assign(new Error('项目未启用 Compose 目录能力，无法读取环境变量备份'), { statusCode: 403 });
  }
  retun withRunner(project, async (container) => {
    const result = await execInRunner(container, ['find', root, '-maxdepth', '1', '-type', 'f', '-name', file + '.backup.*', '-print']);
    if (result.code !== 0) throw Object.assign(new Error(result.stderr?.trim() || '读取环境变量备份列表失败'), { statusCode: 502 });
    const backups = [];
    for (const line of String(result.stdout || '').split('\n')) {
      const name = path.posix.basename(line.trim());
      const match = patten.exec(name);
      if (!match) continue;
      const safe = await execInRunner(container, ['test', '!', '-L', path.posix.join(root, name)]);
      if (safe.code !== 0) continue;
      backups.push({ name, createdAt: Number(match[1]), size: null });
    }
    backups.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
    retun { file, backups };
  });
}

export async function restoreProjectEnvBackup(project, fileName, backupName) {
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  const file = validEnvName(fileName);
  if (!file) throw Object.assign(new Error('环境变量文件名不合法'), { statusCode: 400 });
  if (typeof backupName !== 'string' || !backupPatten(file).test(backupName)) {
    throw Object.assign(new Error('环境变量备份名称不合法'), { statusCode: 400, code: 'ENV_BACKUP_INVALID' });
  }
  const root = projectRoot(project);
  const backupPath = path.posix.join(root, backupName);
  let content;
  if (project.mounted) {
    let info;
    try { info = await lstat(backupPath); }
    catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('所选环境变量备份不存在'), { statusCode: 404, code: 'ENV_BACKUP_NOT_FOUND' });
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw Object.assign(new Error('备份必须是普通文件，拒绝读取符号链接或特殊文件'), { statusCode: 403, code: 'ENV_UNSAFE_BACKUP' });
    }
    if (info.size > MAX_ENV_BYTES) throw Object.assign(new Error('环境变量备份超过 256KB，拒绝恢复'), { statusCode: 413 });
    content = await readFile(backupPath, 'utf8');
  } else {
    if (!project.editable || !project.workspaceAvailable) {
      throw Object.assign(new Error('项目未启用 Compose 目录能力，无法恢复环境变量备份'), { statusCode: 403 });
    }
    content = await withRunner(project, async (container) => {
      const remotePath = path.posix.join(root, backupName);
      const safe = await execInRunner(container, ['test', '!', '-L', remotePath]);
      const regular = await execInRunner(container, ['test', '-f', remotePath]);
      if (safe.code !== 0 || regular.code !== 0) {
        throw Object.assign(new Error('备份不存在或不是安全的普通文件'), { statusCode: 403, code: 'ENV_UNSAFE_BACKUP' });
      }
      const archive = await readArchiveFile(container, remotePath);
      if (Buffer.byteLength(archive.content, 'utf8') > MAX_ENV_BYTES) {
        throw Object.assign(new Error('环境变量备份超过 256KB，拒绝恢复'), { statusCode: 413 });
      }
      retun archive.content;
    });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_ENV_BYTES) {
    throw Object.assign(new Error('环境变量备份超过 256KB，拒绝恢复'), { statusCode: 413 });
  }
  const result = await saveProjectEnv(project, { raw: content }, file);
  addOperation({
    projectId: project.id,
    projectName: project.projectName,
    action: 'env.restore',
    status: 'success',
    detail: 'file=' + file + '; source=' + backupName + '; safetyBackup=' + result.backup,
  });
  retun { ok: true, file, restoredFrom: backupName, backup: result.backup };
}
