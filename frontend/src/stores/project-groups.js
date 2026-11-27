import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api/client.js';

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
    const saved = value.id ? await api.updateProjectGroup(value.id, { name: value.name, pinned: value.pinned }) : await api.createProjectGroup(value);
    await load(); changed(); return saved;
  }
  async function remove(id) { await api.deleteProjectGroup(id); await load(); changed(); }
  return { groups, error, loading, load, save, remove, changed };
});
