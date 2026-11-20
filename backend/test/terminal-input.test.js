import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTerminalInput } from '../src/lib/terminal-input.js';

test('cursor report cannot swallow immediately typed command characters', async () => {
  let receiverBusy = false, received = '';
  const input = createTerminalInput(data => {
    if (data.toString() === '\x1b[1;5R') { receiverBusy = true; setTimeout(() => { receiverBusy = false; }, 50); }
    else if (!receiverBusy) received += data;
  }, () => assert.fail('unexpected overflow'));
  input.send('\x1b[1;5R');
  for (const char of "printf 'hello'\r") input.send(char);
  await delay(140); assert.equal(received, "printf 'hello'\r"); input.close();
});
test('normal typing stays immediate; disconnect discards pending input and repeated reports retain order', async () => {
  const received = []; const input = createTerminalInput(data => received.push(data.toString()), () => assert.fail());
  input.send('a'); assert.deepEqual(received, ['a']);
  input.send('\x1b[1;5R'); input.send('\x1b[1;6R'); input.send('b');
  await delay(130); assert.deepEqual(received, ['a', '\x1b[1;5R', '\x1b[1;6R']);
  input.close(); await delay(130); assert.equal(received.includes('b'), false);
});
test('oversized input during cursor response closes the buffer without replay', async () => {
  let failed = false; const received = [];
  const input = createTerminalInput(data => received.push(data), () => { failed = true; });
  input.send('\x1b[1;5R'); input.send(Buffer.alloc(64 * 1024)); input.send('x');
  assert.equal(failed, true); await delay(130); assert.equal(received.length, 1);
});
