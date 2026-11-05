import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
const { getAuthStatus } = vi.hoisted(() => ({ getAuthStatus: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api: { getAuthStatus } }));
import { useAuthStore } from '../src/stores/auth.js';

describe('认证初始化连接恢复', () => {
  beforeEach(() => { setActivePinia(createPinia()); getAuthStatus.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('网络失败被处理为连接错误，重试后恢复真实会话', async () => {
    const store = useAuthStore();
    getAuthStatus.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(store.check()).resolves.toBeUndefined();
    expect(store.ready).toBe(true);
    expect(store.connectionError).toContain('无法连接服务器');
    expect(store.checking).toBe(false);
    getAuthStatus.mockResolvedValueOnce({ authenticated: true, setupRequired: false });
    await store.check();
    expect(store.connectionError).toBe('');
    expect(store.authenticated).toBe(true);
  });

  it('返回 HTML 等无效认证响应时不误显示登录表单', async () => {
    getAuthStatus.mockResolvedValue('<html>upstream unavailable</html>');
    const store = useAuthStore();
    await store.check();
    expect(store.connectionError).toContain('无法连接');
  });

  it('重试按钮连点只发起一个请求', async () => {
    let resolve;
    getAuthStatus.mockImplementation(() => new Promise(done => { resolve = done; }));
    const store = useAuthStore();
    const first = store.check();
    const second = store.check();
    expect(getAuthStatus).toHaveBeenCalledTimes(1);
    expect(store.checking).toBe(true);
    resolve({ authenticated: false, setupRequired: true });
    await Promise.all([first, second]);
    expect(store.setupRequired).toBe(true);
    expect(store.connectionError).toBe('');
  });

  it('长时间无响应会中止请求并开放重试', async () => {
    vi.useFakeTimers();
    getAuthStatus.mockImplementation(signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const store = useAuthStore();
    const pending = store.check();
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;
    expect(store.connectionError).toContain('连接超时');
    expect(store.checking).toBe(false);
    expect(getAuthStatus.mock.calls[0][0].aborted).toBe(true);
  });
});
