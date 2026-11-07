import { describe, expect, it } from 'vitest';
import { projectReturnLocation, projectToolLocation } from '../src/lib/project-navigation.js';
const project = { id: 'p', containers: [{ id: 'one' }] };
describe('项目工具间的上下文', () => {
  it('配置也携带容器身份，返回列表保留查询和排序', () => {
    const location = projectToolLocation('compose', project, 'one', { from: 'dashboard', returnTo: '/services?q=redis&filter=managed&sort=name' });
    expect(location.query).toEqual({ projectId: 'p', containerId: 'one', from: 'dashboard', returnTo: '/services?q=redis&filter=managed&sort=name' });
    expect(projectReturnLocation(location.query.returnTo, 'p')).toEqual({ path: '/services', query: { q: 'redis', filter: 'managed', sort: 'name', focus: 'p' } });
  });
  it.each(['https://example.com', '//example.com', '/services-evil?q=x', '/settings?tab=mounts', '/services#evil', null])('返回入口不能跳转到任意地址 %s', value => {
    expect(projectReturnLocation(value, 'p')).toEqual({ path: '/services', query: { focus: 'p' } });
  });
  it('不会携带上一个项目的容器或可触发任务/弹窗的参数', () => {
    expect(projectToolLocation('logs', project, 'foreign', { from: 'evil' }).query).toEqual({ projectId: 'p', from: 'services' });
    expect(projectReturnLocation('/services?env=other&job=old&focus=old', 'p').query).toEqual({ focus: 'p' });
  });
});
