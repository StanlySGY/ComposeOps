/* eslint-disable vue/one-component-per-file -- The test mounts a cached child inside its host. */
import { afterEach, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useSelectedTabReveal } from '../src/composables/useSelectedTabReveal.js';
let wrapper;
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });
it('初始深链、切换和重新激活只移动分类条；失活停止观察', async () => {
  const callbacks = [];
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(callback) { callbacks.push(callback); } observe() {} disconnect() { disconnect(); } });
  const selected = ref('hosts'); const visible = ref(true);
  const Panel = defineComponent({ setup() {
    const navigation = ref(null); useSelectedTabReveal(navigation, selected);
    return () => h('nav', { ref: navigation }, [h('button', { 'aria-pressed': true }, selected.value)]);
  } });
  wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, {}, () => visible.value ? h(Panel) : null) }));
  const nav = wrapper.get('nav').element;
  nav.getBoundingClientRect = () => ({ left: 0, right: 390 });
  const item = wrapper.get('button').element;
  item.getBoundingClientRect = () => ({ left: 562 - nav.scrollLeft, right: 690 - nav.scrollLeft });
  callbacks[0](); await nextTick();
  expect(nav.scrollLeft).toBe(306);
  item.getBoundingClientRect = () => ({ left: -90, right: 20 });
  selected.value = 'ai'; await nextTick(); await nextTick();
  expect(nav.scrollLeft).toBe(210);
  visible.value = false; await nextTick();
  expect(disconnect).toHaveBeenCalled();
  callbacks[0](); await nextTick();
  expect(nav.scrollLeft).toBe(210);
  item.getBoundingClientRect = () => ({ left: 0, right: 100 });
  visible.value = true; await nextTick(); await nextTick();
  expect(callbacks).toHaveLength(2);
});
