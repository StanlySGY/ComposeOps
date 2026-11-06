import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { fallbackTarget, historyTarget, PAGE_DETAILS } from '../src/lib/navigation.js';

const router = createRouter({ history: createMemoryHistory(), routes: Object.keys(PAGE_DETAILS).map(name => ({ name, path: name === 'agent-history' ? '/agent/history' : '/' + name, component: {} })) });

describe('工作台返回路径', () => {
  it('保留真实历史的完整查询，不以列表首页覆盖原上下文', () => {
    const target = historyTarget(router, '/settings?tab=mounts&projectId=p', router.resolve('/compose?projectId=p'));
    expect(target.query).toEqual({ tab: 'mounts', projectId: 'p' });
  });
  it.each(['https://example.com', '//example.com', '/\\example.com', '/unknown', null])('忽略不可信或不存在的历史目标 %s', value => {
    expect(historyTarget(router, value, router.resolve('/services'))).toBeNull();
  });
  it('当前页面不作为自己的历史目标', () => {
    expect(historyTarget(router, '/services', router.resolve('/services'))).toBeNull();
  });
  it('直接进入配置或终端时回到所属项目，历史页回到 Agent', () => {
    expect(fallbackTarget(router, router.resolve('/compose?projectId=p')).fullPath).toBe('/services?focus=p');
    expect(fallbackTarget(router, router.resolve('/shell?projectId=p')).fullPath).toBe('/services?focus=p');
    expect(fallbackTarget(router, router.resolve('/agent/history')).name).toBe('agent');
  });
  it('日志直达遵守明确来源，拒绝任意 from 跳转', () => {
    expect(fallbackTarget(router, router.resolve('/logs?from=topology')).name).toBe('topology');
    expect(fallbackTarget(router, router.resolve('/logs?projectId=p&from=dashboard')).name).toBe('dashboard');
    expect(fallbackTarget(router, router.resolve('/logs?from=https://example.com')).name).toBe('services');
    expect(fallbackTarget(router, router.resolve('/dashboard'))).toBeNull();
  });
});
