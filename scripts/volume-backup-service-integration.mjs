/** Real route/service recovery drill. Only the uniquely named fixture is mutated. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'composeops-volume-service-'));
const projectName = `co-volume-service-${Date.now()}-${randomBytes(3).toString('hex')}`;
const composeFile = path.join(directory, 'compose.yaml');
const archiveDirectory = path.join(directory, 'archives');
const volume = `${projectName}_data`;
const missingVolume = `${projectName}_missing`;
const undeclaredVolume = `${projectName}_undeclared`;
const helperLabel = `composeops.integration=${projectName}`;
const checks = [];
const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
});
const compose = (...args) => docker('compose', '--project-name', projectName, '-f', composeFile, ...args);
const helper = (command, mode = 'ro') => docker('run', '--rm', '--network', 'none', '--label', helperLabel,
  '--mount', `type=volume,source=${volume},target=/data,readonly=${mode === 'ro'}`, 'busybox:1.36', 'sh', '-ec', command);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const volumeNames = () => docker('volume', 'ls', '-q').trim().split('\n').filter(Boolean);
const roleResources = () => ({
  helpers: docker('ps', '-aq', '--filter', 'label=composeops.role=volume-backup').trim(),
  verificationVolumes: docker('volume', 'ls', '-q', '--filter', 'label=composeops.role=volume-verify').trim(),
});
const snapshot = () => helper('cd /data; find . -type f -exec sha256sum {} \\; | sort; find . -type l -exec ls -l {} \\; | sort');
const replaceArchive = (file, bytes) => {
  // Helpers create root-owned archives. Replace through our owned parent directory.
  const target = path.join(archiveDirectory, file);
  writeFileSync(`${target}.replacement`, bytes);
  renameSync(`${target}.replacement`, target);
};
let app;
let before;
let productionContainer;
let result;

process.env.DB_PATH = path.join(directory, 'test.db');
process.env.SERVE_FRONTEND = '0';
writeFileSync(composeFile, `services:
  probe:
    image: busybox:1.36
    command: ["sleep", "600"]
    network_mode: none
    volumes:
      - data:/data
volumes:
  data: {}
  missing: {}
`);

try {
  before = roleResources();
  productionContainer = docker('ps', '-q', '--filter', 'name=^opsdash$').trim();
  compose('create');
  helper("mkdir -p /data/nested; printf 'original snapshot\\n' > /data/nested/payload.txt; printf '隐藏文件\\n' > /data/.hidden; ln -s nested/payload.txt /data/link; chmod 640 /data/nested/payload.txt", 'rw');
  const original = snapshot();
  assert(!volumeNames().includes(missingVolume));

  const { default: Fastify } = await import('fastify');
  const { default: routes } = await import('../backend/src/routes/ops.js');
  const { scanProjects } = await import('../backend/src/services/scanner.js');
  const { setProjectPreference, setSetting, addVolumeBackup } = await import('../backend/src/lib/db.js');
  const project = (await scanProjects()).find(item => item.projectName === projectName);
  assert(project, 'Scanner must discover the isolated Compose project');
  setSetting('backup.volume_dir.local', archiveDirectory);
  setProjectPreference(project.id, { managed: false, mountEnabled: true });
  app = Fastify({ logger: false });
  await app.register(routes, { prefix: '/api/v1/ops' });
  const base = '/api/v1/ops/storage';
  const request = async (method, endpoint, expected, payload) => {
    const response = await app.inject({ method, url: `${base}/${endpoint}`, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, expected, `${method} ${endpoint}: ${response.body.slice(0, 400)}`);
    return response;
  };
  const list = async () => (await request('GET', `volume-backups?projectId=${project.id}`, 200)).json().backups;
  const create = requestedVolume => request('POST', 'volume-backups', 200, { projectId: project.id, volume: requestedVolume });

  await request('GET', `volume-volumes?projectId=${project.id}`, 403);
  await request('POST', 'volume-backups', 403, { projectId: project.id, volume });
  checks.push('unmanaged project rejected');
  setProjectPreference(project.id, { managed: true, mountEnabled: true });
  const listed = (await request('GET', `volume-volumes?projectId=${project.id}`, 200)).json().volumes;
  assert.equal(listed.find(item => item.name === volume)?.exists, true);
  assert.equal(listed.find(item => item.name === missingVolume)?.exists, false);
  for (const name of [missingVolume, undeclaredVolume]) {
    await request('POST', 'volume-backups', 404, { projectId: project.id, volume: name });
    assert(!volumeNames().includes(name), 'Rejected request must not create an empty volume');
  }
  assert.equal((await list()).length, 0);
  checks.push('declared and existing volume required');

  const backup = (await create(volume)).json();
  assert(backup.bytes > 0);
  const archive = readFileSync(path.join(archiveDirectory, backup.file));
  assert.equal(archive.length, backup.bytes);
  assert.equal((await list())[0].id, backup.id);
  assert.equal((await list())[0].host, 'local');
  const download = await request('GET', `volume-backups/${backup.id}/download`, 200);
  assert.match(download.headers['content-type'], /application\/gzip/);
  assert.match(download.headers['content-disposition'], /attachment/);
  assert.equal(digest(download.rawPayload), digest(archive));
  checks.push('archive persisted and downloaded byte-for-byte');

  const verified = (await request('POST', `volume-backups/${backup.id}/verify`, 200)).json();
  assert.equal(verified.status, 'verified');
  assert.equal(verified.files, 2);
  assert.equal((await list())[0].verifyStatus, 'verified');
  assert.equal(snapshot(), original);
  assert.deepEqual(roleResources(), before);
  checks.push('verification extracts to disposable volume and preserves source');

  helper("printf 'modified live content\\n' > /data/nested/payload.txt; printf 'remove me\\n' > /data/extra.txt; rm /data/.hidden", 'rw');
  const changed = snapshot();
  assert.notEqual(changed, original);
  const restored = (await request('POST', `volume-backups/${backup.id}/restore`, 200)).json();
  assert.equal(restored.replaced, true);
  assert.equal(snapshot(), original);
  assert.equal(helper('stat -c %a /data/nested/payload.txt').trim(), '640');
  assert.deepEqual(readdirSync(archiveDirectory), [backup.file], 'Successful restore must remove its safety archive');
  checks.push('restore replaces contents, restores hidden files, modes and symbolic links');

  helper("printf 'preserve this current data\\n' > /data/nested/payload.txt", 'rw');
  const beforeCorruptRestore = snapshot();
  replaceArchive(backup.file, archive.subarray(0, Math.floor(archive.length / 2)));
  await request('POST', `volume-backups/${backup.id}/verify`, 502);
  assert.equal((await list())[0].verifyStatus, 'failed');
  await request('POST', `volume-backups/${backup.id}/restore`, 502);
  assert.equal(snapshot(), beforeCorruptRestore);
  assert.deepEqual(roleResources(), before);
  checks.push('truncated archive rejected before target mutation');

  replaceArchive(backup.file, archive);
  await request('POST', `volume-backups/${backup.id}/verify`, 200);
  await request('DELETE', `volume-backups/${backup.id}`, 200);
  assert.equal((await list()).length, 0);
  assert.deepEqual(readdirSync(archiveDirectory), []);
  await request('GET', `volume-backups/${backup.id}/download`, 404);
  await request('POST', `volume-backups/${backup.id}/restore`, 404);
  assert.equal(snapshot(), beforeCorruptRestore);
  checks.push('delete removes archive and record while preserving source');

  // Exercise remote streaming against the real local daemon without exposing its API.
  // Only the transport adapter is substituted; archive helpers and HTTP bytes remain real.
  const { upsertHost, getDockerForHost } = await import('../backend/src/services/docker-hosts.js');
  upsertHost({ id: 'integration-remote', name: 'Remote path fixture', type: 'tcp', host: '127.0.0.1', port: 1 });
  setSetting('backup.volume_dir.integration-remote', archiveDirectory);
  const remoteDocker = getDockerForHost('integration-remote');
  const localDocker = getDockerForHost('local');
  const previousGetImage = remoteDocker.getImage;
  const previousCreateContainer = remoteDocker.createContainer;
  remoteDocker.getImage = localDocker.getImage.bind(localDocker);
  remoteDocker.createContainer = localDocker.createContainer.bind(localDocker);
  try {
    const remoteFile = 'remote-download.tar.gz';
    writeFileSync(path.join(archiveDirectory, remoteFile), archive);
    const remoteId = addVolumeBackup({ projectId: `${project.id}-remote`, projectName, volume: missingVolume, file: remoteFile, bytes: archive.length, host: 'integration-remote' });
    const remoteDownload = await request('GET', `volume-backups/${remoteId}/download`, 200);
    assert.equal(digest(remoteDownload.rawPayload), digest(archive));
    assert.match(remoteDownload.headers['content-type'], /application\/gzip/);
    assert.match(remoteDownload.headers['content-disposition'], /remote-download\.tar\.gz/);
    assert(!volumeNames().includes(missingVolume), 'Downloading a recovery archive must not recreate its source volume');
    rmSync(path.join(archiveDirectory, remoteFile));
    await request('GET', `volume-backups/${remoteId}/download`, 502);
    await request('DELETE', `volume-backups/${remoteId}`, 200);
    assert.deepEqual(roleResources(), before);
    checks.push('remote download path streams real helper bytes without source volume; missing archive fails clearly');
  } finally {
    remoteDocker.getImage = previousGetImage;
    remoteDocker.createContainer = previousCreateContainer;
  }
  result = { passed: true, projectName, checks, downloadedSha256: digest(archive), scope: 'real local Docker + registered ops routes; isolated database; global authentication stack excluded' };
} finally {
  await app?.close();
  try {
    // This compose project and label were created here; never use global prune.
    for (const id of docker('ps', '-aq', '--filter', `label=${helperLabel}`).trim().split('\n').filter(Boolean)) docker('rm', '-f', id);
    compose('down', '--volumes', '--remove-orphans');
    assert(!volumeNames().includes(volume));
    if (before) assert.deepEqual(roleResources(), before, 'Service helpers must be cleaned up');
    if (productionContainer) assert.equal(docker('ps', '-q', '--filter', 'name=^opsdash$').trim(), productionContainer, 'Production container must remain untouched');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ ...result, isolatedResourcesRemoved: true }, null, 2));
