import { describe, expect, it } from 'vitest';
import { deepLink, returnTarget, eventDestination, eventContainerLink } from '../src/lib/deep-links.js';
describe('资源深链与返回约定', () => {
  it('编码资源 ID 并保留来源，忽略未知返回目标', () => {
    const query = new URLSearchParams(deepLink('/logs', { projectId: 'a&b', containerId: 'a/b', from: 'events' }).split('?')[1]);
    expect(query.get('projectId')).toBe('a&b');
    expect(query.get('containerId')).toBe('a/b');
    expect(returnTarget(query.get('from'))).toEqual({ label: '返回事件中心', path: '/events' });
    expect(deepLink('/logs', { from: '//evil.test' })).toBe('/logs');
  });
  it('事件链接保持节点和容器，拒绝外部或脚本导航', () => {
    const event = { payload: { to: deepLink('/logs', { hostId: 'remote', projectId: 'p1', containerId: 'c1' }) } };
    expect(eventContainerLink(event, '/monitor')).toContain('hostId=remote');
    expect(eventContainerLink(event, '/monitor')).toContain('containerId=c1');
    for (const to of ['//evil.test', '/\\evil.test', 'javascript:alert(1)', 'https://evil.test']) expect(eventDestination({ target: to })).toBe('');
  });
});
