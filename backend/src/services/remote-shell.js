import ssh2 from 'ssh2';
import path from 'node:path';
import { CONFIG_FILE_MAX_BYTES, assertConfigSize, configReadError, withFileReadDeadline } from '../lib/config-file-read.js';
import { normalizeHostDirectory } from './host-directory-paths.js';
import { createSshHostVerifier } from '../lib/ssh-fingerprint.js';
import { assertSshPrivateKey } from '../lib/ssh-private-key.js';

const { Client } = ssh2;

function shellQuote(value) {
  const text = String(value);
  if (/[\n\r\0]/.test(text)) {
    throw Object.assign(new Error('命令参数包含非法字符'), { statusCode: 400 });
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(args) {
  if (!Array.isArray(args) || !args.length) {
    throw Object.assign(new Error('远端命令为空'), { statusCode: 400 });
  }
  return args.map(shellQuote).join(' ');
}

function connect(host) {
  return new Promise((resolve, reject) => {
    if (!host?.host) {
      reject(Object.assign(new Error('当前 SSH 节点缺少主机地址'), { statusCode: 409 }));
      return;
    }
    if (host.privateKey) assertSshPrivateKey(host.privateKey, host.password);
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(Object.assign(new Error('SSH 连接超时'), { statusCode: 504 }));
    }, 15000);
    timer.unref?.();
    conn.on('ready', () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const options = {
      host: host.host,
      port: Number(host.port) || 22,
      username: host.username || 'root',
      readyTimeout: 15000,
    };
    if (host.privateKey) {
      options.privateKey = host.privateKey;
      if (host.password) options.passphrase = host.password;
    } else if (host.password) {
      options.password = host.password;
    }
    if (host.hostFingerprint) {
      options.hostHash = 'sha256';
      options.hostVerifier = createSshHostVerifier(host.hostFingerprint);
    }
    if (!options.privateKey && !options.password && process.env.SSH_AUTH_SOCK) {
      options.agent = process.env.SSH_AUTH_SOCK;
    }
    conn.connect(options);
  });
}

async function withSsh(host, fn) {
  const conn = await connect(host);
  try {
    return await fn(conn);
  } finally {
    conn.end();
  }
}

function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

function assertAbsolute(filePath) {
  if (typeof filePath !== 'string' || !filePath.startsWith('/') || filePath.includes('\0')) {
    throw Object.assign(new Error('远端路径不合法'), { statusCode: 400 });
  }
}

export function sshExec(host, args, { onOutput = () => {}, onExec = null, timeoutMs = 300000 } = {}) {
  const command = shellJoin(args);
  return withSsh(host, (conn) => new Promise((resolve, reject) => {
    conn.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const maxOutputBytes = 1024 * 1024;
      const timer = setTimeout(() => {
        stream.close();
        reject(Object.assign(new Error('远端命令执行超时'), { statusCode: 504 }));
      }, timeoutMs);
      timer.unref?.();
      if (typeof onExec === 'function') {
        onExec({ kill: () => { try { stream.close(); } catch { /* 断流即止损 */ } } });
      }
      stream.on('data', (chunk) => {
        if (stdoutBytes < maxOutputBytes) {
          const part = chunk.subarray(0, maxOutputBytes - stdoutBytes);
          stdout.push(part);
          stdoutBytes += part.length;
        }
        onOutput('stdout', chunk.toString('utf8').slice(-20000));
      });
      stream.stderr.on('data', (chunk) => {
        if (stderrBytes < maxOutputBytes) {
          const part = chunk.subarray(0, maxOutputBytes - stderrBytes);
          stderr.push(part);
          stderrBytes += part.length;
        }
        onOutput('stderr', chunk.toString('utf8').slice(-20000));
      });
      stream.on('error', (streamError) => {
        clearTimeout(timer);
        reject(streamError);
      });
      stream.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
  }));
}

export function sshReadFile(host, filePath, { maxBytes = CONFIG_FILE_MAX_BYTES, timeoutMs } = {}) {
  assertAbsolute(filePath);
  assertConfigSize(0, maxBytes);
  return withSsh(host, conn => withFileReadDeadline(async signal => {
    // Closing the connection cancels even SFTP setup/stat/open calls that stall.
    const abort = () => conn.destroy();
    signal.addEventListener('abort', abort, { once: true });
    let stream;
    try {
      const sftp = await openSftp(conn);
      signal.throwIfAborted();
      const call = (method, ...args) => new Promise((resolve, reject) => {
        sftp[method](...args, (error, value) => error ? reject(error) : resolve(value));
      });
      const check = stats => {
        if (!stats.isFile()) throw configReadError('配置路径必须指向普通文件，不能是符号链接或目录', 403);
        assertConfigSize(stats.size, maxBytes);
      };
      check(await call('lstat', filePath));
      const handle = await call('open', filePath, 'r');
      // Verify the opened object too; path metadata alone may have changed.
      const stats = await call('fstat', handle);
      check(stats);
      signal.throwIfAborted();
      stream = sftp.createReadStream(filePath, { handle, autoClose: false, start: 0, end: maxBytes });
      // ssh2 can emit a final CLOSE error after an iterator has already ended.
      stream.on('error', () => {});
      const chunks = [];
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        assertConfigSize(bytes, maxBytes);
        chunks.push(chunk);
      }
      if (bytes !== stats.size) throw configReadError('配置文件在读取期间发生变化，请重新读取', 409);
      await new Promise((resolve, reject) => {
        stream.once('close', resolve); stream.once('error', reject); stream.destroy();
      });
      return { content: Buffer.concat(chunks, bytes).toString('utf8'), header: { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid } };
    } catch (error) {
      if (error.code === 2 || error.code === 'ENOENT') throw configReadError('配置文件不存在', 404);
      throw error;
    } finally {
      stream?.destroy();
      signal.removeEventListener('abort', abort);
    }
  }, { timeoutMs }));
}

export function sshWriteFile(host, filePath, content, header = {}) {
  assertAbsolute(filePath);
  return withSsh(host, async (conn) => {
    const sftp = await openSftp(conn);
    await new Promise((resolve, reject) => {
      sftp.writeFile(filePath, Buffer.from(content), { mode: header.mode || 0o644 }, (error) => (error ? reject(error) : resolve()));
    });
  });
}

/** SFTP 目录浏览使用 SSH 用户权限，不要求远端安装 Node。 */
export function sshListDirectory(host, directory, { resolveOnly = false, after = '' } = {}) {
  return withSsh(host, async conn => {
    const sftp = await openSftp(conn);
    const call = (method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
    let timer;
    try {
      return await Promise.race([(async () => {
        const actual = normalizeHostDirectory(await call('realpath', normalizeHostDirectory(directory)));
        const stats = await call('stat', actual);
        if (!stats.isDirectory()) throw Object.assign(new Error('目标不是目录'), { statusCode: 400 });
        const entries = resolveOnly ? [] : (await call('readdir', actual))
          .filter(entry => (entry.attrs.isDirectory() || entry.attrs.isSymbolicLink()) && !['.', '..'].includes(entry.filename) && !/[\0\r\n]/.test(entry.filename))
          .filter(entry => { try { normalizeHostDirectory(path.posix.join(actual, entry.filename)); return true; } catch { return false; } })
          .sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
          .filter(entry => entry.filename > after);
        const page = entries.slice(0, 500);
        return { path: actual, exists: true, entries: page.map(entry => ({ name: entry.filename, path: path.posix.join(actual, entry.filename), symlink: entry.attrs.isSymbolicLink() })), next: entries.length > 500 ? page.at(-1).filename : '' };
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('读取远端目录超时'), { statusCode: 504 })), 15000); })]);
    } finally { clearTimeout(timer); sftp.end(); }
  });
}
