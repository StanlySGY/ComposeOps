import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getActivityDocker } from '../src/services/docker-hosts.js';
import { verifyImageUpgradeHealth } from '../src/services/image-upgrade-health.js';

const project = { projectName: 'same-name', workingDir: '/srv/owned' };
const item = (service, extra = {}) => ({ Id: service, Labels: {
  'com.docker.compose.project': project.projectName,
  'com.docker.compose.project.working_dir': project.workingDir,
  'com.docker.compose.service': service, ...extra,
} });
function fixture(t, items) {
  const docker = getActivityDocker();
  t.mock.method(docker, 'listContainers', async () => items);
  t.mock.method(docker, 'getContainer', () => ({ inspect: async () => ({ State: { Status: 'running', Health: { Status: 'healthy' } } }) }));
  const timer = setInterval(() => {}, 1000); t.after(() => clearInterval(timer));
  return docker;
}
const options = { timeoutMs: 60, pollMs: 5 };
test('所有选中服务均存在且健康，才通过容器验收', async t => {
  fixture(t, [item('web'), item('api')]);
  const result = await verifyImageUpgradeHealth(project, ['web', 'api'], options);
  assert.equal(result.ok, true); assert.equal(result.services.length, 2);
});
for (const [label, extra] of [
  ['缺失服务', null], ['同名其它目录', { 'com.docker.compose.project.working_dir': '/srv/other' }],
  ['一次性任务', { 'com.docker.compose.oneoff': 'True' }], ['执行器', { 'composeops.helper': 'true' }],
]) test(`${label}不能替代所选服务通过验收`, async t => {
  fixture(t, [item('web'), ...(extra ? [item('api', extra)] : [])]);
  const result = await verifyImageUpgradeHealth(project, ['web', 'api'], options);
  assert.equal(result.ok, false);
  assert.equal(result.services.find(s => s.service === 'api').found, 0);
});
test('升级前两个副本只剩一个，不能报告健康', async t => {
  fixture(t, [item('web')]);
  const result = await verifyImageUpgradeHealth(project, ['web'], { ...options, expectedCounts: { web: 2 } });
  assert.equal(result.ok, false); assert.equal(result.services[0].expected, 2);
});
test('健康仍在 starting 的容器不算通过，后续 healthy 可通过', async t => {
  const docker = fixture(t, [item('web')]); let calls = 0;
  docker.getContainer.mock.mockImplementation(() => ({ inspect: async () => ({ State: { Status: 'running', Health: { Status: ++calls === 1 ? 'starting' : 'healthy' } } }) }));
  assert.equal((await verifyImageUpgradeHealth(project, ['web'], options)).ok, true);
  assert.equal(calls, 3);
});
test('瞬时 running 后崩溃不能通过连续健康检查', async t => {
  const docker = fixture(t, [item('web')]); let calls = 0;
  docker.getContainer.mock.mockImplementation(() => ({ inspect: async () => ({ State: { Status: ++calls === 1 ? 'running' : 'exited' } }) }));
  assert.equal((await verifyImageUpgradeHealth(project, ['web'], options)).ok, false);
});
for (const stage of ['list', 'inspect']) test(`Docker ${stage} 无响应也遵守健康验收期限`, async t => {
  const docker = fixture(t, [item('web')]); let signal;
  const hang = options => { signal = options.abortSignal; return new Promise(() => {}); };
  if (stage === 'list') docker.listContainers.mock.mockImplementation(hang);
  else docker.getContainer.mock.mockImplementation(() => ({ inspect: hang }));
  const result = await verifyImageUpgradeHealth(project, ['web'], options);
  assert.equal(result.ok, false); assert.equal(signal.aborted, true); assert.match(result.message, /超时/);
});
test('验收被调用方取消仍抛出取消，不降级为普通不健康', async t => {
  const docker = fixture(t, []), controller = new AbortController();
  docker.listContainers.mock.mockImplementation(async () => { controller.abort(); return []; });
  await assert.rejects(verifyImageUpgradeHealth(project, ['web'], { ...options, signal: controller.signal }), { name: 'AbortError' });
});
