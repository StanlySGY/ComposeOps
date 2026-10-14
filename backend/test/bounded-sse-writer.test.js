import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createBoundedSseWriter } from '../src/lib/bounded-sse-writer.js';

test('bounded SSE writer: preserves event order while draining a slow consumer', async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  let received = '';
  stream.on('data', (chunk) => { received += chunk.toString(); });
  stream.pause();
  const writer = createBoundedSseWriter(stream, { maxQueuedBytes: 512 });
  writer.send({ seq: 1 });
  writer.send({ seq: 2 });
  writer.send({ seq: 3 });
  assert.ok(writer.queuedBytes > 0);
  await settle();
  stream.resume();
  await writer.end();
  assert.ok(received.indexOf('"seq":1') < received.indexOf('"seq":2'));
  assert.ok(received.indexOf('"seq":2') < received.indexOf('"seq":3'));
  assert.equal((received.match(/data: /g) || []).length, 3);
});

test('bounded SSE writer: streams thousands of events without loss or retained queue', async () => {
  const stream = new PassThrough({ highWaterMark: 1024 });
  let bytes = 0;
  let events = 0;
  stream.on('data', (chunk) => {
    bytes += chunk.length;
    events += (chunk.toString().match(/data: /g) || []).length;
  });
  const writer = createBoundedSseWriter(stream, { maxQueuedBytes: 256 * 1024 });
  for (let seq = 0; seq < 5000; seq++) writer.send({ seq, content: 'stream-chunk' });
  await writer.end();
  assert.equal(events, 5000);
  assert.ok(bytes > 5000);
  assert.equal(writer.queuedBytes, 0);
});

test('bounded SSE writer: destroys a stalled stream instead of growing memory without limit', async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  stream.pause();
  let overflowed = false;
  const writer = createBoundedSseWriter(stream, {
    maxQueuedBytes: 128,
    onOverflow: () => { overflowed = true; },
  });
  writer.send({ text: 'a'.repeat(70) });
  writer.send({ text: 'b'.repeat(70) });
  assert.ok(writer.queuedBytes > 0 && writer.queuedBytes <= 128);
  writer.send({ text: 'c'.repeat(70) });
  assert.equal(overflowed, true);
  assert.equal(stream.destroyed, true);
  assert.equal(writer.queuedBytes, 0);
  await writer.end();
});
