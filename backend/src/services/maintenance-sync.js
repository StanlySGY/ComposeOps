import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile, stat, mkdtemp, writeFile, rm, lstat } from 'node:fs/promises';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { Drive115 } from './maintenance-115.js';
import { digestFile, decryptArtifact } from './maintenance-archive.js';

function sealCredentials(value, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}
export class WebDAV {
  constructor(target, fetcher = fetch) {
    this.target = target;
    this.fetcher = fetcher;
  }
  url(remote) {
    const url = new URL(this.target.url);
    url.pathname =
      url.pathname.replace(/\/$/, '') +
      '/' +
      remote
        .split('/')
        .filter(Boolean)
        .map((p) => encodeURIComponent(p))
        .join('/');
    return url;
  }
  async request(remote, method, body = null, length = null) {
    const headers = {
      Authorization:
        'Basic ' + Buffer.from(this.target.user + ':' + this.target.credentials.password).toString('base64'),
    };
    if (length !== null) headers['Content-Length'] = String(length);
    if (method === 'PUT') headers['If-None-Match'] = '*';
    return this.fetcher(this.url(remote), {
      method,
      headers,
      body,
      duplex: body ? 'half' : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(method === 'PUT' || method === 'GET' ? 2 * 60 * 60_000 : 30_000),
    });
  }
  async directory(remote) {
    let accumulated = '';
    for (const part of remote.split('/').filter(Boolean)) {
      accumulated += '/' + part;
      const response = await this.request(accumulated, 'MKCOL');
      await response.body?.cancel();
      if (![201, 405].includes(response.status)) throw new Error('WebDAV 创建目录失败');
    }
    return remote;
  }
  async upload(file, directory) {
    const remote = directory + '/' + path.basename(file),
      size = (await stat(file)).size;
    const hash = await digestFile(file);
    // 同批次幂等重试；若已有文件可直接校验，绝不以同名覆盖未知内容。
    const existing = await this.request(remote, 'HEAD');
    if (existing.status !== 404 && !existing.ok) throw new Error('WebDAV 远端检查失败');
    await existing.body?.cancel();
    if (existing.status === 404) {
      const response = await this.request(remote, 'PUT', createReadStream(file), size);
      await response.body?.cancel();
      if (!response.ok) throw new Error('WebDAV 上传失败');
    }
    const verify = await this.request(remote, 'GET');
    if (!verify.ok) throw new Error('WebDAV 下载校验失败');
    const actual = createHash('sha256');
    let bytes = 0;
    for await (const chunk of verify.body) {
      actual.update(chunk);
      bytes += chunk.length;
    }
    if (bytes !== size || actual.digest('hex') !== hash) throw new Error('WebDAV 远端文件内容校验不一致');
    return { bytes, sha256: hash };
  }
}
export async function runSync(
  config,
  {
    emit = () => {},
    createWebDAV = (t) => new WebDAV(t),
    createDrive115 = (t, opts) => new Drive115(t, opts),
  } = {},
) {
  const { target } = config;
  let sealedCredentials;
  const client =
    target.type === '115'
      ? createDrive115(target.credentials, {
          onRefresh: (credentials) => {
            sealedCredentials = sealCredentials(credentials, Buffer.from(config.key, 'base64'));
            emit({ type: 'credentials', sealedCredentials });
          },
        })
      : createWebDAV(target);
  const uploaded = [];
  if (config.test) {
    const temp = await mkdtemp('/run/composeops/test-');
    try {
      const marker = path.join(temp, 'connection-' + randomBytes(8).toString('hex') + '.txt');
      await writeFile(marker, randomBytes(64), { mode: 0o600 });
      const destination = await client.directory(target.remotePath + '/.connection-tests');
      await client.upload(marker, destination);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    return {
      tested: true,
      verification: target.type === '115' ? 'sha1-and-size' : 'download-sha256',
      sealedCredentials,
    };
  }
  for (const backup of config.backups) {
    if (!/^[\da-f-]{36}$/.test(backup.id)) throw new Error('备份 ID 无效');
    const directory = '/backup/' + backup.id;
    const receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8'));
    if (
      receipt.id !== backup.id ||
      receipt.complete !== true ||
      receipt.fileVerified !== true ||
      !receipt.artifacts?.length
    )
      throw new Error('本地备份未完成');
    const chunks = [];
    let manifestBytes = 0;
    await decryptArtifact(
      path.join(directory, 'manifest.json.enc'),
      Buffer.from(config.key, 'base64'),
      new Writable({
        write(chunk, _encoding, callback) {
          manifestBytes += chunk.length;
          if (manifestBytes > 32 * 1024 ** 2) return callback(new Error('恢复清单过大'));
          chunks.push(chunk);
          callback();
        },
      }),
    );
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      manifest.id !== backup.id ||
      manifest.type !== 'full' ||
      !Array.isArray(manifest.artifacts) ||
      manifest.artifacts.length + 1 !== receipt.artifacts.length
    )
      throw new Error('备份完整清单不一致');
    for (const a of manifest.artifacts)
      if (!receipt.artifacts.some((b) => b.file === a.file && b.sha256 === a.sha256 && b.bytes === a.bytes))
        throw new Error('备份收据缺少完整产物');
    const destination = await client.directory(target.remotePath + '/' + config.hostId + '/' + backup.id);
    for (const artifact of [...receipt.artifacts, { file: 'receipt.json' }]) {
      if (!/^[\w.-]+$/.test(artifact.file)) throw new Error('备份文件名无效');
      const file = path.join(directory, artifact.file),
        info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('备份产物不是常规文件');
      if (artifact.sha256 && ((await digestFile(file)) !== artifact.sha256 || info.size !== artifact.bytes))
        throw new Error('本地备份文件校验失败');
      emit({ status: 'running', stage: '上传并校验 ' + artifact.file });
      await client.upload(file, destination);
    }
    uploaded.push(backup.id);
  }
  return {
    uploaded,
    sealedCredentials,
    verification: target.type === '115' ? 'sha1-and-size' : 'download-sha256',
  };
}
