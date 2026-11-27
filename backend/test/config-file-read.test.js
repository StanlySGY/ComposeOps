import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import tar from 'tar-stream';
import { readConfigArchive } from '../src/lib/config-file-read.js';

function archive(entries = [{ name: 'config.yml', content: 'services: {}\n' }]) {
  const pack = tar.pack();
  for (const { content = '', ...header } of entries) pack.entry(header, content);
  pack.finalize();
  return pack;
}
const container = stream => ({ getArchive: async () => stream });

test('配置归档精确保留空文件、UTF-8、权限及所有者', async () => {
  for (const content of ['', '标题=你好\n']) {
    const result = await readConfigArchive(container(archive([{ name: '.env', content, mode: 0o640, uid: 1234, gid: 5678 }])), '/project/.env');
    assert.equal(result.content, content);
    assert.equal(result.header.mode, 0o640); assert.equal(result.header.uid, 1234); assert.equal(result.header.gid, 5678);
  }
});

test('读取配置不展开目录、不跟随链接、不接受多文件归档', async () => {
  for (const entries of [
    [{ name: 'directory', type: 'directory' }, { name: 'directory/secret', content: 'hidden' }],
    [{ name: 'link', type: 'symlink', linkname: '/outside' }],
    [{ name: 'one', content: '1' }, { name: 'two', content: '2' }],
  ]) {
    const stream = archive(entries);
    await assert.rejects(readConfigArchive(container(stream), '/config'), { statusCode: 403 });
    assert.equal(stream.destroyed, true);
  }
});

test('读取上限按字节判断，超大头在读取正文前拒绝', async () => {
  const stream = archive([{ name: 'config', content: '你好' }]);
  await assert.rejects(readConfigArchive(container(stream), '/config', { maxBytes: 5 }), { statusCode: 413 });
  const huge = tar.pack();
  huge.entry({ name: 'huge', size: 2 ** 30 }).on('error', () => {});
  await assert.rejects(readConfigArchive(container(huge), '/huge', { timeoutMs: 1000 }), { statusCode: 413 });
  assert.equal(huge.destroyed, true);
});

test('归档字节预算限制 PAX 元数据', async () => {
  const chunks = [];
  for await (const chunk of archive([{ name: 'config', content: '1', pax: { note: 'x'.repeat(140 * 1024) } }])) chunks.push(chunk);
  await assert.rejects(readConfigArchive(container(Readable.from(chunks)), '/config', { maxBytes: 1 }), { statusCode: 413 });
});

test('截断和提前断流不能返回部分配置', async () => {
  const chunks = [];
  for await (const chunk of archive([{ name: 'config', content: 'value' }])) chunks.push(chunk);
  await assert.rejects(readConfigArchive(container(Readable.from([Buffer.concat(chunks).subarray(0, 514)])), '/config'));
  const closed = new PassThrough();
  const result = readConfigArchive(container(closed), '/config');
  setImmediate(() => closed.destroy());
  await assert.rejects(result, { code: 'ERR_STREAM_PREMATURE_CLOSE' });
});

test('期限覆盖建立连接、迟到响应和流读取，并清理迟到的流', async () => {
  let signal, arrive;
  const setup = { getArchive: options => { signal = options.abortSignal; return new Promise(resolve => { arrive = resolve; }); } };
  await assert.rejects(readConfigArchive(setup, '/config', { timeoutMs: 20 }), { statusCode: 504 });
  assert.equal(signal.aborted, true);
  const late = new PassThrough(); arrive(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.destroyed, true);
  const stalled = new PassThrough();
  await assert.rejects(readConfigArchive(container(stalled), '/config', { timeoutMs: 20 }), { statusCode: 504 });
  assert.equal(stalled.destroyed, true);
});
