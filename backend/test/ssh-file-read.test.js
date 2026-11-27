import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import ssh2 from 'ssh2';
import { sshReadFile } from '../src/services/remote-shell.js';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
const { STATUS_CODE } = ssh2.utils.sftp;

async function serverFor(t, { content = Buffer.from('标题=你好\n'), mode = 0o100640, size = content.length, stall = '', openedMode = mode } = {}) {
  const clients = new Set(), calls = [];
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => client.on('session', acceptSession => {
      const session = acceptSession();
      session.on('sftp', accept => {
        if (stall === 'setup') return;
        const sftp = accept();
        const attrs = type => ({ mode: type, uid: 1234, gid: 5678, size, atime: 1, mtime: 1 });
        sftp.on('LSTAT', id => { calls.push('lstat'); if (stall !== 'stat') sftp.attrs(id, attrs(mode)); });
        sftp.on('OPEN', id => { calls.push('open'); sftp.handle(id, Buffer.from('file')); });
        sftp.on('FSTAT', id => { calls.push('fstat'); sftp.attrs(id, attrs(openedMode)); });
        sftp.on('READ', (id, handle, offset, length) => {
          calls.push('read');
          if (stall === 'read') return;
          if (offset >= content.length) sftp.status(id, STATUS_CODE.EOF);
          else sftp.data(id, content.subarray(offset, offset + length));
        });
        sftp.on('CLOSE', id => { calls.push('close'); sftp.status(id, STATUS_CODE.OK); });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  return { host: { host: '127.0.0.1', port: server.address().port, username: 'test', password: 'test' }, calls };
}

test('SFTP 有界读取保留 UTF-8 与实际 UID/GID，只打开一次文件句柄', async t => {
  const { host, calls } = await serverFor(t);
  const result = await sshReadFile(host, '/config');
  assert.equal(result.content, '标题=你好\n');
  assert.deepEqual(result.header, { mode: 0o640, uid: 1234, gid: 5678 });
  assert.equal(calls.filter(call => call === 'open').length, 1);
  assert(calls.includes('fstat'));
  // sshReadFile closes its entire connection; CLOSE may still be in flight.
});

test('SFTP 空文件正常读取', async t => {
  const { host } = await serverFor(t, { content: Buffer.alloc(0) });
  assert.equal((await sshReadFile(host, '/config')).content, '');
});

for (const [name, options] of Object.entries({ symlink: { mode: 0o120777 }, directory: { mode: 0o40755 }, 'opened-object': { openedMode: 0o10644 } })) {
  test(`SFTP 拒绝非普通文件 ${name}`, async t => {
    const { host, calls } = await serverFor(t, options);
    await assert.rejects(sshReadFile(host, '/config'), { statusCode: 403 });
    assert(!calls.includes('read'));
  });
}

test('SFTP 在大文件头部和伪小文件的实际字节两处执行上限', async t => {
  const oversized = await serverFor(t, { size: 2 ** 30 });
  await assert.rejects(sshReadFile(oversized.host, '/config', { maxBytes: 16 }), { statusCode: 413 });
  assert(!oversized.calls.includes('open'));
  const growing = await serverFor(t, { size: 1, content: Buffer.alloc(100) });
  await assert.rejects(sshReadFile(growing.host, '/config', { maxBytes: 16 }), { statusCode: 413 });
});

for (const stall of ['setup', 'stat', 'read']) {
  test(`SFTP ${stall} 阶段不响应时到期退出`, async t => {
    const { host } = await serverFor(t, { stall });
    await assert.rejects(sshReadFile(host, '/config', { timeoutMs: 250 }), { statusCode: 504 });
  });
}
