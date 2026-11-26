import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import tar from 'tar-stream';
import { buildRestorePlan, validateRestoreTar, readRestoreManifest } from '../src/services/maintenance-restore.js';
import { encryptArtifact } from '../src/services/maintenance-archive.js';
const manifest = () => ({ id: randomUUID(), type: 'full', sources: [{ kind: 'project', source: '/apps/web' }], artifacts: [
  { kind: 'project', source: '/apps/web', archiveRoot: 'web', file: 'source-0.tar.enc' },
  { kind: 'volume', source: 'prod_db', archiveRoot: '1', file: 'source-1.tar.enc' },
  { kind: 'writable-layer', containerId: 'c1', imageId: 'sha256:fixed', file: 'rootfs-0.tar.enc' },
], containers: [{ Id: 'c1', Name: '/web', State: { Running: true }, Config: { Image: 'app:latest', Env: ['PASSWORD=fixture'], Entrypoint: ['node'], Cmd: ['app.js'], Labels: { 'com.docker.compose.service': 'web' } }, HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '80' }] }, RestartPolicy: { Name: 'always' } }, Mounts: [{ Type: 'bind', Source: '/apps/web/config.json', Destination: '/config.json', RW: false }, { Type: 'volume', Name: 'prod_db', Destination: '/db', RW: true }], NetworkSettings: { Networks: { prod: { Aliases: ['web'] } } } }] });
test('恢复映射只使用新目录、固定可写层镜像和隔离网络，不复用生产端口或卷', () => {
  const id = randomUUID(), result = buildRestorePlan(manifest(), '/restore', id), service = result.compose.services.service0;
  assert.deepEqual(result.blockers, []);
  assert.equal(service.image, 'sha256:fixed');
  assert.equal(service.restart, 'no');
  assert.equal(service.ports, undefined);
  assert.equal(service.network_mode, undefined);
  assert.equal(service.volumes[1].type, 'bind');
  assert.ok(service.volumes.every(v => v.source.startsWith(result.root + '/sources/')));
  assert.ok(service.volumes[0].source.endsWith('/web/config.json'));
  assert.equal(service.volumes[0].read_only, true);
  assert.ok(Object.values(result.compose.networks).every(n => n.internal));
  assert.deepEqual(result.originallyRunningServices, ['service0']);
});
test('宿主权限、外部运行依赖与缺失快照不能伪装成可隔离恢复', () => {
  for (const patch of [{ Privileged: true }, { NetworkMode: 'host' }, { Devices: [{}] }, { CapAdd: ['SYS_ADMIN'] }]) {
    const input = manifest(); input.containers[0].HostConfig = patch;
    assert.ok(buildRestorePlan(input, '/restore', randomUUID()).blockers.length);
  }
  const input = manifest(); input.containers[0].Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' });
  assert.ok(buildRestorePlan(input, '/restore', randomUUID()).blockers.some(v => v.includes('不能复用')));
  input.artifacts = input.artifacts.filter(a => a.kind !== 'writable-layer');
  assert.ok(buildRestorePlan(input, '/restore', randomUUID()).blockers.some(v => v.includes('缺少')));
});
test('归档验证拒绝路径穿越、绝对软链和链接后写入，允许内部链接', async t => {
  const dir = await mkdtemp('/tmp/restore-tar-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [
    [[{ name: '../escape' }, 'x']],
    [[{ name: 'data/link', type: 'symlink', linkname: '/etc' }, '']],
    [[{ name: 'data/link', type: 'symlink', linkname: '../out' }, '']],
    [[{ name: 'data/link', type: 'symlink', linkname: '.' }, ''], [{ name: 'data/link/file' }, 'x']],
  ];
  for (const [i, entries] of cases.entries()) {
    const pack = tar.pack(), file = path.join(dir, i + '.tar');
    const done = pipeline(pack, createWriteStream(file));
    for (const [header, body] of entries) pack.entry(header, body); pack.finalize(); await done;
    await assert.rejects(validateRestoreTar(file, 'data'));
  }
  const pack = tar.pack(), file = path.join(dir, 'valid.tar');
  const done = pipeline(pack, createWriteStream(file));
  pack.entry({ name: 'data/file' }, 'ok'); pack.entry({ name: 'data/link', type: 'symlink', linkname: 'file' }); pack.finalize(); await done;
  await validateRestoreTar(file, 'data');
});
test('恢复必须用认证清单核对所有产物；删减和损坏收据不能通过', async t => {
  const dir = await mkdtemp('/tmp/restore-manifest-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const key = randomBytes(32), id = randomUUID();
  const artifact = { ...await encryptArtifact('fixture', path.join(dir, 'source-0.tar.enc'), key), kind: 'bind' };
  const input = { id, type: 'full', artifacts: [artifact], containers: [] };
  const encrypted = { ...await encryptArtifact(JSON.stringify(input), path.join(dir, 'manifest.json.enc'), key), kind: 'manifest' };
  const receipt = { id, type: 'full', complete: true, fileVerified: true, artifacts: [artifact, encrypted] };
  await writeFile(path.join(dir, 'receipt.json'), JSON.stringify(receipt));
  assert.equal((await readRestoreManifest(dir, key)).id, id);
  await assert.rejects(readRestoreManifest(dir, randomBytes(32)));
  const content = await readFile(path.join(dir, artifact.file)); content[20] ^= 1; await writeFile(path.join(dir, artifact.file), content);
  await assert.rejects(readRestoreManifest(dir, key), /校验失败/);
});
