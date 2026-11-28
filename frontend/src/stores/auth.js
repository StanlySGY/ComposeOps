import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api/client.js';
import { advanceAuthEpoch } from '../lib/auth-context.js';

export const useAuthStore = defineStore('auth', () => {
  const principal = ref(null);
  const isAdmin = computed(() => principal.value?.role === 'admin');
  const ready = ref(false);
  const authenticated = ref(false);
  const setupRequired = ref(false);
  const checking = ref(false);
  const connectionError = ref('');
  let pendingCheck = null;
  let identityEpoch = 0;

  function cancelCheck() {
    const previous = pendingCheck;
    pendingCheck = null;
    if (previous) { clearTimeout(previous.timeout); previous.controller.abort(); }
    checking.value = false;
  }

  function check() {
    if (pendingCheck) return pendingCheck.promise;
    checking.value = true;
    const controller = new AbortController();
    const current = { controller, timeout: setTimeout(() => controller.abort(), 12_000), promise: null };
    pendingCheck = current;
    current.promise = (async () => {
      try {
        const status = await api.getAuthStatus(controller.signal);
        if (pendingCheck !== current) return;
        const identity = status?.principal;
        if (typeof status?.authenticated !== 'boolean' || typeof status?.setupRequired !== 'boolean' ||
          (status.authenticated && (status.setupRequired || typeof identity?.id !== 'string' || !identity.id ||
            !['admin', 'operator', 'viewer'].includes(identity.role) || identity.enabled !== true))) {
          throw new Error('认证状态响应无效');
        }
        const identityChanged = authenticated.value !== status.authenticated ||
          (status.authenticated && (principal.value?.id !== identity.id || principal.value?.role !== identity.role));
        authenticated.value = status.authenticated;
        principal.value = status.authenticated ? identity : null;
        setupRequired.value = status.setupRequired;
        connectionError.value = '';
        // A status refresh may observe a changed cookie or role without going
        // through submit/expire. Shared stores and in-flight reads must follow it.
        if (identityChanged) advanceAuthEpoch();
      } catch {
        if (pendingCheck !== current) return;
        const hadIdentity = authenticated.value || principal.value !== null;
        authenticated.value = false;
        principal.value = null;
        if (hadIdentity) advanceAuthEpoch();
        connectionError.value = controller.signal.aborted
          ? '连接超时，请检查网络或服务状态后重试。'
          : '无法连接服务器，请检查网络或服务状态后重试。';
      } finally {
        clearTimeout(current.timeout);
        if (pendingCheck === current) {
          ready.value = true;
          checking.value = false;
          pendingCheck = null;
        }
      }
    })();
    return current.promise;
  }
  async function submit(password, setupToken = '', username = 'admin') {
    const epoch = ++identityEpoch;
    advanceAuthEpoch();
    cancelCheck();
    if (setupRequired.value) await api.setup(password, setupToken);
    else await api.login(password, username);
    if (epoch !== identityEpoch) throw new Error('登录状态已变化，请重试。');
    // A read started before the login response does not yet confirm its cookie.
    cancelCheck();
    await check();
    if (epoch !== identityEpoch) throw new Error('登录状态已变化，请重试。');
    if (connectionError.value || !authenticated.value || !principal.value) throw new Error(connectionError.value || '登录状态未确认，请重试。');
    setupRequired.value = false;
  }
  async function logout() {
    const epoch = ++identityEpoch;
    advanceAuthEpoch();
    cancelCheck();
    await api.logout();
    if (epoch === identityEpoch) expire();
  }
  function expire() {
    identityEpoch++;
    advanceAuthEpoch();
    cancelCheck();
    authenticated.value = false; principal.value = null; connectionError.value = '';
    ready.value = true;
  }

  return { principal, isAdmin, ready, authenticated, setupRequired, checking, connectionError, check, submit, logout, expire };
});
