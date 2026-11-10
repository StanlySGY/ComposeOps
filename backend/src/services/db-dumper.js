import { createReadStream, createWriteStream, promises as fs } from 'fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { fileURLToPath } from 'url';
import { getProjectDocker } from './docker-hosts.js';
import { readProjectEnv } from './project-env.js';
import { addOperation, addAlertEvent } from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_ROOT = path.join(__dirname, '../../data/backups/db');
await fs.mkdir(BACKUP_ROOT, { recursive: true }).catch(() => {});

/** 从镜像名识别数据库类型:postgres | mysql | mariadb | redis | mongo | null(纯函数,便于单测)。 */
export function detectDbType(image = '') {
  const name = String(image).toLowerCase();
  if (/postgres|postgis/.test(name)) return 'postgres';
  if (/mariadb/.test(name)) return 'mariadb';
  if (/mysql/.test(name)) return 'mysql';
  if (/redis|valkey/.test(name)) return 'redis';
  if (/mongo/.test(name)) return 'mongo';
  return null;
}

/** 从 .env 条目提取数据库凭据(纯函数,便于单测)。 */
export function envToDbConfig(entries = []) {
  const kv = {};
  for (const entry of entries) {
    if (entry && entry.key) kv[String(entry.key).toUpperCase()] = entry.value != null ? String(entry.value) : '';
  }
  const pick = (...keys) => keys.map((key) => kv[key]).find((value) => value && !value.startsWith('$'));
  return {
    user: pick('POSTGRES_USER', 'POSTGRESQL_USERNAME', 'MYSQL_USER', 'MONGO_INITDB_ROOT_USERNAME', 'MONGO_USERNAME') || '',
    password: pick('POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD', 'MYSQL_PASSWORD', 'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_PASSWORD') || '',
    db: pick('POSTGRES_DB', 'POSTGRESQL_DATABASE', 'MYSQL_DATABASE', 'MONGO_INITDB_DATABASE', 'MONGO_DB') || '',
    redisPassword: pick('REDIS_PASSWORD', 'REDISPASSWORD', 'REDIS_AUTH') || '',
  };
}

/** 构建容器内 dump 命令与所需环境变量(纯函数,便于单测)。 */
export function buildDumpCommand(type, cfg = {}) {
  const env = [];
  switch (type) {
    case 'postgres': {
      if (cfg.password) env.push(`PGPASSWORD=${cfg.password}`);
      const args = ['pg_dump', '--no-owner', '--no-acl'];
      if (cfg.user) args.push('-U', cfg.user);
      args.push('-d', cfg.db || 'postgres');
      return { cmd: args, env };
    }
    case 'mysql':
    case 'mariadb': {
      if (cfg.password) env.push(`MYSQL_PWD=${cfg.password}`);
      const args = ['mysqldump', '--single-transaction', '--no-tablespaces', '--skip-comments'];
      if (cfg.user) args.push('-u', cfg.user);
      args.push(cfg.db || '');
      return { cmd: args, env };
    }
    case 'mongo': {
      const args = ['mongodump', '--archive'];
      if (cfg.user) args.push('--username', cfg.user);
      if (cfg.password) args.push('--password', cfg.password);
      if (cfg.db) args.push('--db', cfg.db);
      return { cmd: args, env };
    }
    case 'redis': {
      const auth = cfg.redisPassword ? `-a '${String(cfg.redisPassword).replace(/'/g, "'\\''")}' --no-auth-warning ` : '';
      // 先 SYNC 生成 RDB 到 /tmp,再 cat 输出,dump 为纯二进制
      const script = `redis-cli ${auth}--rdb /tmp/composeops-redis-dump.rdb && cat /tmp/composeops-redis-dump.rdb`;
      return { cmd: ['sh', '-c', script], env };
    }
    default:
      throw new Error('不支持的数据库类型');
  }
}

/** 项目内运行中的数据库容器列表(供前端渲染选择)。 */
export async function listProjectDbContainers(project) {
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  const containers = (project.containers || []).filter((container) => container.state === 'running');
  const results = [];
  for (const container of containers) {
    const type = detectDbType(container.image);
    if (!type) continue;
    results.push({ containerId: container.id, containerName: container.name, type, image: container.image });
  }
  return results;
}

/** 读取项目 .env → 结构化配置;失败返回空配置。 */
export async function readDbEnv(project) {
  try {
    const payload = await readProjectEnv(project);
    return envToDbConfig(payload.entries || []);
  } catch {
    return {};
  }
}

/**
 * 在指定容器内执行 dump,同时把 gzip 输出流提供给响应,并把 .gz 留存到 data/backups/db/。
 * @returns {Promise<{ stream: PassThrough, filename: string, exitCode: number, type: string }>}
 */
export async function runDbDump(project, containerId, { dbName = '', download = true, signal } = {}) {
  if (!project?.managed) throw Object.assign(new Error('项目尚未加入管理'), { statusCode: 403 });
  const container = (project.containers || []).find((item) =>
    item.id === containerId || item.id.startsWith(containerId) || item.name === containerId);
  if (!container) throw Object.assign(new Error('容器未找到'), { statusCode: 404 });
  const type = detectDbType(container.image);
  if (!type) throw Object.assign(new Error('该容器不是支持的数据库服务'), { statusCode: 400 });

  const envCfg = await readDbEnv(project);
  if (dbName) envCfg.db = dbName;
  if (['mysql', 'mariadb', 'postgres'].includes(type) && !envCfg.db) {
    throw Object.assign(new Error('无法自动识别库名,请指定'), { statusCode: 400 });
  }
  const { cmd, env } = buildDumpCommand(type, envCfg);

  const docker = getProjectDocker(project);
  const instance = await docker.getContainer(container.id).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Env: env,
  });
  let execStream;
  try {
    execStream = await instance.start({ hijack: false, stdin: false });
  } catch (error) {
    throw Object.assign(new Error(`启动 dump 失败:${error.message}`), { statusCode: 502 });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = String(container.name).replace(/[^a-zA-Z0-9_-]/g, '-');
  const safeProject = String(project.projectName).replace(/[^a-zA-Z0-9_-]/g, '-');
  const filename = `${safeProject}-${safeName}-${stamp}-${randomUUID().slice(0, 8)}.${type === 'mongo' ? 'archive.gz' : type === 'redis' ? 'rdb.gz' : 'sql.gz'}`;
  const filePath = path.join(BACKUP_ROOT, filename);
  try {
    const result = await persistDumpStream(execStream, filePath, () => instance.inspect(), { signal });
    addOperation({ projectId: project.id, projectName: project.projectName, action: 'db.dump', status: 'success', detail: `${type} · ${container.name} · ${filename} · ${result.bytes} 字节` });
    return { ...result, ...(download ? { stream: createReadStream(filePath) } : {}), filename, exitCode: 0, type, savedPath: filePath };
  } catch (error) {
    addOperation({ projectId: project.id, projectName: project.projectName, action: 'db.dump', status: 'failed', detail: '导出失败，未保留不完整备份' });
    addAlertEvent({ key: `db-dump:${project.id}:${container.id}`, title: '数据库备份失败', detail: `${project.projectName} / ${container.name}：请检查数据库连接和可用空间后重试`, priority: 'danger', to: `/services?focus=${project.id}` });
    throw error;
  }
}

/** 按 Docker frame 解码，yield 跟随落盘背压；stderr 只保留有限大小，不混入备份。 */
async function* dumpStdout(source, state) {
  let header = Buffer.alloc(0);
  let remaining = 0;
  let type = 1;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!remaining) {
        const take = Math.min(8 - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (header.length < 8) continue;
        type = header[0];
        if (![1, 2].includes(type)) throw new Error('数据库导出数据帧无效');
        remaining = header.readUInt32BE(4);
        header = Buffer.alloc(0);
        if (!remaining) continue;
      }
      const take = Math.min(remaining, chunk.length - offset);
      const piece = chunk.subarray(offset, offset + take);
      offset += take;
      remaining -= take;
      if (type === 1) { state.rawBytes += piece.length; if (state.rawBytes > state.maxRawBytes) throw new Error('数据库备份超过容量限制'); yield piece; }
      else state.stderr = (state.stderr + piece.toString('utf8')).slice(-4096);
    }
  }
  if (remaining || header.length) throw new Error('数据库导出数据流提前结束');
}

/** 后台只写文件；完成、退出码和解压校验全部通过后原子发布。 */
export async function persistDumpStream(source, filePath, inspect, { signal, timeoutMs = 900000, maxRawBytes = Infinity } = {}) {
  const partial = `${filePath}.${randomUUID()}.partial`;
  const controller = new AbortController();
  const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(new Error('数据库备份超时')), timeoutMs);
  const abort = () => source.destroy(abortSignal.reason);
  abortSignal.addEventListener('abort', abort, { once: true });
  const state = { rawBytes: 0, stderr: '', maxRawBytes };
  try {
    abortSignal.throwIfAborted();
    await pipeline(dumpStdout(source, state), createGzip(), createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: abortSignal });
    const info = await new Promise((resolve, reject) => {
      const cancelled = () => reject(abortSignal.reason);
      if (abortSignal.aborted) return cancelled();
      abortSignal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(inspect).then(resolve, reject).finally(() => abortSignal.removeEventListener('abort', cancelled));
    });
    if (info.Running || info.ExitCode !== 0) throw new Error('数据库导出命令未成功结束，请检查数据库配置');
    if (!state.rawBytes) throw new Error('数据库导出为空，未生成备份');
    let verifiedBytes = 0;
    await pipeline(createReadStream(partial), createGunzip(), new Writable({ write(chunk, _, done) { verifiedBytes += chunk.length; done(); } }), { signal: abortSignal });
    if (verifiedBytes !== state.rawBytes) throw new Error('数据库备份完整性校验失败');
    const { size: bytes } = await fs.stat(partial);
    abortSignal.throwIfAborted();
    await fs.rename(partial, filePath);
    return { bytes, rawBytes: state.rawBytes, verified: true };
  } catch (error) {
    source.destroy();
    await fs.rm(partial, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
    abortSignal.removeEventListener('abort', abort);
  }
}
