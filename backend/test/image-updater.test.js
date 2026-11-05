import assert from 'node:assert/strict';
import test from 'node:test';
import { compareImageDigests, extractImageServices, parseImageRef, selectLatestUpgradeBackupBatch, hasMatchingComposeBackupFiles, restoreComposeBackupBatch } from '../src/services/image-updater.js';

test('parseImageRef: normalizes Docker Hub official images and default tags', () => {
  assert.deepEqual(parseImageRef('nginx'), {
    registry: 'docker.io', image: 'library/nginx', tag: 'latest', digest: null, original: 'nginx',
  });
  assert.deepEqual(parseImageRef('acme/api:v2'), {
    registry: 'docker.io', image: 'acme/api', tag: 'v2', digest: null, original: 'acme/api:v2',
  });
});

test('parseImageRef: preserves custom registries, ports and digest pins', () => {
  assert.deepEqual(parseImageRef('registry.example.com:5443/team/api:2026.11'), {
    registry: 'registry.example.com:5443', image: 'team/api', tag: '2026.11', digest: null,
    original: 'registry.example.com:5443/team/api:2026.11',
  });
  const digest = 'sha256:' + 'a'.repeat(64);
  assert.equal(parseImageRef('redis@' + digest).digest, digest);
  assert.equal(parseImageRef('image:'), null);
  assert.equal(parseImageRef('image:tag with-space'), null);
});

test('extractImageServices: distinguishes remote, local build, explicit policy and unresolved references', () => {
  const compose = [
    'services:',
    '  web:',
    '    image: nginx:1.27',
    '  local:',
    '    build: .',
    '  ambiguous:',
    '    image: acme/app:latest',
    '    build: .',
    '  remote-build:',
    '    image: acme/worker:stable',
    '    build: .',
    '    pull_policy: always',
    '  pinned:',
    '    image: redis@sha256:' + 'a'.repeat(64),
    '  templated:',
    '    image: "registry.example.com/app:"',
    '  ignored:',
    '    command: echo image:ignored',
  ].join('\n');
  const services = extractImageServices(compose);
  const byName = Object.fromEntries(services.map((item) => [item.service, item]));
  assert.equal(byName.web.status, 'remote');
  assert.equal(byName.local.status, 'local_build');
  assert.equal(byName.ambiguous.status, 'needs_policy');
  assert.equal(byName['remote-build'].status, 'remote');
  assert.equal(byName.pinned.status, 'pinned');
  assert.equal(byName.templated.status, 'unresolved');
  assert.equal(byName.ignored, undefined);
});

test('extractImageServices: merges override files by service name', () => {
  const services = extractImageServices([
    'services:\n  web:\n    image: nginx:1.27\n  worker:\n    image: busybox:1.36\n',
    'services:\n  web:\n    pull_policy: always\n',
  ]);
  assert.equal(services.find((item) => item.service === 'web').status, 'remote');
  assert.equal(services.find((item) => item.service === 'worker').status, 'remote');
});

test('compareImageDigests: only compares RepoDigest for the exact normalized repository', () => {
  const parsed = parseImageRef('nginx:latest');
  const updated = compareImageDigests({ RepoDigests: ['docker.io/library/nginx@sha256:old'] }, 'sha256:new', parsed);
  assert.equal(updated.status, 'updated');
  assert.equal(updated.hasUpdate, true);

  const current = compareImageDigests({ RepoDigests: ['nginx@sha256:same'] }, 'sha256:same', parsed);
  assert.equal(current.status, 'current');
  assert.equal(current.hasUpdate, false);

  const unrelated = compareImageDigests({ RepoDigests: ['docker.io/library/httpd@sha256:old'] }, 'sha256:new', parsed);
  assert.equal(unrelated.status, 'unknown');
  assert.equal(unrelated.hasUpdate, false);
});

test('compareImageDigests: reports not-downloaded separately from unknown local provenance', () => {
  const parsed = parseImageRef('redis:7');
  assert.deepEqual(compareImageDigests(null, 'sha256:remote', parsed), {
    status: 'not_downloaded', localDigest: null, remoteDigest: 'sha256:remote', hasUpdate: true,
  });
  assert.equal(compareImageDigests({ Id: 'sha256:image-id', RepoDigests: [] }, 'sha256:remote', parsed).status, 'unknown');
});


test('selectLatestUpgradeBackupBatch: restores only the newest complete batch', () => {
  const backups = [
    { id: 9, filePath: 'compose.override.yml', reason: 'upgrade:batch-new', createdAt: '2026-11-05 10:00:00' },
    { id: 8, filePath: 'compose.yml', reason: 'upgrade:batch-new', createdAt: '2026-11-05 10:00:00' },
    { id: 7, filePath: 'compose.yml', reason: 'upgrade:batch-old', createdAt: '2026-11-04 10:00:00' },
    { id: 6, filePath: 'compose.yml', reason: 'save', createdAt: '2026-11-05 10:00:00' },
  ];
  assert.deepEqual(selectLatestUpgradeBackupBatch(backups).map((item) => item.id), [9, 8]);
});

test('selectLatestUpgradeBackupBatch: groups legacy upgrade records by their creation time', () => {
  const backups = [
    { id: 5, filePath: 'compose.override.yml', reason: 'upgrade', createdAt: '2026-11-05 10:00:00' },
    { id: 4, filePath: 'compose.yml', reason: 'upgrade', createdAt: '2026-11-05 10:00:00' },
    { id: 3, filePath: 'compose.yml', reason: 'upgrade', createdAt: '2026-11-04 10:00:00' },
  ];
  assert.deepEqual(selectLatestUpgradeBackupBatch(backups).map((item) => item.id), [5, 4]);
  assert.deepEqual(selectLatestUpgradeBackupBatch([]), []);
});


test('hasMatchingComposeBackupFiles: requires a one-to-one match with the current Compose file set', () => {
  const backups = [
    { filePath: 'compose.yml' },
    { filePath: 'compose.override.yml' },
  ];
  assert.equal(hasMatchingComposeBackupFiles(backups, ['compose.yml', 'compose.override.yml']), true);
  assert.equal(hasMatchingComposeBackupFiles(backups, ['compose.yml']), false);
  assert.equal(hasMatchingComposeBackupFiles(backups, ['compose.yml', 'compose.new.yml']), false);
  assert.equal(hasMatchingComposeBackupFiles([{ filePath: 'compose.yml' }, { filePath: 'compose.yml' }], ['compose.yml', 'compose.override.yml']), false);
  assert.equal(hasMatchingComposeBackupFiles([], []), false);
});

test('restoreComposeBackupBatch: a later write failure compensates every file already touched', async () => {
  const disk = new Map([
    ['compose.yml', 'current-main'],
    ['compose.override.yml', 'current-override'],
  ]);
  const backups = [
    { filePath: 'compose.yml', content: 'backup-main' },
    { filePath: 'compose.override.yml', content: 'backup-override' },
  ];
  const current = [...disk].map(([filePath, content]) => ({ filePath, content }));
  await assert.rejects(
    restoreComposeBackupBatch(backups, current, async (filePath, content) => {
      if (filePath === 'compose.override.yml' && content === 'backup-override') {
        throw new Error('simulated write failure');
      }
      disk.set(filePath, content);
    }),
    /simulated write failure.*已将本次触及的文件恢复为操作前内容/,
  );
  assert.equal(disk.get('compose.yml'), 'current-main');
  assert.equal(disk.get('compose.override.yml'), 'current-override');
});

test('restoreComposeBackupBatch: reads must be complete and paths must match before any write', async () => {
  let writes = 0;
  const writer = async () => { writes += 1; };
  await assert.rejects(
    restoreComposeBackupBatch(
      [{ filePath: 'compose.yml', content: 'backup' }, { filePath: 'override.yml', content: 'backup' }],
      [{ filePath: 'compose.yml', content: 'current' }],
      writer,
    ),
    /恢复批次不完整/,
  );
  await assert.rejects(
    restoreComposeBackupBatch(
      [
        { filePath: 'compose.yml', content: 'backup-main' },
        { filePath: 'override.yml', content: 'backup-override' },
      ],
      [{ filePath: 'compose.yml', content: 'current' }, { filePath: 'compose.yml', content: 'duplicate' }],
      writer,
    ),
    /快照不完整或包含重复文件/,
  );
  assert.equal(writes, 0);
});
