import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getAuthStatus', 'login', 'setup', 'logout'].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
import { useAuthStore } from '../src/stores/auth.js';

const principal = { id: 'admin', role: 'admin', enabled: true };
const signedIn = { authenticated: true, setupRequired: false, principal };
const signedOut = { authenticated: false, setupRequired: false, principal: null };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

describe('认证请求生命周期', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks(); api.getAuthStatus.mockResolvedValue(signedIn); });
  afterEach(() => vi.useRealTimers());

  it('退出成功后旧身份响应不能重新打开工作台', async () => {
    const old = deferred(); api.getAuthStatus.mockReturnValueOnce(old.promise);
    const store = useAuthStore(); const check = store.check();
    await store.logout();
    old.resolve(signedIn); await check;
    expect(store.authenticated).toBe(false); expect(store.principal).toBeNull();
    expect(api.getAuthStatus.mock.calls[0][0].aborted).toBe(true);
  });

  it('会话失效允许立即重读，旧 finally 不解除新请求的忙碌状态', async () => {
    const old = deferred(), next = deferred();
    api.getAuthStatus.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const store = useAuthStore(); const first = store.check(); store.expire(); const second = store.check();
    expect(api.getAuthStatus).toHaveBeenCalledTimes(2);
    old.resolve(signedIn); await first;
    expect(store.checking).toBe(true); expect(store.authenticated).toBe(false);
    next.resolve(signedOut); await second;
    expect(store.checking).toBe(false); expect(store.connectionError).toBe('');
  });

  it('登录后重新读取身份，不能复用登录前尚未返回的访客请求', async () => {
    const old = deferred(); api.getAuthStatus.mockReturnValueOnce(old.promise);
    const store = useAuthStore(); const check = store.check();
    const submit = store.submit('fictional-password');
    await vi.waitFor(() => expect(api.getAuthStatus).toHaveBeenCalledTimes(2));
    await submit; old.resolve(signedOut); await check;
    expect(store.isAdmin).toBe(true); expect(store.principal.id).toBe('admin');
  });

  it('失效后的旧失败不能遮挡新的登录界面', async () => {
    const old = deferred(); api.getAuthStatus.mockReturnValueOnce(old.promise);
    const store = useAuthStore(); const check = store.check(); store.expire();
    old.reject(new TypeError('Failed to fetch')); await check;
    expect(store.connectionError).toBe(''); expect(store.ready).toBe(true);
  });

  it.each([null, {}, { id: 'a', role: 'unknown', enabled: true }, { id: 'a', role: 'admin', enabled: false }])('已登录响应缺少有效身份时不误进入成员或管理员工作台：%j', async value => {
    const store = useAuthStore(); await store.check();
    api.getAuthStatus.mockResolvedValue({ ...signedIn, principal: value }); await store.check();
    expect(store.authenticated).toBe(false); expect(store.principal).toBeNull();
    expect(store.connectionError).not.toBe('');
  });

  it('未登录响应不能保留误附带的管理员身份', async () => {
    api.getAuthStatus.mockResolvedValue({ ...signedOut, principal });
    const store = useAuthStore(); await store.check();
    expect(store.isAdmin).toBe(false); expect(store.principal).toBeNull();
  });

  it('会话失效中断仍在等待的登录确认，不能再读回旧账号', async () => {
    const login = deferred(); api.login.mockReturnValueOnce(login.promise);
    const store = useAuthStore(); const submitted = store.submit('fictional-password');
    const result = expect(submitted).rejects.toThrow('登录状态已变化');
    store.expire(); login.resolve({ ok: true }); await result;
    expect(api.getAuthStatus).not.toHaveBeenCalled(); expect(store.authenticated).toBe(false);
  });

  it('身份读取超时清除旧身份，后续有效响应可以重新连接', async () => {
    vi.useFakeTimers(); const store = useAuthStore(); await store.check();
    api.getAuthStatus.mockImplementationOnce(signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const pending = store.check(); await vi.advanceTimersByTimeAsync(12_000); await pending;
    expect(store.authenticated).toBe(false); expect(store.isAdmin).toBe(false); expect(store.connectionError).toContain('超时');
    await store.check(); expect(store.isAdmin).toBe(true); expect(store.connectionError).toBe('');
  });
});
