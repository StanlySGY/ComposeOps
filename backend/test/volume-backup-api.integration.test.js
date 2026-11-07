import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const enabled = process.env.COMPOSEOPS_DOCKER_ACCEPTANCE === '1';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-volume-api-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.SERVE_FRONTEND = '0';

const { buildApp } = await import('../src/app.js');
const { getActivityDocker } = await import('../src/services/docker-hosts.js');
const { setPassword } = await import('../src/lib/auth.js');
const { setSetting, addComposeBackup } = await import('../src/lib/db.js');
const { invalidateScanCache } = await import('../src/services/scanner.js');
const { composeProjectId } = await import('../src/services/project-id.js');
const app = await buildApp({ logger: false });
const docker = getActivityDocker();
await app.ready();
setPassword('isolated-docker-api-test-password');

const suffix = process.pid.toString(36) + Date.now().toString(36);
const projectName = 'composeops-accept-api-' + suffix;
const volumeName = projectName + '_data';
const projectDir = path.join(tempDir, 'compose-project');
const composeFile = path.join(projectDir, 'docker-compose.yml');
const backupDir = path.join(tempDir, 'backups');
const projectId = composeProjectId(projectDir, projectName);
let cookie = '';
let sourceVolumeCreated = false;
let dockerListMock;

async function runInVolume(command) {
  const container = await docker.createContainer({
    Image: 'busybox:1.36',
    Cmd: ['sh', '-c', command],
    HostConfig: { Binds: [volumeName + ':/data:rw'] },
    Labels: { 'composeops.role': 'acceptance-test' },
  });
  try {
    await container.start();
    const result = await container.wait();
    assert.equal(result.StatusCode, 0, 'isolated helper command should succeed');
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('isolated Docker + protected API: create, verify, download, restore, delete', { skip: !enabled, timeout: 120000 }, async (t) => {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(composeFile, 'services:\n  web:\n    image: busybox:1.36\n    command: ["sh", "-c", "sleep 3600"]\n    volumes:\n      - data:/data\nvolumes:\n  data:\n', 'utf8');
  setSetting('backup.volume_dir.local', backupDir);

  await docker.createVolume({ Name: volumeName, Labels: { 'composeops.role': 'acceptance-test', 'com.docker.compose.project': projectName, 'com.docker.compose.volume': 'data' } });
  sourceVolumeCreated = true;
  await runInVolume("printf 'composeops-isolated-original-payload\n' > /data/payload.txt");

  const containerInfo = {
    Id: 'isolated-' + suffix,
    Names: ['/isolated-' + suffix],
    State: 'running', Status: 'Up', Image: 'busybox:1.36', Created: Math.floor(Date.now() / 1000), Ports: [],
    Labels: {
      'com.docker.compose.project': projectName,
      'com.docker.compose.project.working_dir': projectDir,
      'com.docker.compose.project.config_files': composeFile,
      'myops.owner': 'acceptance-test',
    },
  };
  dockerListMock = t.mock.method(docker, 'listContainers', async () => [containerInfo]);
  invalidateScanCache();

  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    headers: { origin: 'http://localhost:3001', host: 'localhost:3001' },
    payload: { password: 'isolated-docker-api-test-password' },
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers['set-cookie']).split(';', 1)[0];
  const headers = { cookie, origin: 'http://localhost:3001', host: 'localhost:3001' };

  const management = await app.inject({ method: 'PUT', url: '/api/v1/projects/management', headers, payload: { projectIds: [projectId], mountProjectIds: [projectId] } });
  assert.equal(management.statusCode, 200, management.body);
  invalidateScanCache();

  const volumeList = await app.inject({ method: 'GET', url: '/api/v1/ops/storage/volume-volumes?projectId=' + projectId, headers });
  assert.equal(volumeList.statusCode, 200, volumeList.body);
  assert.ok(volumeList.json().volumes.some((volume) => volume.name === volumeName && volume.exists === true), volumeList.body);

  const [created, concurrentCreated] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups', headers, payload: { projectId, volume: volumeName } }),
    app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups', headers, payload: { projectId, volume: volumeName } }),
  ]);
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(concurrentCreated.statusCode, 200, concurrentCreated.body);
  const backup = created.json();
  const concurrentBackup = concurrentCreated.json();
  assert.ok(Number.isInteger(backup.id) && backup.id > 0, created.body);
  assert.ok(Number.isInteger(concurrentBackup.id) && concurrentBackup.id > 0, concurrentCreated.body);
  assert.notEqual(backup.file, concurrentBackup.file, 'concurrent backups of the same volume must publish unique archive names');
  assert.ok(fs.existsSync(path.join(backupDir, backup.file)), 'backup archive must exist on disk');
  assert.ok(fs.existsSync(path.join(backupDir, concurrentBackup.file)), 'concurrent backup archive must exist on disk');

  const verify = await app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups/' + backup.id + '/verify', headers });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().ok, true, verify.body);
  assert.ok(['verified', 'empty'].includes(verify.json().status), verify.body);

  // A broken gzip trailer must fail verification; restore the isolated archive afterward.
  const archivePath = path.join(backupDir, backup.file);
  const validArchive = fs.readFileSync(archivePath);
  const corruptedArchive = Buffer.from(validArchive);
  corruptedArchive[corruptedArchive.length - 1] ^= 0xff;
  // Docker writes the archive as root; replace the file through its user-owned parent directory.
  fs.unlinkSync(archivePath);
  fs.writeFileSync(archivePath, corruptedArchive);
  const corruptVerify = await app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups/' + backup.id + '/verify', headers });
  assert.equal(corruptVerify.statusCode, 502, corruptVerify.body);
  await runInVolume("printf 'must-preserve-after-corrupt-restore\\n' > /data/payload.txt");
  const corruptRestore = await app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups/' + backup.id + '/restore', headers });
  assert.equal(corruptRestore.statusCode, 502, corruptRestore.body);
  await runInVolume("grep -q 'must-preserve-after-corrupt-restore' /data/payload.txt");
  fs.writeFileSync(archivePath, validArchive);
  const reverify = await app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups/' + backup.id + '/verify', headers });
  assert.equal(reverify.statusCode, 200, reverify.body);

  // Fail after the target volume has been cleared; the restore EXIT trap must put the safety snapshot back.
  await runInVolume("printf 'must-survive-restore-failure\\n' > /data/payload.txt && printf 'keep-after-failure\\n' > /data/keep.txt");
  let failRestoreExtraction = true;
  const originalCreateContainer = docker.createContainer.bind(docker);
  const createContainerMock = t.mock.method(docker, 'createContainer', async (config) => {
    const command = Array.isArray(config.Cmd) ? String(config.Cmd[2] || '') : '';
    if (failRestoreExtraction && command.includes('cleanup_restore()')) {
      failRestoreExtraction = false;
      const failedCommand = command.replace(`tar xzf "/backup/${backup.file}" -C /src`, 'false');
      assert.notEqual(failedCommand, command, 'fault injection must target the final restore extraction');
      return originalCreateContainer({ ...config, Cmd: [...config.Cmd.slice(0, 2), failedCommand] });
    }
    return originalCreateContainer(config);
  });
  const interruptedRestore = await app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups/' + backup.id + '/restore', headers });
  assert.equal(interruptedRestore.statusCode, 502, interruptedRestore.body);
  assert.equal(failRestoreExtraction, false, 'fault injection should run exactly once');
  await runInVolume("grep -q 'must-survive-restore-failure' /data/payload.txt && grep -q 'keep-after-failure' /data/keep.txt");
  createContainerMock.mock.restore();

  // If both extraction and compensation fail, retain and register the pre-restore safety archive.
  await runInVolume("printf 'must-survive-emergency-snapshot\\n' > /data/payload.txt && printf 'emergency-keep\\n' > /data/keep.txt");
  let failRestoreAndCompensation = true;
  const emergencyCreateContainerMock = t.mock.method(docker, 'createContainer', async (config) => {
    const command = Array.isArray(config.Cmd) ? String(config.Cmd[2] || '') : '';
    if (failRestoreAndCompensation && command.includes('cleanup_restore()')) {
      failRestoreAndCompensation = false;
      const failedCommand = command
        .replace(`tar xzf "/backup/${backup.file}" -C /src`, 'false')
        .replace('tar xzf "$rollback" -C /src', 'false');
      assert.notEqual(failedCommand, command, 'fault injection must fail both the requested restore and its compensation');
      return originalCreateContainer({ ...config, Cmd: [...config.Cmd.slice(0, 2), failedCommand] });
    }
    return originalCreateContainer(config);
  });
  const failedCompensationRestore = await app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups/' + backup.id + '/restore', headers });
  assert.equal(failedCompensationRestore.statusCode, 502, failedCompensationRestore.body);
  assert.equal(failRestoreAndCompensation, false, 'compensation failure injection should run exactly once');
  emergencyCreateContainerMock.mock.restore();

  const backupsAfterCompensationFailure = await app.inject({ method: 'GET', url: '/api/v1/ops/storage/volume-backups?projectId=' + projectId, headers });
  assert.equal(backupsAfterCompensationFailure.statusCode, 200, backupsAfterCompensationFailure.body);
  const emergencyBackup = backupsAfterCompensationFailure.json().backups.find((row) => row.file.startsWith('.composeops-restore-'));
  assert.ok(emergencyBackup?.id, 'failed compensation must register the preserved safety archive as a recoverable backup');
  assert.ok(fs.existsSync(path.join(backupDir, emergencyBackup.file)), 'emergency safety archive must remain on disk');

  const emergencyRestore = await app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups/' + emergencyBackup.id + '/restore', headers });
  assert.equal(emergencyRestore.statusCode, 200, emergencyRestore.body);
  await runInVolume("grep -q 'must-survive-emergency-snapshot' /data/payload.txt && grep -q 'emergency-keep' /data/keep.txt");
  const emergencyDeleted = await app.inject({ method: 'DELETE', url: '/api/v1/ops/storage/volume-backups/' + emergencyBackup.id, headers });
  assert.equal(emergencyDeleted.statusCode, 200, emergencyDeleted.body);
  assert.equal(fs.existsSync(path.join(backupDir, emergencyBackup.file)), false, 'emergency safety archive should be removable after recovery');

  const downloaded = await app.inject({ method: 'GET', url: '/api/v1/ops/storage/volume-backups/' + backup.id + '/download', headers });
  assert.equal(downloaded.statusCode, 200, downloaded.body.slice(0, 200));
  assert.match(String(downloaded.headers['content-type']), /application\/gzip/);
  const diskBytes = fs.readFileSync(path.join(backupDir, backup.file));
  assert.equal(sha256(Buffer.from(downloaded.rawPayload || downloaded.payload, 'binary')), sha256(diskBytes), 'download bytes must match stored archive');

  await runInVolume("printf 'changed-payload\n' > /data/payload.txt && printf 'must-disappear-after-restore\n' > /data/stale.txt");
  const restore = await app.inject({ method: 'POST', url: '/api/v1/ops/storage/volume-backups/' + backup.id + '/restore', headers });
  assert.equal(restore.statusCode, 200, restore.body);
  await runInVolume("grep -q 'composeops-isolated-original-payload' /data/payload.txt && test ! -e /data/stale.txt");

  const up = await app.inject({ method: 'POST', url: '/api/v1/projects/' + projectId + '/actions', headers, payload: { action: 'up' } });
  assert.equal(up.statusCode, 200, up.body);
  assert.match(up.body, /"code":0/, 'isolated Compose up should finish successfully');
  const stop = await app.inject({ method: 'POST', url: '/api/v1/projects/' + projectId + '/actions', headers, payload: { action: 'stop' } });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.match(stop.body, /"code":0/, 'isolated Compose stop should finish successfully');
  const restart = await app.inject({ method: 'POST', url: '/api/v1/projects/' + projectId + '/actions', headers, payload: { action: 'up' } });
  assert.equal(restart.statusCode, 200, restart.body);
  assert.match(restart.body, /"code":0/, 'isolated Compose start after stop should finish successfully');

  const originalCompose = fs.readFileSync(composeFile, 'utf8');
  addComposeBackup(projectId, composeFile, originalCompose, 'upgrade');
  fs.writeFileSync(composeFile, ['services:', '  web:', '    image: busybox:1.36', '    command: ["sh", "-c", "exit 0"]', 'volumes:', '  data:', ''].join(String.fromCharCode(10)), 'utf8');
  const rollback = await app.inject({ method: 'POST', url: '/api/v1/projects/' + projectId + '/rollback', headers });
  assert.equal(rollback.statusCode, 200, rollback.body);
  assert.match(rollback.body, /"ok":true/, 'rollback API should report success');
  assert.equal(fs.readFileSync(composeFile, 'utf8'), originalCompose, 'rollback API must restore the saved Compose definition');

  const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/ops/storage/volume-backups/' + backup.id, headers });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(deleted.json().ok, true);
  assert.equal(fs.existsSync(path.join(backupDir, backup.file)), false, 'delete API must remove the archive');
  const concurrentDeleted = await app.inject({ method: 'DELETE', url: '/api/v1/ops/storage/volume-backups/' + concurrentBackup.id, headers });
  assert.equal(concurrentDeleted.statusCode, 200, concurrentDeleted.body);
  assert.equal(fs.existsSync(path.join(backupDir, concurrentBackup.file)), false, 'delete API must remove the concurrent archive');
  const listed = await app.inject({ method: 'GET', url: '/api/v1/ops/storage/volume-backups?projectId=' + projectId, headers });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().backups.some((row) => row.id === backup.id), false, 'delete API must remove the database record');
  assert.equal(listed.json().backups.some((row) => row.id === concurrentBackup.id), false, 'delete API must remove the concurrent backup database record');
});

test.after(async () => {
  dockerListMock?.mock?.restore?.();
  invalidateScanCache();
  try { execFileSync('docker', ['compose', '--project-name', projectName, '-f', composeFile, 'down', '--remove-orphans', '--volumes'], { cwd: projectDir, stdio: 'ignore', timeout: 15000 }); } catch { /* Cleanup below removes any remaining test volume. */ }
  if (sourceVolumeCreated) await docker.getVolume(volumeName).remove({ force: true }).catch(() => {});
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
