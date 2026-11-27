import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamImageOperation } from '../src/lib/image-operation-stream.js';

test('慢客户端积压到上限即取消操作，迟到句柄也停止', async () => {
  const raw = new EventEmitter();
  let bytes = 0, killed = 0;
  Object.assign(raw, {
    writeHead() {}, write(frame) { bytes += Buffer.byteLength(frame); return false; },
    destroy() { this.destroyed = true; this.emit('close'); },
    end() { this.writableEnded = true; this.emit('finish'); },
  });
  await streamImageOperation({ raw, hijack() {} }, async ({ onOutput, onChild, signal }) => {
    onOutput('stdout', 'x'.repeat(1_000_000));
    assert.equal(signal.aborted, true);
    onChild({ kill() { killed++; } });
    signal.throwIfAborted();
  });
  assert.equal(killed, 1); assert.equal(raw.destroyed, true);
  assert.ok(bytes < 10_000, 'backpressure writes only the first chunk; queue overflow tears down the stream');
  assert.equal(raw.listenerCount('close'), 0);
});
