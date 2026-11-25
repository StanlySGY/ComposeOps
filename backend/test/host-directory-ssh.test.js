import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import test from 'node:test';
import { sshListDirectory } from '../src/services/remote-shell.js';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs1' });
const { STATUS_CODE } = ssh2.utils.sftp;

test('SSH 目录浏览用 SFTP 解析真实路径，排除文件并返回分页目录', async t => {
  const connections = new Set();
  const server = new ssh2.Server({ hostKeys: [privatePem] }, client => {
    connections.add(client); client.on('close', () => connections.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.method === 'password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', acceptSession => {
      const session = acceptSession();
      session.on('sftp', accept => {
        const sftp = accept(); let read = false;
        sftp.on('REALPATH', (id, value) => sftp.name(id, [{ filename: value === '/alias' ? '/srv/apps' : value, longname: '', attrs: {} }]));
        sftp.on('STAT', id => sftp.attrs(id, { mode: 0o40755, uid: 1000, gid: 1000, size: 0, atime: 0, mtime: 0 }));
        sftp.on('OPENDIR', id => sftp.handle(id, Buffer.from('directory')));
        sftp.on('READDIR', id => {
          if (read) return sftp.status(id, STATUS_CODE.EOF);
          read = true;
          sftp.name(id, [
            { filename: 'notes.txt', longname: '', attrs: { mode: 0o100600 } },
            { filename: 'current', longname: '', attrs: { mode: 0o120777 } },
            ...Array.from({ length: 502 }, (_, i) => ({ filename: 'dir-' + String(i).padStart(3, '0'), longname: '', attrs: { mode: 0o40755 } })),
          ]);
        });
        sftp.on('CLOSE', id => sftp.status(id, STATUS_CODE.OK));
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of connections) client.end(); await new Promise(resolve => server.close(resolve)); });
  const host = { host: '127.0.0.1', port: server.address().port, username: 'test', password: 'test' };
  const page = await sshListDirectory(host, '/alias');
  assert.equal(page.path, '/srv/apps'); assert.equal(page.entries.length, 500);
  assert.equal(page.entries[0].name, 'current'); assert.equal(page.entries[0].symlink, true);
  assert.equal(page.entries.some(item => item.name === 'notes.txt'), false);
  const next = await sshListDirectory(host, '/srv/apps', { after: page.next });
  assert.equal(next.entries.length, 3); assert.equal(next.next, '');
  await assert.rejects(sshListDirectory(host, '/proc'), error => error.statusCode === 403);
});
