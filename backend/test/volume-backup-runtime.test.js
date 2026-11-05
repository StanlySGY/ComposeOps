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
const { setSetting, addVolumeBackup, getVolumeBackup, listVolumeBackups } = await import('../src/lib/db.js');
setSetting('backup.volume_dir', tempDir);
const docker = getActivityDocker();
const projectDir = path.join(tempDir, 'project');
const composeFile = path.join(projectDir, 'compose.yaml');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(composeFile, [
  'services:',
  '  app:',
  '    image: busybox:1.36',
  '    volumes:',
  '      - data:/data',
  'volumes:',
  '  data:',
  '    external: true',
  '    name: test-volume',
  '',
].join('\n'));
const project = {
  id: 'test-project',
  projectName: 'test-project',
  composeMode: 'direct',
  workingDir: projectDir,
  composeFiles: [composeFile],
};
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
    t.mock.method(docker, 'listVolumes', async () => ({ Volumes: [{ Name: 'test-volume' }] }));
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
    const record = await createVolumeBackup(project, 'test-volume');
    assert.equal(record.bytes, 123);
    assert.equal(removed.length, 1);
  });
}

test('Agent/service 不能备份未在当前项目 Compose 中声明的其他数据卷', async (t) => {
  t.mock.method(docker, 'listVolumes', async () => ({ Volumes: [{ Name: 'foreign-volume' }, { Name: 'test-volume' }] }));
  let helperStarted = false;
  t.mock.method(docker, 'createContainer', async () => {
    helperStarted = true;
    throw new Error('helper must not run for a foreign volume');
  });

  await assert.rejects(
    () => createVolumeBackup(project, 'foreign-volume'),
    (error) => error.statusCode === 404 && /未在项目 Compose/.test(error.message),
  );
  assert.equal(helperStarted, false, 'foreign volume contents must never be mounted into the backup helper');
});

test('卷备份拒绝自动创建已从 Docker 宿主消失的命名卷', async (t) => {
  t.mock.method(docker, 'listVolumes', async () => ({ Volumes: [] }));
  let helperStarted = false;
  t.mock.method(docker, 'createContainer', async () => {
    helperStarted = true;
    throw new Error('helper must not auto-create a missing volume');
  });

  await assert.rejects(
    () => createVolumeBackup(project, 'test-volume'),
    (error) => error.statusCode === 404 && /尚未在当前宿主上创建/.test(error.message),
  );
  assert.equal(helperStarted, false, 'missing source volume must not be implicitly created by Docker bind semantics');
});

test('卷备份遇到磁盘空间不足时保留既有备份并说明不会自动删除', async (t) => {
  const diskFullProject = { ...project, id: 'disk-full-test' };
  const previousId = addVolumeBackup({
    projectId: diskFullProject.id,
    projectName: project.projectName,
    volume: 'test-volume',
    file: 'previous-valid-backup.tar.gz',
    bytes: 1024,
    host: 'local',
  });
  t.mock.method(docker, 'getImage', () => ({ inspect: async () => ({}) }));
  t.mock.method(docker, 'listVolumes', async () => ({ Volumes: [{ Name: 'test-volume' }] }));
  let helperCommand = '';
  t.mock.method(docker, 'createContainer', async (options) => {
    helperCommand = options.Cmd?.[2] || '';
    return {
      start: async () => {},
      wait: async () => ({ StatusCode: 1 }),
      logs: async () => frame('tar: write error: No space left on device\n'),
      remove: async () => {},
    };
  });

  await assert.rejects(
    () => createVolumeBackup(diskFullProject, 'test-volume'),
    (error) => error.statusCode === 502 && error.code === 'VOLUME_BACKUP_DISK_FULL' && /备份目录空间不足/.test(error.message) && /不会自动删除任何已有备份/.test(error.message),
  );
  assert.ok(getVolumeBackup(previousId), 'low disk space must not delete a previously usable backup');
  assert.equal(listVolumeBackups(diskFullProject.id).length, 1, 'failed backup must not create a database record');
  assert.match(helperCommand, /trap 'rm -f "\$tmp"' EXIT/, 'failed tar must remove its partial archive');
});
