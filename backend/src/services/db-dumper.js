import { createWriteStream, promises as fs } from 'fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'url';
import { getActivityDocker } from './docker-hosts.js';
import { demuxStream } from '../lib/docker-streams.js';
import { readProjectEnv } from './project-env.js';
import { addOperation } from '../lib/db.js';

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
export async function runDbDump(project, containerId, { dbName = '' } = {}) {
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

  const docker = getActivityDocker();
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

  const demux = demuxStream();
  execStream.pipe(demux);

  const gzip = createGzip();
  const output = new PassThrough();
  const localSink = new PassThrough();
  gzip.pipe(output);
  gzip.pipe(localSink);

  let stderr = '';
  demux.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  demux.stdout.pipe(gzip);

  // exec 结束 = stdout 与 stderr 都结束;随后查询 exec 退出码
  const streamEnded = new Promise((resolve) => {
    let done = 0;
    const maybe = () => { done += 1; if (done === 2) resolve(); };
    demux.stdout.on('end', maybe);
    demux.stderr.on('end', maybe);
  });
  // 保险:execStream 结束也视为完成
  execStream.on('end', () => streamEnded.catch(() => {}));
  execStream.on('error', (error) => { gzip.destroy(error); output.destroy(error); });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = String(container.name).replace(/[^a-zA-Z0-9_-]/g, '-');
  const filename = `${project.projectName}-${safeName}-${stamp}.${type === 'mongo' ? 'archive.gz' : 'sql.gz'}`;
  const filePath = path.join(BACKUP_ROOT, filename);
  const sink = createWriteStream(filePath);
  localSink.pipe(sink);
  sink.on('error', (error) => { output.destroy(error); });

  await streamEnded;
  let exitCode = 1;
  try {
    const info = await instance.inspect();
    exitCode = info.ExitCode ?? 1;
  } catch { /* exec inspect 失败时使用默认失败码。 */ }
  // 让 gzip 收尾(可能还有少量尾部数据)
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!gzip.writableEnded) gzip.end();
  await new Promise((resolve) => {
    let check = 0;
    const maybe = () => { check += 1; if (check >= 2) resolve(); };
    output.on('end', maybe);
    localSink.on('end', maybe);
    setTimeout(resolve, 3000);
  });

  addOperation({
    projectId: project.id,
    projectName: project.projectName,
    action: 'db.dump',
    status: exitCode === 0 ? 'success' : 'failed',
    detail: `${type} · ${container.name} · ${filename}${stderr ? ` · ${stderr.slice(0, 200)}` : ''}`,
  });
  return { stream: output, filename, exitCode, type, savedPath: filePath };
}
