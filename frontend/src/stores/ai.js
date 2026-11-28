import { defineStore } from 'pinia';
import { onScopeDispose, ref } from 'vue';
import { api } from '../api/client.js';
import { assertAuthEpoch, getAuthEpoch, onAuthEpochChange } from '../lib/auth-context.js';

export const useAiStore = defineStore('ai', () => {
  const config = ref({ baseUrl: '', apiKey: '', model: '', systemPrompt: '' });
  const history = ref([]);
  const sessions = ref([]);
  const loading = ref(false);

  async function loadConfig() {
    const epoch = getAuthEpoch();
    const data = await api.getAiConfig(); assertAuthEpoch(epoch);
    config.value = data;
  }
  async function saveConfig(payload) {
    const epoch = getAuthEpoch();
    await api.saveAiConfig(payload);
    assertAuthEpoch(epoch);
    await loadConfig();
  }
  async function loadHistory(sessionId = null) {
    const epoch = getAuthEpoch();
    const data = await api.getAiHistory(sessionId);
    assertAuthEpoch(epoch);
    history.value = data.messages || [];
  }
  async function loadSessions() {
    const epoch = getAuthEpoch();
    const data = await api.getAiSessions(30);
    assertAuthEpoch(epoch);
    sessions.value = data.sessions || [];
  }
  async function clearHistory(sessionId = null) {
    const epoch = getAuthEpoch();
    await api.clearAiHistory(sessionId);
    assertAuthEpoch(epoch);
    history.value = [];
  }

  function resetSession() {
    config.value = { baseUrl: '', apiKey: '', model: '', systemPrompt: '' };
    history.value = []; sessions.value = []; loading.value = false;
  }
  const stopAuthListener = onAuthEpochChange((_epoch, { identityChanged }) => { if (identityChanged) resetSession(); });
  onScopeDispose(() => { stopAuthListener(); resetSession(); });

  return { config, history, sessions, loading, loadConfig, saveConfig, loadHistory, loadSessions, clearHistory };
});
