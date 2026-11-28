import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api/client.js';

export const useAuthStore = defineStore('auth', () => {
  const principal = ref(null);
  const isAdmin = computed(() => principal.value?.role === 'admin');
  const ready = ref(false);
  const authenticated = ref(false);
  const setupRequired = ref(false);
  const checking = ref(false);
  const connectionError = ref('');
  let checkPromise = null;

  function check() {
    if (checkPromise) return checkPromise;
    checking.value = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    checkPromise = (async () => {
      try {
        const status = await api.getAuthStatus(controller.signal);
        if (typeof status?.authenticated !== 'boolean' || typeof status?.setupRequired !== 'boolean') {
          throw new Error('认证状态响应无效');
        }
        authenticated.value = status.authenticated;
        principal.value = status.principal || null;
        setupRequired.value = status.setupRequired;
        connectionError.value = '';
      } catch {
        connectionError.value = controller.signal.aborted
          ? '连接超时，请检查网络或服务状态后重试。'
          : '无法连接服务器，请检查网络或服务状态后重试。';
      } finally {
        clearTimeout(timeout);
        ready.value = true;
        checking.value = false;
        checkPromise = null;
      }
    })();
    return checkPromise;
  }
  async function submit(password, setupToken = '', username = 'admin') {
    if (setupRequired.value) await api.setup(password, setupToken);
    else await api.login(password, username);
    await check();
    if (connectionError.value || !authenticated.value || !principal.value) throw new Error(connectionError.value || '登录状态未确认，请重试。');
    setupRequired.value = false;
  }
  async function logout() {
    await api.logout();
    authenticated.value = false; principal.value = null;
  }
  function expire() { authenticated.value = false; principal.value = null; }

  return { principal, isAdmin, ready, authenticated, setupRequired, checking, connectionError, check, submit, logout, expire };
});
