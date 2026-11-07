import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import ToastContainer from '../src/components/common/ToastContainer.vue';
import { useToastStore } from '../src/stores/toast.js';

let wrapper, store, launcher;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: query === '(hover: hover)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const pinia = createPinia(); setActivePinia(pinia); store = useToastStore();
  launcher = document.createElement('button'); document.body.append(launcher); launcher.focus();
  wrapper = mount(ToastContainer, { attachTo: document.body, global: { plugins: [pinia] } });
});
afterEach(() => { wrapper.unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('进度条随悬停和焦点暂停，移开鼠标不会让焦点中的消息消失', async () => {
  store.info('可读消息', 1000); await nextTick();
  const card = wrapper.find('.toast-card');
  const bar = card.find('.toast-progress');
  expect(bar.element.style.animationPlayState).toBe('running');
  await card.trigger('mouseenter');
  expect(bar.element.style.animationPlayState).toBe('paused');
  card.find('button').element.focus();
  await card.trigger('mouseleave');
  vi.advanceTimersByTime(2000); await nextTick();
  expect(wrapper.find('.toast-card').exists()).toBe(true);
  launcher.focus(); await nextTick();
  expect(bar.element.style.animationPlayState).toBe('running');
  vi.advanceTimersByTime(1000); await nextTick();
  expect(wrapper.find('.toast-card').exists()).toBe(false);
});

it('切换标签页暂停动画和计时，组件卸载清理计时器', async () => {
  store.error('错误说明'); await nextTick();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange')); await nextTick();
  expect(wrapper.find('.toast-progress').element.style.animationPlayState).toBe('paused');
  vi.advanceTimersByTime(20000);
  expect(store.visible).toHaveLength(1);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange')); await nextTick();
  expect(wrapper.find('.toast-progress').element.style.animationPlayState).toBe('running');
  wrapper.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('键盘关闭后焦点移到下一条，全部关闭后回到原操作入口', async () => {
  store.info('第一条'); store.info('第二条'); await nextTick();
  const first = wrapper.findAll('button')[0]; first.element.focus(); await first.trigger('click');
  expect(document.activeElement).toBe(wrapper.find('button').element);
  await wrapper.find('button').trigger('click');
  expect(document.activeElement).toBe(launcher);
});

it('触摸按住提示时暂停，取消手势会释放暂停', async () => {
  store.info('触摸阅读', 1000); await nextTick();
  await wrapper.find('.toast-card').trigger('pointerdown');
  vi.advanceTimersByTime(2000);
  expect(store.visible).toHaveLength(1);
  await wrapper.find('.toast-card').trigger('pointercancel');
  vi.advanceTimersByTime(1000); await nextTick();
  expect(store.visible).toHaveLength(0);
});

it('触屏合成悬停不会永久保留提示或挡住下一步操作', async () => {
  window.matchMedia.mockReturnValue({ matches: false });
  store.success('已解决', 1000); await nextTick();
  await wrapper.find('.toast-card').trigger('mouseenter');
  vi.advanceTimersByTime(1000); await nextTick();
  expect(store.visible).toHaveLength(0);
});
