import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api/client.js';

export const useCmdbStore = defineStore('cmdb', () => {
  const assets = ref([]);
  const relations = ref([]);
  const loading = ref(false);
  const error = ref('');
  const syncing = ref(false);

  const hosts = computed(() => assets.value.filter((a) => a.kind === 'host'));
  const projects = computed(() => assets.value.filter((a) => a.kind === 'project'));
  const containers = computed(() => assets.value.filter((a) => a.kind === 'container'));

  async function load(force = false) {
    if (!force && assets.value.length) {
      api.getCmdbAssets({ limit: 500 }).then((data) => { assets.value = data.assets || []; error.value = ''; }).catch((e) => { error.value = e.message; });
      return;
    }
    loading.value = true;
    error.value = '';
    try {
      const data = await api.getCmdbAssets({ limit: 500 });
      assets.value = data.assets || [];
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  async function loadTopology() {
    try {
      const data = await api.getCmdbTopology();
      assets.value = data.assets || [];
      relations.value = data.relations || [];
    } catch (e) {
      error.value = e.message;
    }
  }

  async function sync() {
    syncing.value = true;
    try {
      await api.syncCmdbAssets();
      await load(true);
    } finally {
      syncing.value = false;
    }
  }

  async function remove(id) {
    await api.deleteCmdbAsset(id);
    assets.value = assets.value.filter((a) => a.id !== id);
  }

  async function addRelation(payload) {
    await api.addCmdbRelation(payload);
    await loadTopology();
  }

  async function removeRelation(id) {
    await api.deleteCmdbRelation(id);
    relations.value = relations.value.filter((r) => r.id !== id);
  }

  return {
    assets, relations, loading, error, syncing,
    hosts, projects, containers,
    load, loadTopology, sync, remove, addRelation, removeRelation,
  };
});
