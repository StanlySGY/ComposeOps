import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import { registerFrontendStatic } from '../src/lib/frontend-static.js';

const require = createRequire(import.meta.url);

test('恶意响应的编码链与截断 body 不得在 fetch 拒绝后杀死进程', () => {
  // Exercise a real loopback response in a child: an unhandled stream error
  // must fail this test instead of terminating the entire backend test runner.
  const probe = `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { fetch } from ${JSON.stringify(pathToFileURL(require.resolve('undici')).href)};
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip', 'content-length': '100', connection: 'close' });
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(fetch('http://127.0.0.1:' + server.address().port, { signal: AbortSignal.timeout(1500) }), TypeError);
      await new Promise(resolve => setTimeout(resolve, 100));
      process.stdout.write('PROCESS_SURVIVED');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /PROCESS_SURVIVED/);
});

test('邮件收件人嵌套注释不会变成真实投递地址', async () => {
  const nodemailer = require('nodemailer');
  // This transport only builds a message in memory; no SMTP or external mail.
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const result = await transport.sendMail({ from: 'composeops@example.test',
    to: 'Operator (x(y) <unexpected@example.test>) <approved@example.test>', subject: '本地依赖回归', text: 'synthetic local fixture' });
  assert.deepEqual(result.envelope.to, ['approved@example.test']);
});

test('静态托管升级保留预压缩响应、HEAD 与页面路由，隐藏文件不公开', async t => {
  const Fastify = require('fastify');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'composeops-static-dependency-'));
  const app = Fastify();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const html = '<!doctype html><title>ComposeOps fixture</title>';
  await writeFile(path.join(directory, 'index.html'), html);
  await writeFile(path.join(directory, 'index.html.gz'), gzipSync(html));
  await mkdir(path.join(directory, '.git')); await writeFile(path.join(directory, '.git/config'), 'synthetic-private-data');
  await writeFile(path.join(directory, '.env'), 'synthetic-private-data');
  await writeFile(path.join(directory, '.env.gz'), gzipSync('synthetic-private-data'));
  await registerFrontendStatic(app, directory);
  const response = await app.inject({ url: '/index.html', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(response.rawPayload).toString(), html);
  const head = await app.inject({ method: 'HEAD', url: '/index.html' });
  assert.equal(head.statusCode, 200); assert.equal(head.payload, '');
  for (const url of ['/.git/', '/.git/config', '/.env', '/.env.gz', '/%2eenv', '/api/missing', '/ws/missing']) {
    const hidden = await app.inject({ url, headers: { 'accept-encoding': 'gzip' } });
    assert.equal(hidden.statusCode, 404, url); assert.doesNotMatch(hidden.payload, /synthetic-private-data/);
  }
  assert.equal((await app.inject({ url: '/services' })).payload, html);
  // The HTTP URL parser normalizes dot segments before routing; a miss still
  // gets the SPA and must never resolve a parent directory's package.json.
  assert.equal((await app.inject({ url: '/%2e%2e/package.json' })).payload, html);
});
