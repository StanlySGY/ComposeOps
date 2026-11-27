import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import db, { getProjectPreference, getProjectMountEnabled, setProjectPreference, exportUserData, importUserData } from '../src/lib/db.js';
import { listProjectGroups, saveProjectGroup, deleteProjectGroup, assignProjectGroups, projectGroupMetadata, applyProjectManagement } from '../src/services/project-groups.js';
import projectRoutes from '../src/routes/projects.js';
import { scanProjects, invalidateScanCache } from '../src/services/scanner.js';
import { getDockerForHost, upsertHost, setActiveHost, deleteHost } from '../src/services/docker-hosts.js';

test('分组创建幂等、重命名冲突、置顶，删组保留项目权限与备注', () => {
  const group = saveProjectGroup({ name: ' 我的业务 ' });
  assert.equal(saveProjectGroup({ name: '我的业务' }).id, group.id);
  const other = saveProjectGroup({ name: '公共服务' });
  assert.throws(() => saveProjectGroup({ id: group.id, name: '公共服务' }), /同名/);
  assert.throws(() => saveProjectGroup({ name: 'bad\u0000name' }), /可见/);
  saveProjectGroup({ id: group.id, name: '研发组', pinned: true });
  assert.equal(listProjectGroups()[0].id, group.id);
  const projects = [{ id: 'group-project', hostId: 'local' }];
  setProjectPreference(projects[0].id, { managed: true, mountEnabled: true, favorite: true, note: '保留' });
  assignProjectGroups(projects, [{ projectId: projects[0].id, groupId: group.id }]);
  assert.equal(projectGroupMetadata(projects[0].id).groupName, '研发组');
  deleteProjectGroup(group.id);
  assert.equal(projectGroupMetadata(projects[0].id).groupId, null);
  assert.equal(getProjectPreference(projects[0].id).managed, 1);
  assert.equal(getProjectMountEnabled(projects[0].id), true);
  assert.equal(getProjectPreference(projects[0].id).note, '保留');
  deleteProjectGroup(other.id);
});

test('归组验证全批次后提交，纳管保存只影响当前节点且失败原子回滚', () => {
  const a = [{ id: 'a:project', hostId: 'a' }], b = [{ id: 'b:project', hostId: 'b' }];
  const group = saveProjectGroup({ name: '跨节点业务' });
  applyProjectManagement(a, 'a', ['a:project'], ['a:project'], [{ projectId: 'a:project', groupId: group.id }]);
  applyProjectManagement(b, 'b', ['b:project'], []);
  assert.equal(getProjectPreference('a:project').managed, 1);
  assert.throws(() => applyProjectManagement(a, 'a', [], [], [{ projectId: 'a:project', groupId: 'gone' }]), /不存在/);
  assert.equal(getProjectPreference('a:project').managed, 1);
  assert.throws(() => assignProjectGroups(a, [{ projectId: 'a:project', groupId: null }, { projectId: 'b:project', groupId: null }]), /未发现/);
  assert.equal(projectGroupMetadata('a:project').groupId, group.id);
  applyProjectManagement(a, 'a', [], []);
  assert.equal(getProjectPreference('a:project').managed, 0);
  assert.equal(getProjectPreference('b:project').managed, 1);
  assert.equal(projectGroupMetadata('a:project').groupId, group.id);
  applyProjectManagement(a, 'a', ['a:project'], []);
  applyProjectManagement([], 'a', [], []);
  assert.equal(getProjectPreference('a:project').managed, 0, '暂时消失的已绑定项目也撤销权限');
  deleteProjectGroup(group.id);
});

test('路由跨节点同名项目隔离、纳管与分组一并保存，旧标签不覆盖手动分组', async t => {
  const remote = upsertHost({ name: '分组远端', type: 'tcp', host: '127.0.0.1', port: 1 });
  t.after(() => { setActiveHost('local'); deleteHost(remote.id); invalidateScanCache(); });
  const row = { Id: 'group-container', Names: ['/web'], State: 'running', Status: 'Up', Labels: { 'com.docker.compose.project': 'same', 'com.docker.compose.project.working_dir': '/srv/same', 'myops.owner': '旧标签' } };
  for (const id of ['local', remote.id]) t.mock.method(getDockerForHost(id), 'listContainers', async () => [row]);
  invalidateScanCache();
  const [a] = await scanProjects('local'), [b] = await scanProjects(remote.id);
  assert.notEqual(a.id, b.id);
  const app = Fastify(); await app.register(projectRoutes, { prefix: '/projects' }); t.after(() => app.close());
  const group = (await app.inject({ method: 'POST', url: '/projects/groups', payload: { name: 'API 测试组' } })).json();
  const foreign = await app.inject({ method: 'PUT', url: '/projects/group-assignments', payload: { expectedHostId: 'local', assignments: [{ projectId: b.id, groupId: group.id }] } });
  assert.equal(foreign.statusCode, 400);
  const stale = await app.inject({ method: 'PUT', url: '/projects/management', payload: { expectedHostId: remote.id, projectIds: [a.id], assignments: [] } });
  assert.equal(stale.statusCode, 409);
  const result = await app.inject({ method: 'PUT', url: '/projects/management', payload: { expectedHostId: 'local', projectIds: [a.id], mountProjectIds: [], assignments: [{ projectId: a.id, groupId: group.id }] } });
  assert.equal(result.statusCode, 200, result.body);
  const [updated] = await scanProjects('local');
  assert.equal(updated.owner, '旧标签'); assert.equal(updated.groupName, 'API 测试组'); assert.equal(updated.managed, true);
  setActiveHost(remote.id);
  const remoteSave = await app.inject({ method: 'PUT', url: '/projects/management', payload: { expectedHostId: remote.id, projectIds: [b.id] } });
  assert.equal(remoteSave.statusCode, 200);
  assert.equal(getProjectPreference(a.id).managed, 1);
  assert.equal(projectGroupMetadata(b.id).groupId, null);
  const plan = (await app.inject({ method: 'GET', url: '/projects/mount-plan' })).json();
  assert.equal(plan.projects[0].hostId, remote.id);
  await app.inject({ method: 'DELETE', url: `/projects/groups/${group.id}` });
  assert.equal(getProjectPreference(a.id).managed, 1);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});


test('数据导出导入保留分组，按名称合并且保持项目权限与节点归属', () => {
  const group = saveProjectGroup({ name: '导出分组', pinned: true });
  const projects = [{ id: 'export-project', hostId: 'export-host' }];
  setProjectPreference('export-project', { managed: true, mountEnabled: false, note: '导出备注' });
  assignProjectGroups(projects, [{ projectId: 'export-project', groupId: group.id }]);
  const data = exportUserData();
  deleteProjectGroup(group.id);
  const merged = saveProjectGroup({ name: '导出分组', pinned: true });
  importUserData(data);
  assert.equal(projectGroupMetadata('export-project').groupId, merged.id);
  assert.equal(listProjectGroups().filter(g => g.name === '导出分组').length, 1);
  assert.equal(getProjectPreference('export-project').managed, 1);
  assert.equal(getProjectMountEnabled('export-project'), false);
  assert.equal(db.prepare('SELECT host_id FROM project_preferences WHERE project_id=?').get('export-project').host_id, 'export-host');
  assert.equal(getProjectPreference('export-project').note, '导出备注');
  deleteProjectGroup(merged.id);
});

test('纳管更新中途 SQL 失败时回滚权限与分组，而非只依赖预验证', () => {
  const projects = [{ id: 'rollback-project', hostId: 'rollback-host' }];
  const group = saveProjectGroup({ name: '回滚分组' });
  applyProjectManagement(projects, 'rollback-host', ['rollback-project'], ['rollback-project'], [{ projectId: 'rollback-project', groupId: group.id }]);
  db.exec("CREATE TEMP TRIGGER reject_group_update BEFORE UPDATE OF group_id ON project_preferences WHEN NEW.project_id='rollback-project' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  try {
    assert.throws(() => applyProjectManagement(projects, 'rollback-host', [], [], [{ projectId: 'rollback-project', groupId: null }]), /injected failure/);
    assert.equal(getProjectPreference('rollback-project').managed, 1);
    assert.equal(getProjectMountEnabled('rollback-project'), true);
    assert.equal(projectGroupMetadata('rollback-project').groupId, group.id);
  } finally { db.exec('DROP TRIGGER reject_group_update'); deleteProjectGroup(group.id); }
});


test('分组读写沿用会话鉴权与 Origin 校验，无认证及跨站请求不能变更', async t => {
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp({ logger: false }); t.after(() => app.close());
  const routes = [['GET', '/groups'], ['POST', '/groups'], ['PATCH', '/groups/none'], ['DELETE', '/groups/none'], ['PUT', '/group-assignments']];
  for (const [method, route] of routes) assert.equal((await app.inject({ method, url: '/api/v1/projects' + route })).statusCode, 401);
  const headers = { host: 'localhost:3001', origin: 'http://localhost:3001' };
  const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers, payload: { password: 'group-auth-test-password' } });
  assert.equal(setup.statusCode, 200);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const foreign = await app.inject({ method: 'POST', url: '/api/v1/projects/groups', headers: { ...headers, cookie, origin: 'https://evil.invalid' }, payload: { name: '禁止创建' } });
  assert.equal(foreign.statusCode, 403);
  const valid = await app.inject({ method: 'POST', url: '/api/v1/projects/groups', headers: { ...headers, cookie }, payload: { name: '授权分组' } });
  assert.equal(valid.statusCode, 200);
  deleteProjectGroup(valid.json().id);
});
