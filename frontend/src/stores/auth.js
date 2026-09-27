import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api/client.js';

export const useAuthStore = defineStore('auth', () => {
  const ready = ref(false);
  const authenticated = ref(false);
  const setupRequired = ref(false);

  async function check() {
    try {
      const status = await api.getAuthStatus();
      authenticated.value = !!status.authenticated;
      setupRequired.value = !!status.setupRequired;
    } finally {
      ready.value = true;
    }
  }
  async function submit(password, setupToken = '') {
    if (setupRequired.value) await api.setup(password, setupToken);
    else await api.login(password);
    authenticated.value = true;
    setupRequired.value = false;
  }
  async function logout() {
    await api.logout();
    authenticated.value = false;
  }
  function expire() { authenticated.value = false; }

  return { ready, authenticated, setupRequired, check, submit, logout, expire };
});
