import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveImplicitContextFromProjects } from '../src/services/agent/planning.js';

const projects = [
  { id: 'project-alpha', projectName: 'Alpha Stack', containers: [
    { id: 'alpha-api-1', name: 'alpha-api-1', service: 'api' },
    { id: 'alpha-api-2', name: 'alpha-api-2', service: 'api' },
    { id: 'alpha-db-1', name: 'alpha-db-1', service: 'database' },
  ] },
  { id: 'project-beta', projectName: 'Beta Stack', containers: [
    { id: 'beta-redis-1', name: 'beta-redis-1', service: 'redis' },
  ] },
];

test('page context auto-binds the one expanded project and service group', () => {
  const result = resolveImplicitContextFromProjects('帮我检查这个服务', {
    projectId: 'project-alpha', projectName: 'Alpha Stack', serviceName: 'api', state: 'api alpha-api-1 alpha-api-2 database',
  }, '', projects);
  assert.equal(result.projectId, 'project-alpha');
  assert.equal(result.serviceName, 'api');
  assert.equal(result.container, null);
  assert.equal(result.confidence, 'service');
});

test('explicit user project overrides a different currently expanded page project', () => {
  const result = resolveImplicitContextFromProjects('检查 Beta Stack 的 redis 服务', {
    projectId: 'project-alpha', projectName: 'Alpha Stack', serviceName: 'api', state: 'Alpha Stack api alpha-api-1',
  }, '', projects);
  assert.equal(result.projectId, 'project-beta');
  assert.equal(result.serviceName, 'redis');
  assert.equal(result.container.id, 'beta-redis-1');
});

test('page container identity is resolved only inside its verified project', () => {
  const result = resolveImplicitContextFromProjects('查看当前容器日志', {
    projectId: 'project-alpha', projectName: 'Alpha Stack', containerId: 'alpha-db-1',
  }, '', projects);
  assert.equal(result.container.id, 'alpha-db-1');
  assert.equal(result.serviceName, 'database');
  assert.equal(result.confidence, 'container');
});

test('explicit projectId wins over page inference and unresolved matches remain unbound', () => {
  const explicit = resolveImplicitContextFromProjects('查看当前服务', {
    projectId: 'project-alpha', projectName: 'Alpha Stack', serviceName: 'api',
  }, 'project-beta', projects);
  assert.equal(explicit.projectId, 'project-beta');
  const unresolved = resolveImplicitContextFromProjects('随便看看', {}, '', projects);
  assert.equal(unresolved.projectId, null);
  assert.equal(unresolved.confidence, 'none');
});

test('short service mentions and bystanders remain ambiguous instead of binding worker', () => {
  const rows = [{ id: 'one', projectName: 'one', containers: [{ id: 'a', name: 'fixture-api', service: 'api' }, { id: 'w', name: 'fixture-worker', service: 'worker' }] }];
  const result = resolveImplicitContextFromProjects('重启 api，保持 worker 不动', {}, 'one', rows);
  assert.equal(result.container, null);
  assert.equal(resolveImplicitContextFromProjects('查看 api 日志', {}, 'one', rows).container.id, 'a');
  assert.equal(resolveImplicitContextFromProjects('capital worker', {}, 'one', rows).container.id, 'w');
});
