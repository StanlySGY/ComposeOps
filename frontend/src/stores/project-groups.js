import { defineStore } from 'pinia';
import { onScopeDispose, ref } from 'vue';
import { api } from '../api/client.js';
import { assertAuthEpoch, getAuthEpoch, onAuthEpochChange } from '../lib/auth-context.js';

export const useProjectGroupsStore = defineStore('project-groups', () => {
  const groups = ref([]), error = ref(''), loading = ref(false);
  let request = 0;
  function changed() { window.dispatchEvent(new CustomEvent('composeops:project-groups-changed')); }
  async function load() {
    const version = ++request; loading.value = true;
    try { const result = await api.getProjectGroups(); if (version === request) { groups.value = result.groups || []; error.value = ''; } }
    catch (cause) { if (version === request) error.value = cause.message; }
    finally { if (version === request) loading.value = false; }
  }
  async function save(value) {
    const epoch = getAuthEpoch();
    const saved = value.id ? await api.updateProjectGroup(value.id, { name: value.name, pinned: value.pinned }) : await api.createProjectGroup(value);
    assertAuthEpoch(epoch);
    await load(); assertAuthEpoch(epoch); changed(); return saved;
  }
  async function remove(id) {
    const epoch = getAuthEpoch();
    await api.deleteProjectGroup(id); assertAuthEpoch(epoch);
    await load(); assertAuthEpoch(epoch); changed();
  }
  function resetSession(clear = true) { ++request; if (clear) groups.value = []; error.value = ''; loading.value = false; }
  const stopAuthListener = onAuthEpochChange((_epoch, { identityChanged }) => resetSession(identityChanged));
  onScopeDispose(() => { stopAuthListener(); resetSession(); });
  return { groups, error, loading, load, save, remove, changed };
});
