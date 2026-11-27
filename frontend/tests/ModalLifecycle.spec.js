import { afterEach, expect, it, vi } from 'vitest';
import { h, KeepAlive, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import BaseModal from '../src/components/common/BaseModal.vue';
import { useEscapeKey } from '../src/composables/useEscapeKey.js';
let wrapper;
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; document.body.style.overflow = ''; });
async function router() { const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }, { path: '/other', component: { template: '<div/>' } }] }); await router.push('/'); await router.isReady(); return router; }
it('缓存中的弹窗失活时隐藏 Teleport 并释放滚动锁，恢复后仍有草稿', async () => {
  const active = ref(true), value = ref('draft');
  const Draft = ({ setup: () => () => h(BaseModal, { show: true, closeDisabled: true }, { default: () => h('input', { value: value.value, onInput: event => { value.value = event.target.value; } }) }) });
  const Other = ({ setup: () => () => h('p', 'other') });
  wrapper = mount({ setup: () => () => h(KeepAlive, null, { default: () => h(active.value ? Draft : Other) }) }, { attachTo: document.body, global: { plugins: [await router()] } });
  await flushPromises(); expect(document.querySelector('[role=dialog]')).not.toBeNull(); expect(document.body.style.overflow).toBe('hidden');
  const input = document.querySelector('[role=dialog] input'); input.value = 'kept'; input.dispatchEvent(new Event('input', { bubbles: true }));
  active.value = false; await flushPromises();
  expect(document.querySelector('[role=dialog]')).toBeNull(); expect(document.body.style.overflow).toBe('');
  active.value = true; await flushPromises();
  expect(document.querySelector('[role=dialog] input').value).toBe('kept'); expect(document.body.style.overflow).toBe('hidden');
});
it('enabled 条件改变时同步更新 Esc 与滚动锁，并恢复已有 overflow', async () => {
  const enabled = ref(false), active = ref(true), close = vi.fn();
  document.body.style.overflow = 'clip';
  wrapper = mount({ setup() { useEscapeKey({ active, enabled, onClose: close, lockBody: true }); return () => null; } }, { global: { plugins: [await router()] } });
  enabled.value = true; await nextTick(); expect(document.body.style.overflow).toBe('hidden');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(close).toHaveBeenCalledTimes(1);
  enabled.value = false; await nextTick(); expect(document.body.style.overflow).toBe('clip');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(close).toHaveBeenCalledTimes(1);
});
it('缓存后台的层不响应 Esc 或路由切换，回到页面后恢复', async () => {
  const isPage = ref(true), active = ref(true), close = vi.fn(), routes = await router();
  const Draft = ({ setup() { useEscapeKey({ active, onClose: close, lockBody: true }); return () => h('p', 'draft'); } });
  const Other = ({ setup: () => () => h('p', 'other') });
  wrapper = mount({ setup: () => () => h(KeepAlive, null, { default: () => h(isPage.value ? Draft : Other) }) }, { global: { plugins: [routes] } });
  await flushPromises(); isPage.value = false; await flushPromises();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await routes.push('/other');
  expect(close).not.toHaveBeenCalled(); expect(document.body.style.overflow).toBe('');
  isPage.value = true; await flushPromises(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(close).toHaveBeenCalledTimes(1);
});
