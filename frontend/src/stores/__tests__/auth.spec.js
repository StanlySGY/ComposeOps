import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '../auth.js';
import { api } from '../../api/client.js';

vi.mock('../../api/client.js', () => ({
  api: {
    getAuthStatus: vi.fn(),
    setup: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  }
}));

describe('useAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    api.getAuthStatus.mockResolvedValue({ authenticated: true, setupRequired: false, principal: { id: 'admin', role: 'admin', enabled: true } });
  });

  describe('initial state', () => {
    it('has correct default values', () => {
      const store = useAuthStore();
      expect(store.ready).toBe(false);
      expect(store.authenticated).toBe(false);
      expect(store.setupRequired).toBe(false);
    });
  });

  describe('check()', () => {
    it('sets authenticated state when user is logged in', async () => {
      api.getAuthStatus.mockResolvedValue({ authenticated: true, setupRequired: false, principal: { id: 'admin', role: 'admin', enabled: true } });
      
      const store = useAuthStore();
      await store.check();
      
      expect(store.authenticated).toBe(true);
      expect(store.setupRequired).toBe(false);
      expect(store.ready).toBe(true);
    });

    it('sets setupRequired when initial setup needed', async () => {
      api.getAuthStatus.mockResolvedValue({ authenticated: false, setupRequired: true });
      
      const store = useAuthStore();
      await store.check();
      
      expect(store.authenticated).toBe(false);
      expect(store.setupRequired).toBe(true);
      expect(store.ready).toBe(true);
    });

    it('sets ready to true even when API call fails', async () => {
      api.getAuthStatus.mockRejectedValue(new Error('Network error'));
      
      const store = useAuthStore();
      
      try {
        await store.check();
      } catch (e) {
        // Expected to fail, but ready should still be true
      }
      
      expect(store.ready).toBe(true);
    });
  });

  describe('submit()', () => {
    it('calls setup API when setupRequired is true', async () => {
      api.setup.mockResolvedValue({});

      const store = useAuthStore();
      store.setupRequired = true;

      await store.submit('password123');

      // 未填引导令牌时以空串透传(服务端设置 SETUP_TOKEN 才强制要求)
      expect(api.setup).toHaveBeenCalledWith('password123', '');
      expect(api.login).not.toHaveBeenCalled();
      expect(store.authenticated).toBe(true);
      expect(store.setupRequired).toBe(false);
    });

    it('passes setupToken to setup API when provided', async () => {
      api.setup.mockResolvedValue({});

      const store = useAuthStore();
      store.setupRequired = true;

      await store.submit('password123', 'bootstrap-token');

      expect(api.setup).toHaveBeenCalledWith('password123', 'bootstrap-token');
    });

    it('calls login API when setupRequired is false', async () => {
      api.login.mockResolvedValue({});
      
      const store = useAuthStore();
      store.setupRequired = false;
      
      await store.submit('password123');
      
      expect(api.login).toHaveBeenCalledWith('password123', 'admin');
      expect(api.setup).not.toHaveBeenCalled();
      expect(store.authenticated).toBe(true);
    });
  });

  describe('logout()', () => {
    it('calls logout API and clears authenticated state', async () => {
      api.logout.mockResolvedValue({});
      
      const store = useAuthStore();
      store.authenticated = true;
      
      await store.logout();
      
      expect(api.logout).toHaveBeenCalled();
      expect(store.authenticated).toBe(false);
    });
  });

  describe('expire()', () => {
    it('sets authenticated to false without API call', () => {
      const store = useAuthStore();
      store.authenticated = true;
      
      store.expire();
      
      expect(store.authenticated).toBe(false);
      expect(api.logout).not.toHaveBeenCalled();
    });
  });
});

it('unknown identity never exposes administrator UI and failed status cannot fake successful login', async () => {
  setActivePinia(createPinia());
  const store = useAuthStore(); expect(store.isAdmin).toBe(false);
  api.login.mockResolvedValue({ ok: true }); api.getAuthStatus.mockRejectedValue(new Error('offline'));
  await expect(store.submit('password123', '', 'operator')).rejects.toThrow();
  expect(store.authenticated).toBe(false); expect(store.isAdmin).toBe(false);
});
it('named member login preserves its role, logout clears the principal', async () => {
  setActivePinia(createPinia());
  api.getAuthStatus.mockResolvedValue({ authenticated: true, setupRequired: false, principal: { id: 'operator-id', role: 'operator', enabled: true } });
  const store = useAuthStore(); await store.submit('password123', '', 'operator');
  expect(store.isAdmin).toBe(false); expect(store.principal.id).toBe('operator-id');
  await store.logout(); expect(store.principal).toBe(null);
});
