import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useServiceFilters } from '../src/composables/useServiceFilters.js';

let wrapper;
afterEach(() => wrapper?.unmount());
async function start(url = '/services') {
  const router = createRouter({ history: createMemoryHistory(), routes: ['services', 'logs', 'dashboard'].map(name => ({ name, path: '/' + name, component: { template: '<div />' } })) });
  await router.push(url);
  await router.isReady();
  let filters;
  wrapper = mount({ setup() { filters = useServiceFilters(); return {}; }, template: '<div />' }, { global: { plugins: [router] } });
  return { router, filters };
}

describe('服务筛选地址与导航', () => {
  it('从链接加载筛选，快速修改不同字段不会丢失其他条件', async () => {
    const { router, filters } = await start('/services?filter=managed&q=redis&sort=name&job=123');
    expect(filters.searchQuery.value).toBe('redis');
    filters.searchQuery.value = 'postgres';
    filters.filter.value = 'attention';
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ filter: 'attention', q: 'postgres', sort: 'name', job: '123' });
    filters.resetFilters();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ job: '123' });
  });
  it('离开后不读写其他页面参数，后退与前进恢复完整视图', async () => {
    const { router, filters } = await start('/dashboard');
    await router.push('/services?filter=favorites&q=wiki&sort=owner');
    await router.push('/logs?q=error');
    filters.searchQuery.value = 'must-not-write';
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/logs?q=error');
    expect(filters.searchQuery.value).toBe('wiki');
    router.back();
    await flushPromises();
    expect(filters.filter.value).toBe('favorites');
    expect(filters.sort.value).toBe('owner');
    router.forward();
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/logs?q=error');
  });
  it('定位项目不抹掉原筛选，用户重新筛选时取消项目定位', async () => {
    const { router, filters } = await start('/services?focus=cache&filter=attention&q=wiki');
    expect(filters.filter.value).toBe('attention');
    expect(filters.searchQuery.value).toBe('wiki');
    filters.filter.value = 'favorites';
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ filter: 'favorites', q: 'wiki' });
  });
  it('无效或重复参数安全回退，纯服务入口恢复全部项目', async () => {
    const { router, filters } = await start('/services?filter=toString&sort=__proto__&q=a&q=b');
    expect(filters.filter.value).toBe('all');
    expect(filters.sort.value).toBe('priority');
    expect(filters.searchQuery.value).toBe('');
    filters.filter.value = 'attention';
    await flushPromises();
    await router.push('/logs');
    await router.push('/services');
    expect(filters.filter.value).toBe('all');
  });
});
