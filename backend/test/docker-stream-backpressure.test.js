import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { demuxStream } from '../src/lib/docker-streams.js';

function frame(bytes, type = 1) {
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

test('Docker output applies backpressure to a fast producer when the download consumer pauses', { timeout: 5000 }, async () => {
  const demux = demuxStream();
  let generated = 0;
  let consumed = 0;
  const count = 128;
  const size = 64 * 1024;
  const source = Readable.from((async function* () {
    for (let index = 0; index < count; index += 1) { generated += 1; yield frame(Buffer.alloc(size, index)); }
  })(), { objectMode: false });
  demux.stderr.resume();
  const inputFinished = pipeline(source, demux);
  // A user temporarily pauses reading; at most a few frames should have been pulled.
  await new Promise(resolve => setTimeout(resolve, 30));
  const generatedWhilePaused = generated;
  const outputFinished = pipeline(demux.stdout, new Writable({
    write(chunk, encoding, callback) { consumed += chunk.length; setTimeout(callback, 1); },
  }));
  await Promise.all([inputFinished, outputFinished]);
  assert(generatedWhilePaused < 10, `paused consumer caused ${generatedWhilePaused} / ${count} frames to be buffered`);
  assert.equal(consumed, count * size);
});

for (const bytes of [frame(Buffer.from('abc')).subarray(0, 6), frame(Buffer.from('abc')).subarray(0, 10)]) {
  test(`Docker truncated ${bytes.length < 8 ? 'header' : 'payload'} cannot complete successfully`, async () => {
    const demux = demuxStream({ strict: true });
    demux.stdout.on('error', () => {});
    demux.stderr.on('error', () => {});
    demux.stdout.resume();
    demux.stderr.resume();
    await assert.rejects(pipeline(Readable.from([bytes]), demux), /提前结束/);
  });
}

test('destroying a paused Docker parser releases its pending write', { timeout: 2000 }, async () => {
  const demux = demuxStream();
  demux.stdout.on('error', () => {});
  demux.stderr.on('error', () => {});
  const finished = pipeline(Readable.from([frame(Buffer.alloc(256 * 1024))]), demux);
  const closed = once(demux, 'close').catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  demux.destroy(new Error('download abandoned'));
  await assert.rejects(finished, /download abandoned/);
  await closed;
  assert(demux.stdout.destroyed && demux.stderr.destroyed);
});
