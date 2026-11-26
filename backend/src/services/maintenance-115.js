// 115 官方 Open API：设备码 PKCE 授权，上传初始化后用官方 OSS SDK 传输。
// 协议参考 https://www.yuque.com/115yun/open ，不复用第三方应用的 client_id。
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import OSS from 'ali-oss';
import { digestFile } from './maintenance-archive.js';

const AUTH = 'https://passportapi.115.com';
const API = 'https://proapi.115.com';
export async function api115(
  endpoint,
  values = {},
  { token = '', method = 'POST', fetcher = fetch, raw = false } = {},
) {
  const body = new URLSearchParams(Object.entries(values).map(([k, v]) => [k, String(v)]));
  const response = await fetcher(endpoint + (method === 'GET' ? '?' + body : ''), {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? body : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error('115 服务请求失败：HTTP ' + response.status);
  const result = await response.json();
  if (result.state !== true && result.state !== 1)
    throw new Error(
      '115 接口拒绝请求，错误码：' + String(result.code || result.errno || 'unknown').replace(/[^\w-]/g, ''),
    );
  return raw ? result : result.data;
}
export async function request115Authorization(clientId, fetcher = fetch) {
  if (!/^\d{1,30}$/.test(clientId || '')) throw new Error('请先配置自己的 115 开放平台 Client ID');
  const verifier = randomBytes(48).toString('base64url');
  const device = await api115(
    AUTH + '/open/authDeviceCode',
    {
      client_id: clientId,
      code_challenge: createHash('sha256').update(verifier).digest('base64'),
      code_challenge_method: 'sha256',
    },
    { fetcher },
  );
  if (!device?.uid || !device.sign || !device.qrcode) throw new Error('115 未返回有效授权二维码');
  return { verifier, device };
}
export async function poll115Authorization(session, fetcher = fetch) {
  const { device, verifier } = session;
  const status = await api115(
    'https://qrcodeapi.115.com/get/status/',
    { uid: device.uid, time: device.time, sign: device.sign },
    { method: 'GET', fetcher },
  );
  if (Number(status.status) === 2) {
    const credentials = await api115(
      AUTH + '/open/deviceCodeToToken',
      { uid: device.uid, code_verifier: verifier },
      { fetcher },
    );
    if (!credentials?.access_token || !credentials.refresh_token) throw new Error('115 未返回授权令牌');
    return {
      status: 'authorized',
      credentials: { ...credentials, expiresAt: Date.now() + Number(credentials.expires_in) * 1000 },
    };
  }
  return {
    status: Number(status.status) < 0 ? 'expired' : Number(status.status) === 1 ? 'scanned' : 'waiting',
  };
}
export class Drive115 {
  constructor(
    credentials,
    { fetcher = fetch, createOSS = (options) => new OSS(options), onRefresh = () => {} } = {},
  ) {
    this.credentials = credentials;
    this.fetcher = fetcher;
    this.createOSS = createOSS;
    this.onRefresh = onRefresh;
  }
  async token() {
    if (this.credentials.expiresAt < Date.now() + 120_000) {
      const update = await api115(
        AUTH + '/open/refreshToken',
        { refresh_token: this.credentials.refresh_token },
        { fetcher: this.fetcher },
      );
      if (!update?.access_token || !update.refresh_token) throw new Error('115 令牌刷新失败，需要重新授权');
      this.credentials = { ...update, expiresAt: Date.now() + Number(update.expires_in) * 1000 };
      await this.onRefresh(this.credentials);
    }
    return this.credentials.access_token;
  }
  async call(route, values, opts = {}) {
    return api115(API + route, values, { token: await this.token(), fetcher: this.fetcher, ...opts });
  }
  async files(id) {
    const all = [];
    for (let offset = 0; offset < 100_000; offset += 1150) {
      const response = await this.call(
        '/open/ufile/files',
        { cid: id, offset, limit: 1150, show_dir: 1, cur: 1 },
        { method: 'GET', raw: true },
      );
      if (!Array.isArray(response.data)) throw new Error('115 目录响应无效');
      all.push(...response.data);
      if (all.length >= Number(response.count) || response.data.length < 1150) return all;
    }
    throw new Error('115 目录条目过多，请选择独立备份目录');
  }
  async directory(remotePath, parent = '0') {
    for (const part of remotePath.split('/').filter(Boolean)) {
      if (part === '.' || part === '..') throw new Error('远端目录不合法');
      const matching = (await this.files(parent)).filter((f) => f.fn === part && String(f.fc) === '0');
      if (matching.length > 1) throw new Error('115 存在多个同名目录，请整理后重试');
      const created = matching.length
        ? matching[0]
        : await this.call('/open/folder/add', { pid: parent, file_name: part });
      parent = String(created.fid || created.file_id || '');
      if (!/^\d+$/.test(parent)) throw new Error('115 未返回有效文件夹 ID');
    }
    return parent;
  }
  async upload(file, directory) {
    const size = (await stat(file)).size;
    const sha1 = (await digestFile(file, 'sha1')).toUpperCase();
    const existing = (await this.files(directory)).filter((f) => f.fn === path.basename(file));
    if (
      existing.some(
        (f) => String(f.fc) === '1' && String(f.sha1).toUpperCase() === sha1 && Number(f.fs) === size,
      )
    )
      return { sha1, bytes: size };
    if (existing.length) throw new Error('115 远端存在不同内容的同名文件，禁止覆盖');
    const first = createHash('sha1');
    for await (const chunk of createReadStream(file, { start: 0, end: Math.min(size, 128 * 1024) - 1 }))
      first.update(chunk);
    const values = {
      file_name: path.basename(file),
      file_size: size,
      target: 'U_1_' + directory,
      fileid: sha1,
      preid: first.digest('hex').toUpperCase(),
    };
    let init = await this.call('/open/upload/init', values);
    if (Number(init.status) === 7) {
      const range = /^(\d+)-(\d+)$/.exec(init.sign_check || '');
      if (
        !range ||
        Number(range[2]) >= size ||
        Number(range[2]) - Number(range[1]) > 16 * 1024 * 1024 ||
        Number(range[2]) < Number(range[1])
      )
        throw new Error('115 上传验证范围无效');
      const partHash = createHash('sha1');
      for await (const chunk of createReadStream(file, { start: Number(range[1]), end: Number(range[2]) }))
        partHash.update(chunk);
      init = await this.call('/open/upload/init', {
        ...values,
        sign_key: init.sign_key,
        sign_val: partHash.digest('hex').toUpperCase(),
      });
    }
    if (Number(init.status) !== 2) {
      if (Number(init.status) !== 1 || !init.bucket || !init.object) throw new Error('115 未接受上传初始化');
      const token = await this.call('/open/upload/get_token', {}, { method: 'GET' });
      const endpoint = new URL(token.endpoint || 'https://oss-cn-shenzhen.aliyuncs.com');
      if (!endpoint.hostname.endsWith('.aliyuncs.com')) throw new Error('115 返回的 OSS 地址不受支持');
      endpoint.protocol = 'https:';
      const client = this.createOSS({
        endpoint: endpoint.href,
        secure: true,
        bucket: init.bucket,
        accessKeyId: token.AccessKeyId,
        accessKeySecret: token.AccessKeySecret,
        stsToken: token.SecurityToken,
        refreshSTSToken: async () => {
          const t = await this.call('/open/upload/get_token', {}, { method: 'GET' });
          return {
            accessKeyId: t.AccessKeyId,
            accessKeySecret: t.AccessKeySecret,
            stsToken: t.SecurityToken,
          };
        },
        refreshSTSTokenInterval: 240_000,
      });
      const callback = Array.isArray(init.callback) ? init.callback[0] : init.callback;
      if (!callback?.callback || !callback.callback_var) throw new Error('115 上传缺少完成回调');
      await client.multipartUpload(init.object, file, {
        parallel: 2,
        partSize: Math.max(20 * 1024 ** 2, Math.ceil(size / 9000)),
        headers: {
          'x-oss-callback': Buffer.from(callback.callback).toString('base64'),
          'x-oss-callback-var': Buffer.from(callback.callback_var).toString('base64'),
        },
      });
    }
    // 不把 OSS HTTP 200 当成网盘落盘成功；核对 115 实际文件的 SHA1 和长度。
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = (await this.files(directory)).find(
        (f) =>
          f.fn === path.basename(file) &&
          String(f.fc) === '1' &&
          String(f.sha1).toUpperCase() === sha1 &&
          Number(f.fs) === size,
      );
      if (entry) return { fileId: entry.fid, sha1, bytes: size };
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error('115 远端文件校验未通过');
  }
}
