import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readBoundedLines } from '../src/lib/line-decoder.js';

async function collect(stream, limit) { const lines = []; for await (const line of readBoundedLines(stream, limit)) lines.push(line); return lines; }
test('有界读取保留逐字节 UTF-8、CRLF、空行和末尾无换行文本', async () => {
  const source = Readable.from([...Buffer.from('中文\r\n\n末尾')].map(value => Buffer.from([value])));
  assert.deepEqual(await collect(source, 20), ['中文', '', '末尾']);
});
test('按字节限制完整和未完整行，超限不会交付截断记录', async () => {
  for (const text of ['中文\n', '中文']) {
    const stream = Readable.from([Buffer.from(text)]);
    await assert.rejects(collect(stream, 5), /上限/);
    assert.equal(stream.destroyed, true);
  }
  assert.deepEqual(await collect(Readable.from([Buffer.from('中文\n')]), 6), ['中文']);
});
test('提前结束消费释放底层流，不再读取余下记录', async () => {
  let produced = 0;
  const stream = Readable.from((async function* () { for (let i = 0; i < 100; i++) { produced++; yield Buffer.from('line\n'); } })(), { highWaterMark: 1 });
  for await (const line of readBoundedLines(stream)) { assert.equal(line, 'line'); break; }
  assert.equal(stream.destroyed, true); assert.ok(produced < 5);
});
