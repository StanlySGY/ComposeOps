import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useToastStore } from '../src/stores/toast.js';

let store;
beforeEach(() => { vi.useFakeTimers(); setActivePinia(createPinia()); store = useToastStore(); });
afterEach(() => { store.clear(); vi.useRealTimers(); });

describe('提示消息的可见时间', () => {
  it('排队消息真正出现后才开始完整计时', () => {
    const ids = Array.from({ length: 6 }, (_, i) => store.info(`消息 ${i}`, 1000));
    expect(store.visible.map(item => item.id)).toEqual(ids.slice(0, 3));
    expect(vi.getTimerCount()).toBe(3);
    vi.advanceTimersByTime(1000);
    expect(store.visible.map(item => item.id)).toEqual(ids.slice(3));
    vi.advanceTimersByTime(999);
    expect(store.visible).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(store.items).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('悬停暂停后按剩余时间恢复，重复暂停不会扣除两遍', () => {
    const id = store.success('保存成功', 3500);
    vi.advanceTimersByTime(1500);
    store.pause(id);
    vi.advanceTimersByTime(10000);
    store.pause(id);
    expect(store.visible[0].remaining).toBe(2000);
    store.resume(id);
    store.resume(id);
    vi.advanceTimersByTime(1999);
    expect(store.visible).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.visible).toHaveLength(0);
  });

  it('鼠标移走时键盘焦点仍然暂停计时', () => {
    const id = store.info('说明', 1000);
    store.pause(id, 'hover'); store.pause(id, 'focus');
    store.resume(id, 'hover');
    vi.advanceTimersByTime(5000);
    expect(store.visible[0].paused).toBe(true);
    store.resume(id, 'focus');
    vi.advanceTimersByTime(1000);
    expect(store.items).toHaveLength(0);
  });

  it('后台标签页保留当前和新消息，回到页面不会解除仍在悬停的暂停', () => {
    const id = store.info('原有消息', 1000);
    vi.advanceTimersByTime(400);
    store.setHidden(true);
    store.info('后台收到的消息', 1000);
    vi.advanceTimersByTime(10000);
    store.pause(id);
    store.setHidden(false);
    vi.advanceTimersByTime(1000);
    expect(store.items.map(item => item.id)).toEqual([id]);
    store.resume(id);
    vi.advanceTimersByTime(599);
    expect(store.items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.items).toHaveLength(0);
  });

  it('手动关闭暂停中的消息立即让下一条显示，过期回调不会复活', () => {
    const ids = Array.from({ length: 4 }, () => store.info('消息', 1000));
    store.pause(ids[0]);
    vi.advanceTimersByTime(500);
    store.dismiss(ids[0]);
    store.resume(ids[0]);
    vi.advanceTimersByTime(500);
    expect(store.visible.map(item => item.id)).toEqual([ids[3]]);
    vi.advanceTimersByTime(500);
    expect(store.items).toHaveLength(0);
  });

  it('错误默认留出更长阅读时间，零时长消息只允许手动关闭', () => {
    store.success('成功'); store.error('较长的错误说明');
    const permanent = store.info('持续消息', 0);
    vi.advanceTimersByTime(3500);
    expect(store.visible.map(item => item.type)).toEqual(['error', 'info']);
    vi.advanceTimersByTime(2500);
    expect(store.visible.map(item => item.id)).toEqual([permanent]);
    store.dismiss(permanent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('突发消息队列有上限，但不会挤走用户正在阅读的可见消息', () => {
    const id = store.info('正在阅读'); store.pause(id);
    for (let i = 0; i < 100; i++) store.info(`消息 ${i}`);
    expect(store.items).toHaveLength(50);
    expect(store.visible[0].id).toBe(id);
    store.clear();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('切换窄屏保留焦点消息，其余消息重新显示时保留剩余阅读时间', () => {
    const first = store.info('第一条', 1000);
    const focused = store.info('焦点消息', 1000);
    store.info('第三条', 1000);
    vi.advanceTimersByTime(400);
    store.pause(focused, 'focus');
    store.setVisibleLimit(1);
    expect(store.visible.map(item => item.id)).toEqual([focused]);
    expect(store.queuedCount).toBe(2);
    vi.advanceTimersByTime(2000);
    store.dismiss(focused);
    expect(store.visible[0].id).toBe(first);
    expect(store.visible[0].displayDuration).toBe(600);
    store.setVisibleLimit(3);
    expect(store.visible).toHaveLength(2);
    vi.advanceTimersByTime(599);
    expect(store.items).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(store.items).toHaveLength(0);
  });
});
