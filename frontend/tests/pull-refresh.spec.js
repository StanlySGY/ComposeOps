/* eslint-disable vue/one-component-per-file -- 测试夹具需要临时探针组件与两个路由页。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { PULL_REFRESH_EVENT, usePullRefresh } from '../src/composables/usePullRefresh.js';

const PullRefreshProbe = defineComponent({
  name: 'PullRefreshProbe',
  props: { handler: { type: Function, required: true }, enabled: { default: null }, keepAlive: { type: Boolean, default: false } },
  setup(props) {
    usePullRefresh(props.handler, { enabled: props.enabled, keepAlive: props.keepAlive });
    return () => h('div', 'probe');
  },
});

function pull() {
  window.dispatchEvent(new CustomEvent(PULL_REFRESH_EVENT));
}

describe('下拉刷新订阅器 usePullRefresh', () => {
  let wrapper;
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('挂载后响应下拉刷新,卸载后不再响应(无监听泄漏)', async () => {
    const handler = vi.fn();
    wrapper = mount(PullRefreshProbe, { props: { handler } });
    pull();
    expect(handler).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    wrapper = null;
    pull();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('enabled 为假时不触发', async () => {
    const handler = vi.fn();
    const enabled = ref(false);
    wrapper = mount(PullRefreshProbe, { props: { handler, enabled } });
    pull();
    expect(handler).toHaveBeenCalledTimes(0);
    enabled.value = true;
    pull();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('loader 抛错或 reject 不影响后续下拉', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    wrapper = mount(PullRefreshProbe, { props: { handler } });
    pull();
    await flushPromises();
    pull();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('keep-alive 页面切走时摘掉监听,切回后恢复', async () => {
    const handler = vi.fn();
    const PageA = defineComponent({ name: 'PullRefreshKeepAlivePage', setup: () => (usePullRefresh(handler, { keepAlive: true }), () => h('div', 'a')) });
    const PageB = defineComponent({ name: 'OtherPage', setup: () => () => h('div', 'b') });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/a', component: PageA }, { path: '/b', component: PageB }],
    });
    await router.push('/a');
    const Shell = defineComponent({
      setup: () => () => h('div', [h(KeepAlive, null, [h(RouterView)])]),
    });
    wrapper = mount(Shell, { global: { plugins: [router] } });
    await nextTick();
    pull();
    expect(handler).toHaveBeenCalledTimes(1);

    await router.push('/b');
    await nextTick();
    pull();
    expect(handler).toHaveBeenCalledTimes(1);

    await router.push('/a');
    await nextTick();
    pull();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
