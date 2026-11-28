import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAuthStore } from '../src/stores/auth.js';
import { api, bumpHostEpoch } from '../src/api/client.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const identity = id => ({ authenticated: true, setupRequired: false, principal: { id, role: 'admin', enabled: true } });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
let fetchMock, store, expire;
beforeEach(() => {
  setActivePinia(createPinia()); bumpHostEpoch(); store = useAuthStore();
  fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  expire = () => store.expire(); window.addEventListener('composeops:unauthorized', expire);
});
afterEach(() => { window.removeEventListener('composeops:unauthorized', expire); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function signIn(id) {
  fetchMock.mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json(identity(id)));
  await store.submit('fictional-password', '', id);
}

describe('账号切换时的 API 响应归属', () => {
  it('上一会话迟到的 401 不会让新账号退出', async () => {
    await signIn('first'); const old = deferred(); fetchMock.mockReturnValueOnce(old.promise);
    const pending = api.getSreProfiles().catch(error => error);
    store.expire(); await signIn('second');
    old.resolve(json({ message: '登录已过期' }, 401)); await pending;
    expect(store.authenticated).toBe(true); expect(store.principal.id).toBe('second');
  });

  it('上一会话迟到的成功响应不能交给新页面或写回缓存', async () => {
    await signIn('first'); const old = deferred(); fetchMock.mockReturnValueOnce(old.promise);
    const pending = api.getPreferences().catch(error => error);
    store.expire(); await signIn('second');
    old.resolve(json({ owner: 'first' }));
    expect(await pending).toMatchObject({ name: 'AbortError' });
    fetchMock.mockResolvedValueOnce(json({ owner: 'second' }));
    expect(await api.getPreferences()).toEqual({ owner: 'second' });
  });

  it('当前会话的 401 仍然使身份失效', async () => {
    await signIn('first'); fetchMock.mockResolvedValueOnce(json({ message: '登录已过期' }, 401));
    await expect(api.getSreProfiles()).rejects.toMatchObject({ status: 401 });
    expect(store.authenticated).toBe(false); expect(store.principal).toBeNull();
  });

  it('认证失效后清除已缓存数据，读取必须等待当前请求', async () => {
    await signIn('first'); fetchMock.mockResolvedValueOnce(json({ owner: 'first' })); await api.getPreferences();
    store.expire(); const current = deferred(); fetchMock.mockReturnValueOnce(current.promise);
    let result; const pending = api.getPreferences().then(data => { result = data; });
    await Promise.resolve(); await Promise.resolve(); expect(result).toBeUndefined();
    current.resolve(json({ owner: 'current' })); await pending; expect(result).toEqual({ owner: 'current' });
  });

  it('上一会话断网后的自动恢复不会带着新 Cookie 重发请求', async () => {
    vi.useFakeTimers(); await signIn('first'); const old = deferred(); fetchMock.mockReturnValueOnce(old.promise);
    const pending = api.getSreProfiles().catch(error => error);
    store.expire(); await signIn('second');
    old.reject(new TypeError('Failed to fetch')); await vi.runAllTimersAsync();
    expect((await pending).name).toBe('AbortError'); expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('响应头已到而响应体读取未结束，切换账号仍拒绝旧内容', async () => {
    await signIn('first'); const body = deferred();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), text: () => body.promise });
    const pending = api.getSreProfiles().catch(error => error);
    await Promise.resolve(); store.expire(); await signIn('second');
    body.resolve('{"owner":"first"}'); expect((await pending).name).toBe('AbortError');
  });

  it('修改密码换发会话后，旧请求的 401 不再让用户退出', async () => {
    await signIn('first'); const old = deferred(); fetchMock.mockReturnValueOnce(old.promise);
    const pending = api.getSreProfiles().catch(error => error);
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await api.changePassword({ currentPassword: 'fictional-password', nextPassword: 'new-fictional-password' });
    old.resolve(json({ message: '旧会话已撤销' }, 401)); await pending;
    expect(store.authenticated).toBe(true);
  });

  it('旧会话写入结果不重放，也不向新页面广播成功', async () => {
    await signIn('first'); const old = deferred(); fetchMock.mockReturnValueOnce(old.promise);
    const changed = vi.fn(); window.addEventListener('composeops:data-changed', changed);
    try {
      const pending = api.saveProjectPreference('old-project', { note: 'old' }).catch(error => error);
      store.expire(); await signIn('second'); old.resolve(json({ ok: true }));
      expect((await pending).name).toBe('AbortError'); expect(changed).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('old-project'))).toHaveLength(1);
    } finally { window.removeEventListener('composeops:data-changed', changed); }
  });
});
