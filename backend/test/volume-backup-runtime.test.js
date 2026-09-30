import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-volume-runtime-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
const { createVolumeBackup, deleteVolumeBackup } = await import('../src/services/volume-backup.js');
const { getActivityDocker } = await import('../src/services/docker-hosts.js');
const { setSetting, addVolumeBackup, getVolumeBackup } = await import('../src/lib/db.js');
setSetting('backup.volume_dir', tempDir);
const docker = getActivityDocker();
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function frame(text) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test('备份文件删除失败时保留记录并报告失败', async (t) => {
  const id = addVolumeBackup({ projectId: 'delete-test', projectName: 'delete-test', volume: 'test-volume', file: 'delete-test.tar.gz', bytes: 123, host: 'local' });
  t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({}) }));
  t.mock.method(docker, 'createContainer', async () => ({
    start: async () => {}, wait: async () => ({ StatusCode: 1 }),
    logs: async () => frame('Permission denied\n'), remove: async () => {},
  }));
  await assert.rejects(() => deleteVolumeBackup(id), /删除备份文件失败/);
  assert.ok(getVolumeBackup(id), '记录必须保留,以便用户重试');
});
for (const mode of ['buffer', 'stream']) {
  test(`卷备份接受 Docker logs 的 ${mode} 响应,读取完整输出并移除 helper`, async (t) => {
    const removed = [];
    t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({}) }));
    t.mock.method(docker, 'createContainer', async () => ({
      start: async () => {}, wait: async () => ({ StatusCode: 0 }),
      logs: async () => {
        if (mode === 'buffer') return frame('123\n');
        const stream = new PassThrough();
        setImmediate(() => { for (const byte of frame('123\n')) stream.write(Buffer.from([byte])); stream.end(); });
        return stream;
      },
      remove: async () => removed.push(true),
    }));
    const record = await createVolumeBackup({ id: 'test-project', projectName: 'test-project' }, 'test-volume');
    assert.equal(record.bytes, 123);
    assert.equal(removed.length, 1);
  });
}
