import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { Writable } from 'node:stream';
import { persistDumpStream } from './db-dumper.js';
import { businessAssertionSql, isolatedEnvironment } from './business-recovery-config.js';
import { withReadTimeout } from './incident-observer.js';
import { incidentError } from './incident-store.js';

/** Bounded Docker exec. Commands and credentials are never included in errors/output records. */
export async function businessExec(container, cmd, env = [], { input, timeoutMs = 30000, maxBytes = 65536 } = {}) {
  const instance = await withReadTimeout(container.exec({ Cmd: ['timeout', '-s', 'KILL', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ...cmd], Env: env, AttachStdout: true, AttachStderr: true, AttachStdin: !!input, Tty: false }));
  const stream = await withReadTimeout(instance.start({ hijack: !!input, stdin: !!input }));
  let text = '', count = 0, timer;
  const stdout = new Writable({ write(chunk, _, done) { count += chunk.length; if (count > maxBytes) return done(new Error('数据库命令输出超出限制')); text += chunk.toString('utf8'); done(); } });
  const stderr = new Writable({ write(_chunk, _, done) { done(); } });
  const done = new Promise((resolve, reject) => {
    stream.once('end', resolve); stream.once('error', reject);
    stream.once('close', () => { if (!stream.readableEnded) reject(new Error('数据库命令连接中断')); });
    stdout.once('error', reject); stderr.once('error', reject); input?.once('error', reject);
    timer = setTimeout(() => reject(Object.assign(new Error('数据库命令超时'), { statusCode: 504 })), timeoutMs);
  });
  container.modem.demuxStream(stream, stdout, stderr);
  if (input) input.pipe(stream);
  try {
    await done;
    const result = await withReadTimeout(instance.inspect());
    if (result.Running || result.ExitCode !== 0) throw new Error('数据库命令未成功结束，请核对凭据、数据库权限与兼容性');
    return text.trim();
  } finally { clearTimeout(timer); input?.destroy(); stream.destroy(); stdout.destroy(); stderr.destroy(); }
}
const client = (config, password, root = false) => config.engine === 'postgres'
  ? { cmd: ['psql', '-X', '-h', '127.0.0.1', '-U', config.user, '-d', config.database, '-v', 'ON_ERROR_STOP=1', '-At'], env: ['PGPASSWORD=' + password, 'PGOPTIONS=-c statement_timeout=15000 -c default_transaction_read_only=on'] }
  : { cmd: [config.engine === 'mariadb' ? 'mariadb' : 'mysql', '--protocol=TCP', '-h', '127.0.0.1', '-u', root ? 'root' : config.user, '--batch', '--skip-column-names', '--raw', config.database], env: ['MYSQL_PWD=' + password] };
export async function businessDump(container, config, password, file, options = {}) {
  if (config.engine !== 'postgres') {
    const cli = client(config, password);
    const unsafe = await businessExec(container, [...cli.cmd, '-e', `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${config.database}' AND table_type='BASE TABLE' AND engine<>'InnoDB'`], cli.env);
    if (unsafe !== '0') throw incidentError('MySQL/MariaDB 仅允许全 InnoDB 的一致性快照；检测到非事务表');
  }
  const cmd = config.engine === 'postgres'
    ? ['pg_dump', '-h', '127.0.0.1', '-U', config.user, '-d', config.database, '--format=custom', '--no-owner', '--no-acl', '--lock-wait-timeout=10000']
    : [config.engine === 'mariadb' ? 'mariadb-dump' : 'mysqldump', '--protocol=TCP', '-h', '127.0.0.1', '-u', config.user, '--single-transaction', '--quick', '--skip-lock-tables', '--no-tablespaces', '--hex-blob', '--routines', '--events', '--triggers', ...(config.engine === 'mysql' ? ['--set-gtid-purged=OFF'] : []), config.database];
  const env = [config.engine === 'postgres' ? 'PGPASSWORD=' + password : 'MYSQL_PWD=' + password];
  const instance = await withReadTimeout(container.exec({ Cmd: ['timeout', '-s', 'KILL', '900', ...cmd], Env: env, AttachStdout: true, AttachStderr: true, Tty: false }));
  const stream = await withReadTimeout(instance.start({}));
  return persistDumpStream(stream, file, () => instance.inspect(), { maxRawBytes: 2 * 1024 ** 3, timeoutMs: 930000, ...options });
}
export async function restoreBusinessDump(container, config, password, file, timeoutMs) {
  const cli = client(config, password, config.engine !== 'postgres');
  const cmd = config.engine === 'postgres'
    ? ['pg_restore', '-h', '127.0.0.1', '-U', config.user, '-d', config.database, '--no-owner', '--no-acl', '--single-transaction', '--exit-on-error'] : cli.cmd;
  const source = createReadStream(file), input = createGunzip();
  source.on('error', error => input.destroy(error)); source.pipe(input);
  const env = config.engine === 'postgres' ? ['PGPASSWORD=' + password] : cli.env;
  try { await businessExec(container, cmd, env, { input, timeoutMs }); }
  finally { source.destroy(); input.destroy(); }
}
export async function verifyBusinessData(container, config, password) {
  const cli = client(config, password);
  const results = [];
  for (const assertion of config.assertions) {
    const output = await businessExec(container, [...cli.cmd, config.engine === 'postgres' ? '-c' : '-e', businessAssertionSql(config, assertion)], cli.env);
    results.push({ table: assertion.table, column: assertion.column || null, expectedRows: assertion.expectedRows, actualRows: /^\d+$/.test(output) ? Number(output) : null, passed: output === String(assertion.expectedRows) });
  }
  return results;
}
export async function waitBusinessDatabase(container, config, password, { sleep, deadline }) {
  const cli = client(config, password, config.engine !== 'postgres');
  while (Date.now() < deadline) {
    try { await businessExec(container, [...cli.cmd, config.engine === 'postgres' ? '-c' : '-e', 'SELECT 1'], cli.env, { timeoutMs: Math.min(5000, deadline - Date.now()) }); return; }
    catch { await sleep(1000); }
  }
  throw incidentError('隔离数据库未在期限内就绪', 504);
}
export function recoveryContainerConfig(image, network, labels, alias, { env = [], cmd, entrypoint, user, mounts = [], database = false } = {}) {
  return { Image: image, Env: env, ...(cmd ? { Cmd: cmd } : {}), ...(entrypoint ? { Entrypoint: entrypoint } : {}), ...(user ? { User: user } : {}),
    Labels: labels, HostConfig: { NetworkMode: network, Mounts: mounts, Memory: database ? 1024 ** 3 : 512 * 1024 ** 2, NanoCpus: 1e9, PidsLimit: 256,
      CapDrop: ['ALL'], CapAdd: database ? ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'] : [], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } } },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [alias] } } } };
}
export function databaseEnvironment(config, password) {
  if (config.engine === 'postgres') return [`POSTGRES_USER=${config.user}`, `POSTGRES_DB=${config.database}`, `POSTGRES_PASSWORD=${password}`];
  const prefix = config.engine === 'mariadb' ? 'MARIADB' : 'MYSQL';
  return [`${prefix}_DATABASE=${config.database}`, `${prefix}_ROOT_PASSWORD=${password}`, ...(config.user === 'root' ? [] : [`${prefix}_USER=${config.user}`, `${prefix}_PASSWORD=${password}`])];
}
export { isolatedEnvironment };
// Runs inside a dedicated helper on the isolated network; never resolves a supplied URL.
export function businessHttpProbeScript(http) {
  return `const http = require('node:http'); const expected = ${JSON.stringify(http)}; const req = http.get({hostname:'recovery-app',port:expected.port,path:expected.path,timeout:5000}, res => { let body='', size=0; res.on('data', chunk => {size+=chunk.length; if(size>65536) req.destroy(new Error('body limit')); else body+=chunk.toString();}); res.on('end', () => { console.log(JSON.stringify({statusCode:res.statusCode,bodyMatched:body.includes(expected.bodyContains)})); process.exit(res.statusCode===expected.expectedStatus && body.includes(expected.bodyContains)?0:1); }); }); req.on('timeout',()=>req.destroy(new Error('timeout'))); req.on('error',()=>process.exit(2));`;
}
