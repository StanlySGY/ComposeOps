import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as settle } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-blueprint-stream-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const { default: opsRoutes } = await import('../src/routes/ops.js');
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

async function inject(deployer, payload = { blueprintId: 'uptime-kuma', values: { PORT: '18000' }, expectedHostId: 'local' }) {
  const app = Fastify({ logger: false });
  await app.register(opsRoutes, { blueprintDeployer: deployer });
  try {
    const response = await app.inject({ method: 'POST', url: '/blueprints/deploy', payload });
    return { response, frames: response.body.split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) };
  } finally { await app.close(); }
}

test('blueprint stream: 非零退出不得报成功，目标与退出帧完整', async () => {
  const { frames } = await inject(async (id, values, options) => {
    assert.equal(id, 'uptime-kuma'); assert.equal(values.PORT, '18000'); assert.equal(options.expectedHostId, 'local');
    options.onPhase({ phase: 'starting', hostId: 'local' }); options.onOutput('stderr', 'failed to start\n');
    return { code: 23, ok: true, projectId: 'p', hostId: 'local', filesCreated: true };
  });
  assert.deepEqual(frames.map(frame => frame.type), ['phase', 'stderr', 'exit', 'result']);
  assert.equal(frames.at(-1).data.ok, false); assert.equal(frames.at(-1).data.code, 23);
  assert.equal(frames.at(-1).data.projectId, 'p'); assert.equal(frames.at(-1).data.output, 'failed to start\n');
});

test('blueprint stream: 仅真实零退出成功，异常返回一个终帧', async () => {
  const success = await inject(async () => ({ code: 0, status: 'started', projectId: 'p' }));
  assert.equal(success.frames.at(-1).data.ok, true);
  const failed = await inject(async () => { throw Object.assign(new Error('宿主已变更'), { code: 'HOST_CHANGED' }); });
  assert.equal(failed.frames.filter(frame => frame.type === 'result').length, 1);
  assert.equal(failed.frames.at(-1).data.error, 'HOST_CHANGED');
  assert.equal(failed.frames.at(-1).data.ok, false);
});

test('blueprint stream: 长输出保留有界尾部并说明截断', async () => {
  const { frames } = await inject(async (id, values, options) => {
    for (let index = 0; index < 30; index++) { options.onOutput('stdout', `${index}:` + 'x'.repeat(5000)); await settle(); }
    options.onOutput('stderr', 'last failure');
    return { code: 1 };
  });
  const result = frames.at(-1).data;
  assert.equal(result.output.length, 65536); assert.equal(result.outputTruncated, true);
  assert.ok(result.output.endsWith('last failure'));
  assert.ok(frames.filter(frame => frame.type === 'stdout').every(frame => frame.data.length <= 8192));
});

async function handler(deployer) {
  let route;
  const fake = { get() {}, put() {}, patch() {}, delete() {}, post(url, options, fn) { if (url === '/blueprints/deploy') route = fn; } };
  await opsRoutes(fake, { blueprintDeployer: deployer });
  return route;
}

function fakeReply(raw) {
  raw.writeHead = () => {};
  return { raw, hijack() {} };
}

test('blueprint stream: 慢客户端超过队列上限即中止，并停止后来交付的句柄', async () => {
  const raw = new PassThrough({ highWaterMark: 1 }); raw.pause();
  let stopped = 0; let aborted = false;
  const route = await handler(async (id, values, options) => {
    for (let index = 0; index < 100; index++) options.onOutput('stdout', 'x'.repeat(8192));
    aborted = options.signal.aborted;
    options.onChild({ kill() { stopped++; } });
    return { code: 1 };
  });
  await route({ body: { blueprintId: 'uptime-kuma' } }, fakeReply(raw));
  assert.equal(raw.destroyed, true); assert.equal(aborted, true); assert.equal(stopped, 1);
  assert.equal(raw.listenerCount('drain'), 0); assert.equal(raw.listenerCount('close'), 0);
});

test('blueprint stream: 用户断开即取消初始化，迟到句柄也停止', async () => {
  const raw = new PassThrough(); raw.resume();
  let stopped = 0;
  const route = await handler(async (id, values, options) => {
    raw.destroy(); await settle();
    assert.equal(options.signal.aborted, true);
    options.onChild({ kill() { stopped++; } });
    return { code: 1 };
  });
  await route({ body: { blueprintId: 'uptime-kuma' } }, fakeReply(raw));
  assert.equal(stopped, 1);
});
