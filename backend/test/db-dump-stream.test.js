import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { persistDumpStream } from '../src/services/db-dumper.js';
const root = await mkdtemp(join(tmpdir(), 'composeops-dump-test-'));
test.after(() => rm(root, { recursive: true, force: true }));
function frame(data, type = 1) { const header = Buffer.alloc(8); header[0] = type; header.writeUInt32BE(data.length, 4); return Buffer.concat([header, data]); }
test('无下载消费者时 101MB dump 完整落盘并通过 gzip 校验', { timeout: 30000 }, async () => {
  const chunk = frame(randomBytes(1024 * 1024));
  const source = Readable.from((async function* () { for (let i = 0; i < 101; i++) yield chunk; })());
  const result = await persistDumpStream(source, join(root, 'large.gz'), async () => ({ ExitCode: 0, Running: false }));
  assert.equal(result.rawBytes, 101 * 1024 * 1024);
  assert.equal(result.verified, true);
  assert.ok(result.bytes > 100 * 1024 * 1024);
});
test('截断、非零退出码和主动中断均不发布或遗留半成品', async () => {
  await assert.rejects(persistDumpStream(Readable.from([frame(Buffer.alloc(20)).subarray(0, 12)]), join(root, 'bad.gz'), async () => ({ ExitCode: 0 })), /提前结束/);
  await assert.rejects(persistDumpStream(Readable.from([frame(Buffer.from('data'))]), join(root, 'exit.gz'), async () => ({ ExitCode: 1 })), /未成功/);
  const controller = new AbortController();
  const source = Readable.from((async function* () { yield frame(Buffer.alloc(1024)); controller.abort(); yield frame(Buffer.alloc(1024)); })());
  await assert.rejects(persistDumpStream(source, join(root, 'abort.gz'), async () => ({ ExitCode: 0 }), { signal: controller.signal }));
  assert.deepEqual(await readdir(root), ['large.gz']);
});
