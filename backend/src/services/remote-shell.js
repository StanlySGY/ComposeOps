import ssh2 from 'ssh2';
import { createSshHostVerifier } from '../lib/ssh-fingerprint.js';

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
    if (host.privateKey) options.privateKey = host.privateKey;
    if (host.password) options.password = host.password;
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

export function sshReadFile(host, filePath) {
  assertAbsolute(filePath);
  return withSsh(host, async (conn) => {
    const sftp = await openSftp(conn);
    const content = await new Promise((resolve, reject) => {
      sftp.readFile(filePath, (error, data) => {
        if (error) {
          if (error.code === 2 || error.code === 'ENOENT') {
            reject(Object.assign(new Error('Compose 文件不存在'), { statusCode: 404 }));
            return;
          }
          reject(error);
          return;
        }
        resolve(data.toString('utf8'));
      });
    });
    const mode = await new Promise((resolve) => {
      sftp.stat(filePath, (error, stats) => resolve(error ? 0o644 : (stats.mode & 0o777)));
    });
    return { content, header: { mode, uid: 0, gid: 0 } };
  });
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
