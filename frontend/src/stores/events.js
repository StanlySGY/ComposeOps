import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api/client.js';

export const useEventStore = defineStore('events', () => {
  const events = ref([]);
  const stats = ref(null);
  const loading = ref(false);
  const error = ref('');
  let requestId = 0;
  let statsId = 0;
  let lastParams = {};
  const pendingUpdates = new Map();

  async function load(params = {}) {
    const id = ++requestId;
    lastParams = { ...params };
    loading.value = true;
    error.value = '';
    try {
      const data = await api.getEvents({ limit: 200, ...params });
      if (id === requestId) events.value = data.events || [];
    } catch (e) {
      if (id === requestId) error.value = e.message;
    } finally {
      if (id === requestId) loading.value = false;
    }
  }

  async function loadStats() {
    const id = ++statsId;
    try {
      const data = await api.getEventStats();
      if (id === statsId) stats.value = data.stats;
    } catch (e) {
      if (id === statsId) error.value = e.message;
    }
  }

  async function update(id, patch) {
    if (pendingUpdates.has(id)) return pendingUpdates.get(id);
    const pending = (async () => {
      const data = await api.updateEvent(id, patch);
      // 查询条件可能在写入期间变化，按最新条件刷新，避免复活已筛掉的记录。
      await Promise.all([load(lastParams), loadStats()]);
      return data.event;
    })();
    pendingUpdates.set(id, pending);
    try { return await pending; } finally { pendingUpdates.delete(id); }
  }

  async function prune(days = 30) {
    await api.pruneEvents(days);
    await load(lastParams);
    await loadStats();
  }

  return { events, stats, loading, error, load, loadStats, update, prune };
});