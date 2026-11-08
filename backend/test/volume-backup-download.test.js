import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import http from 'node:http';
import test from 'node:test';
import Fastify from 'fastify';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-download-test-'));
process.env.DB_PATH = path.join(directory, 'test.db');
const { default: opsRoutes } = await import('../src/routes/ops.js');
const { addVolumeBackup, setSetting } = await import('../src/lib/db.js');
const { upsertHost, getDockerForHost } = await import('../src/services/docker-hosts.js');
upsertHost({ id: 'download-remote', name: 'Isolated remote fixture', type: 'tcp', host: '127.0.0.1', port: 1 });
setSetting('backup.volume_dir.download-remote', '/test-archives');
const docker = getDockerForHost('download-remote');
const backupId = addVolumeBackup({ projectId: 'remote-project', projectName: 'remote', volume: 'deleted-source-volume', file: 'remote.tar.gz', bytes: 6, host: 'download-remote' });
const app = Fastify({ logger: false });
await app.register(opsRoutes, { prefix: '/api/v1/ops' });
const url = `/api/v1/ops/storage/volume-backups/${backupId}/download`;
test.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });

function frame(bytes, channel = 1) {
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

function mockDownload(t, { startError, exitCode = 0, lateBytes = false, failAfterBytes = false } = {}) {
  const state = { options: null, removed: 0 };
  const stream = new PassThrough();
  t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({}) }));
  t.mock.method(docker, 'createContainer', async options => {
    state.options = options;
    return {
      attach: async () => stream,
      start: async () => {
        if (startError) throw new Error(startError);
        setTimeout(() => {
          // Docker stderr must never enter the archive download.
          stream.write(frame(Buffer.from('diagnostic'), 2));
          stream.write(frame(Buffer.from([0x1f, 0x8b, 0x00])));
          stream.end(frame(Buffer.from([0x01, 0xff, 0x00])));
        }, lateBytes ? 20 : 0);
      },
      wait: async () => {
        if (failAfterBytes) await new Promise(resolve => setTimeout(resolve, 40));
        return { StatusCode: exitCode };
      },
      remove: async () => { state.removed += 1; },
    };
  });
  return state;
}

test('remote archive download preserves bytes and headers after Docker wait resolves early', { timeout: 5000 }, async t => {
  const state = mockDownload(t, { lateBytes: true });
  const response = await app.inject({ method: 'GET', url });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0xff, 0x00]));
  assert.match(response.headers['content-type'] || '', /application\/gzip/);
  assert.equal(response.headers['content-disposition'], 'attachment; filename="remote.tar.gz"');
  assert.equal(state.removed, 1);
});

test('remote download never mounts or recreates the original data volume', { timeout: 5000 }, async t => {
  const state = mockDownload(t);
  await app.inject({ method: 'GET', url });
  assert.deepEqual(state.options.HostConfig.Binds, ['/test-archives:/backup:ro']);
  assert.equal(state.options.HostConfig.NetworkMode, 'none');
});

test('remote helper startup failure returns actionable JSON and cleans the helper', { timeout: 5000 }, async t => {
  const state = mockDownload(t, { startError: 'daemon unavailable' });
  const response = await app.inject({ method: 'GET', url });
  assert.equal(response.statusCode, 502);
  assert.match(response.headers['content-type'] || '', /application\/json/);
  assert.equal(response.headers['content-disposition'], undefined);
  assert.match(response.json().message, /daemon unavailable/);
  assert.equal(state.removed, 1);
});

test('remote helper failure cannot publish a successful empty download', { timeout: 5000 }, async t => {
  const state = mockDownload(t, { exitCode: 1, lateBytes: true });
  const response = await app.inject({ method: 'GET', url });
  assert.equal(response.statusCode, 502);
  assert.match(response.headers['content-type'] || '', /application\/json/);
  assert.equal(response.headers['content-disposition'], undefined);
  assert.equal(state.removed, 1);
});

test('remote helper failure after payload starts aborts the download instead of completing it', { timeout: 5000 }, async t => {
  const state = mockDownload(t, { exitCode: 1, failAfterBytes: true });
  await assert.rejects(app.inject({ method: 'GET', url }));
  assert.equal(state.removed, 1);
});

test('abandoning a remote HTTP download releases its Docker helper and input stream', { timeout: 5000 }, async t => {
  const isolatedApp = Fastify({ logger: false });
  await isolatedApp.register(opsRoutes, { prefix: '/api/v1/ops' });
  const address = await isolatedApp.listen({ host: '127.0.0.1', port: 0 });
  const stream = new PassThrough();
  let removed = 0;
  let finishContainer;
  t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({}) }));
  t.mock.method(docker, 'createContainer', async () => ({
    attach: async () => stream,
    start: async () => { setImmediate(() => stream.write(frame(Buffer.alloc(128 * 1024, 65)))); },
    wait: () => new Promise(resolve => { finishContainer = resolve; }),
    remove: async () => { removed += 1; finishContainer?.({ StatusCode: 137 }); },
  }));
  try {
    await new Promise((resolve, reject) => {
      const request = http.get(`${address}${url}`, response => {
        response.once('data', () => { response.destroy(); resolve(); });
        response.once('error', reject);
      });
      request.once('error', reject);
    });
    for (let attempt = 0; attempt < 50 && !removed; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(removed, 1);
    assert.equal(stream.destroyed, true);
  } finally {
    await isolatedApp.close();
  }
});

test('a slow HTTP consumer can finish after the helper has exited for more than five seconds', { timeout: 10000 }, async t => {
  const isolatedApp = Fastify({ logger: false });
  await isolatedApp.register(opsRoutes, { prefix: '/api/v1/ops' });
  const address = await isolatedApp.listen({ host: '127.0.0.1', port: 0 });
  const chunk = frame(Buffer.alloc(256 * 1024, 65));
  let removed = 0;
  let generated = 0;
  let generatedWhilePaused = 0;
  const stream = Readable.from((async function* () {
    for (let index = 0; index < 128; index += 1) { generated += 1; yield chunk; }
  })(), { objectMode: false });
  t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({}) }));
  t.mock.method(docker, 'createContainer', async () => ({
    attach: async () => stream,
    start: async () => {},
    wait: async () => ({ StatusCode: 0 }),
    remove: async () => { removed += 1; },
  }));
  let resumeTimer;
  try {
    const received = await new Promise((resolve, reject) => {
      const request = http.get(`${address}${url}`, response => {
        let bytes = 0;
        let paused = false;
        response.on('data', data => {
          bytes += data.length;
          if (!paused) {
            paused = true;
            response.pause();
            resumeTimer = setTimeout(() => { generatedWhilePaused = generated; response.resume(); }, 5300);
          }
        });
        response.once('end', () => resolve(bytes));
        response.once('error', reject);
      });
      request.once('error', reject);
    });
    assert.equal(received, 128 * 256 * 1024);
    assert(generatedWhilePaused < 128, 'HTTP backpressure must reach the Docker producer');
    assert.equal(removed, 1);
  } finally {
    clearTimeout(resumeTimer);
    await isolatedApp.close();
  }
});
