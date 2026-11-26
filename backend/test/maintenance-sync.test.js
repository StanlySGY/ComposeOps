import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WebDAV } from '../src/services/maintenance-sync.js';
import { Drive115, request115Authorization, poll115Authorization } from '../src/services/maintenance-115.js';

test('WebDAV 真实流式上传和下载校验，重试不覆盖未知文件，不跟随重定向', async (t) => {
  const files = new Map();
  let puts = 0,
    corrupt = false;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('demo:secret').toString('base64'));
    if (req.url.includes('/redirect')) {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/leak' });
      return res.end();
    }
    if (req.method === 'MKCOL') {
      res.writeHead(201);
      return res.end();
    }
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      files.set(req.url, Buffer.concat(chunks));
      puts++;
      res.writeHead(201);
      return res.end();
    }
    if (!files.has(req.url)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Length': files.get(req.url).length });
    res.end(
      req.method === 'HEAD'
        ? undefined
        : corrupt
          ? Buffer.alloc(files.get(req.url).length, 1)
          : files.get(req.url),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'dav-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'backup.enc');
  await writeFile(file, Buffer.alloc(1024 * 256, 67));
  const client = new WebDAV({
    url: `http://127.0.0.1:${server.address().port}/dav`,
    user: 'demo',
    credentials: { password: 'secret' },
  });
  const directory = await client.directory('/备份/节点1');
  await client.upload(file, directory);
  await client.upload(file, directory);
  assert.equal(puts, 1);
  corrupt = true;
  await assert.rejects(client.upload(file, directory), /内容校验不一致/);
  await assert.rejects(client.request('/redirect', 'GET'));
});
test('115 设备授权使用随机 PKCE verifier，确认后兑换访问令牌', async () => {
  let verifier, challenge;
  const fetcher = async (url, options) => {
    const form = new URLSearchParams(options.body);
    if (url.includes('authDeviceCode')) {
      challenge = form.get('code_challenge');
      return Response.json({
        state: true,
        data: { uid: 'u1', time: 123, sign: 'signed', qrcode: 'https://115.com/qr/fixture' },
      });
    }
    if (url.includes('get/status')) return Response.json({ state: true, data: { status: 2 } });
    verifier = form.get('code_verifier');
    return Response.json({
      state: true,
      data: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 },
    });
  };
  const session = await request115Authorization('12345', fetcher);
  const result = await poll115Authorization(session, fetcher);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64'));
  assert.equal(result.status, 'authorized');
  assert.ok(result.credentials.expiresAt > Date.now());
  await assert.rejects(request115Authorization('', fetcher), /Client ID/);
});
test('115 分片上传只有在网盘 SHA1 和长度匹配后才算成功，并可幂等重试', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), '115-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'archive.enc'),
    data = Buffer.from('fixture encrypted content');
  await writeFile(file, data);
  const sha1 = createHash('sha1').update(data).digest('hex').toUpperCase();
  let uploaded = false,
    uploads = 0;
  const fetcher = async (url, _options) => {
    let response;
    if (url.includes('/ufile/files'))
      response = {
        state: true,
        count: uploaded ? 1 : 0,
        data: uploaded ? [{ fn: 'archive.enc', fid: 'f1', fc: '1', sha1, fs: data.length }] : [],
      };
    else if (url.includes('/upload/init'))
      response = {
        state: true,
        data: {
          status: 1,
          bucket: 'fixture',
          object: 'fixture-object',
          callback: { callback: '{}', callback_var: '{}' },
        },
      };
    else
      response = {
        state: true,
        data: {
          endpoint: 'https://oss-cn-shenzhen.aliyuncs.com',
          AccessKeyId: 'k',
          AccessKeySecret: 's',
          SecurityToken: 't',
        },
      };
    return Response.json(response);
  };
  const drive = new Drive115(
    { access_token: 'token', expiresAt: Date.now() + 3600_000 },
    {
      fetcher,
      createOSS: () => ({
        multipartUpload: async () => {
          uploads++;
          uploaded = true;
        },
      }),
    },
  );
  const result = await drive.upload(file, '0');
  assert.equal(result.sha1, sha1);
  await drive.upload(file, '0');
  assert.equal(uploads, 1);
});
