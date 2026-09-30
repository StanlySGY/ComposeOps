import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as settle } from 'node:timers/promises';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-log-streams-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const { aggregateProjectLogs } = await import('../src/services/log-aggregator.js');
const { getActivityDocker } = await import('../src/services/docker-hosts.js');
const docker = getActivityDocker();
const project = { containers: [{ id: 'test-container', name: '测试服务' }] };
const timestamp = '2026-09-29T12:00:00.123456789Z';

function frame(text, type = 1) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
function container(stream, tty = false) {
  return { inspect: async () => ({ Config: { Tty: tty } }), logs: async () => stream };
}
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('聚合日志保留跨 Docker 帧和 UTF-8 字节分片的完整行及时间戳', async (t) => {
  const raw = new PassThrough();
  t.mock.method(docker, 'getContainer', () => container(raw));
  const lines = [];
  const agg = await aggregateProjectLogs({ project, onLine: line => lines.push(line) });
  t.after(() => agg.stop());
  const data = Buffer.concat([frame(`${timestamp} WARN 中文🙂`), frame(' 正常\n尾行'), frame(`${timestamp} ERROR 错误\n`, 2)]);
  for (const byte of data) raw.write(Buffer.from([byte]));
  raw.end();
  await settle();
  assert.deepEqual(lines.map(line => [line.type, line.data, line.ts]), [
    ['stdout', 'WARN 中文🙂 正常', timestamp], ['stderr', 'ERROR 错误', timestamp], ['stdout', '尾行', null],
  ]);
  assert.equal(lines[0].level, 'warn');
});

test('聚合日志支持 TTY 原始流和 CRLF,不把原始字节当作 Docker 帧头', async (t) => {
  const raw = new PassThrough();
  t.mock.method(docker, 'getContainer', () => container(raw, true));
  const lines = [];
  const agg = await aggregateProjectLogs({ project, onLine: line => lines.push(line) });
  t.after(() => agg.stop());
  for (const byte of Buffer.from(`${timestamp} TTY 中文\r\n`)) raw.write(Buffer.from([byte]));
  raw.end();
  await settle();
  assert.deepEqual(lines.map(line => line.data), ['TTY 中文']);
});

test('容器日志初始化失败会报告具体容器而不是静默空白', async (t) => {
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => ({ Config: { Tty: false } }), logs: async () => { throw new Error('日志驱动不可读'); } }));
  const errors = [];
  const agg = await aggregateProjectLogs({ project, onError: error => errors.push(error) });
  t.after(() => agg.stop());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].containerName, '测试服务');
  assert.match(errors[0].message, /日志驱动不可读/);
  assert.equal(agg.count, 0);
});

test('等待 Docker 返回期间取消,迟到的日志流会立即销毁', async (t) => {
  const raw = new PassThrough();
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => ({ Config: { Tty: false } }), logs: () => pending }));
  const controller = new AbortController();
  const opening = aggregateProjectLogs({ project, signal: controller.signal });
  await settle();
  controller.abort();
  resolve(raw);
  const agg = await opening;
  t.after(() => agg.stop());
  assert.equal(raw.destroyed, true);
});
