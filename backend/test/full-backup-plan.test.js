import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFullBackupPlan, belongsToBackupProject } from '../src/services/full-backup-plan.js';

const root = '/srv/apps/example';
const project = { id: 'p1', projectName: 'example', workingDir: root, managed: true };
const host = { id: 'local', name: '本机', type: 'local', password: 'host-secret-must-not-leak' };
const labels = { 'com.docker.compose.project': 'example', 'com.docker.compose.project.working_dir': root, 'com.docker.compose.service': 'web' };
const container = {
  Id: 'c1', Name: '/example-web', Image: 'sha256:actual-image', State: { Running: true },
  Config: { Image: 'example/web:1', Labels: labels, Env: ['PASSWORD=container-secret-must-not-leak'] },
  Mounts: [
    { Type: 'bind', Source: `${root}/data`, Destination: '/data', RW: true },
    { Type: 'bind', Source: '/srv/shared/config.json', Destination: '/config.json', RW: false },
    { Type: 'volume', Name: 'example_db', Destination: '/db', Driver: 'local' },
    { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
  ],
};
const compose = `services:
  web:
    image: example/web:1
    environment:
      PASSWORD: compose-secret-must-not-leak
    env_file: [private.env]
    volumes: ["./data:/data", "db:/db"]
  optional:
    image: example/optional:1
    profiles: [extra]
volumes:
  db: {}
secrets:
  api:
    file: ./secret.txt
`;
const input = (patch = {}) => ({ project, host, containers: [structuredClone(container)],
  composeFiles: [{ path: `${root}/compose.yaml`, status: 'readable', content: compose }], ...patch });

test('保留宿主目录、单文件、卷、镜像和配置清单，且不返回秘密值', () => {
  const plan = buildFullBackupPlan(input());
  for (const [kind, source] of [['bind', `${root}/data`], ['bind', '/srv/shared/config.json'], ['volume', 'example_db'],
    ['image', 'sha256:actual-image'], ['env_file', `${root}/private.env`], ['configuration_file', `${root}/secret.txt`]]) {
    assert.ok(plan.resources.some(item => item.kind === kind && item.source === source), `${kind}:${source}`);
  }
  assert.equal(plan.resources.filter(item => item.kind === 'bind' && item.source === `${root}/data`).length, 1);
  assert.ok(plan.resources.some(item => item.kind === 'runtime_dependency' && item.source === '/var/run/docker.sock'));
  assert.equal(plan.executionAvailable, false);
  assert.equal(plan.coverageVerified, false);
  assert.equal(plan.mode, 'preview-only');
  assert.ok(plan.warnings.some(item => item.code === 'stop_required'));
  assert.ok(plan.warnings.some(item => item.code === 'service_not_deployed'));
  assert.doesNotMatch(JSON.stringify(plan), /must-not-leak|Config|Env"/);
});

test('同名不同工作目录不混入当前项目', () => {
  assert.equal(belongsToBackupProject({ Labels: { ...labels } }, project), true);
  assert.equal(belongsToBackupProject({ Labels: { ...labels, 'com.docker.compose.project.working_dir': '/srv/another' } }, project), false);
  assert.equal(belongsToBackupProject({ Labels: { ...labels } }, { ...project, workingDir: '' }), false);
  const foreign = structuredClone(container);
  foreign.Config.Labels['com.docker.compose.project.working_dir'] = '/srv/another';
  const plan = buildFullBackupPlan(input({ containers: [foreign] }));
  assert.ok(plan.blockers.some(item => item.code === 'container_identity_changed'));
  assert.equal(plan.resources.some(item => item.kind === 'volume'), false);
});

test('读取失败与空项目必须显式阻断，不能返回空清单成功', () => {
  const plan = buildFullBackupPlan(input({ containers: [], inspectFailures: ['gone'], composeFiles: [{ path: `${root}/compose.yaml`, status: 'unavailable' }] }));
  for (const code of ['containers_missing', 'container_inspect_failed', 'compose_unreadable']) assert.ok(plan.blockers.some(item => item.code === code));
});

test('未解析引用、include、外部 secrets 不被静默跳过', () => {
  const content = 'include: [../other/compose.yaml]\nservices:\n  web:\n    extends: {file: ../base.yaml, service: base}\n    env_file: ["${ENV_PATH}"]\n    volumes: ["${DATA_PATH}:/data"]\nsecrets:\n  external-secret: {external: true}\n';
  const plan = buildFullBackupPlan(input({ composeFiles: [{ path: `${root}/compose.yaml`, status: 'readable', content }] }));
  for (const code of ['compose_include', 'compose_extends', 'unresolved_file_reference', 'unresolved_mount', 'external_configuration']) assert.ok(plan.blockers.some(item => item.code === code), code);
});

test('损坏 YAML 与非法 services 不被当作有效配置', () => {
  for (const content of ['services: [', 'services: []', 'null']) {
    const plan = buildFullBackupPlan(input({ composeFiles: [{ path: `${root}/compose.yaml`, status: 'readable', content }] }));
    assert.ok(plan.blockers.some(item => item.code === 'compose_invalid'));
  }
});

test('共享挂载的项目外写入者必须阻断一致性预检', () => {
  const plan = buildFullBackupPlan(input({ otherContainers: [{ Id: 'foreign', Mounts: [{ Type: 'volume', Name: 'example_db', RW: true }] }] }));
  assert.ok(plan.blockers.some(item => item.code === 'shared_mount_writer'));
  const readOnly = buildFullBackupPlan(input({ otherContainers: [{ Mounts: [{ Type: 'volume', Name: 'example_db', RW: false }] }] }));
  assert.equal(readOnly.blockers.some(item => item.code === 'shared_mount_writer'), false);
});

test('范围过宽的 NAS 目录保持可见并阻断，不能扩成全盘备份', () => {
  const mine = structuredClone(container);
  mine.Mounts.push({ Type: 'bind', Source: '/vol1', Destination: '/disk' });
  const plan = buildFullBackupPlan(input({ containers: [mine] }));
  assert.ok(plan.resources.some(item => item.kind === 'bind' && item.source === '/vol1'));
  assert.ok(plan.blockers.some(item => item.code === 'broad_bind_source'));
});

test('相同清单指纹稳定，源镜像变化后指纹改变', () => {
  const first = buildFullBackupPlan(input());
  assert.equal(first.fingerprint, buildFullBackupPlan(input()).fingerprint);
  const next = structuredClone(container);
  next.Image = 'sha256:updated';
  assert.notEqual(first.fingerprint, buildFullBackupPlan(input({ containers: [next] })).fingerprint);
});
