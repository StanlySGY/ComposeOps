import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref } from 'vue';
import { api } from '../api/client.js';
import { assertAuthEpoch, getAuthEpoch, onAuthEpochChange } from '../lib/auth-context.js';

export const useCmdbStore = defineStore('cmdb', () => {
  const assets = ref([]);
  const relations = ref([]);
  const loading = ref(false);
  const error = ref('');
  const syncing = ref(false);
  let requestVersion = 0;
  let syncVersion = 0;

  const hosts = computed(() => assets.value.filter((a) => a.kind === 'host'));
  const projects = computed(() => assets.value.filter((a) => a.kind === 'project'));
  const containers = computed(() => assets.value.filter((a) => a.kind === 'container'));

  async function load(force = false) {
    const request = ++requestVersion;
    loading.value = force || !assets.value.length;
    error.value = '';
    try {
      const data = await api.getCmdbAssets({ limit: 500 });
      if (request === requestVersion) assets.value = data.assets || [];
    } catch (e) {
      if (request === requestVersion) error.value = e.message;
    } finally {
      if (request === requestVersion) loading.value = false;
    }
  }

  async function loadTopology() {
    const request = ++requestVersion;
    error.value = ''; loading.value = !assets.value.length;
    try {
      const data = await api.getCmdbTopology();
      if (request !== requestVersion) return;
      assets.value = data.assets || [];
      relations.value = data.relations || [];
    } catch (e) {
      if (request === requestVersion) error.value = e.message;
    } finally {
      if (request === requestVersion) loading.value = false;
    }
  }

  async function sync() {
    const epoch = getAuthEpoch(), version = ++syncVersion;
    syncing.value = true;
    try {
      await api.syncCmdbAssets();
      assertAuthEpoch(epoch);
      await load(true);
    } finally {
      if (version === syncVersion) syncing.value = false;
    }
  }

  async function remove(id) {
    const epoch = getAuthEpoch();
    await api.deleteCmdbAsset(id);
    assertAuthEpoch(epoch);
    assets.value = assets.value.filter((a) => a.id !== id);
  }

  async function addRelation(payload) {
    const epoch = getAuthEpoch();
    await api.addCmdbRelation(payload);
    assertAuthEpoch(epoch);
    await loadTopology();
  }

  async function removeRelation(id) {
    const epoch = getAuthEpoch();
    await api.deleteCmdbRelation(id);
    assertAuthEpoch(epoch);
    relations.value = relations.value.filter((r) => r.id !== id);
  }

  function resetSession(clear = true) {
    ++requestVersion; ++syncVersion;
    if (clear) { assets.value = []; relations.value = []; }
    error.value = '';
    loading.value = syncing.value = false;
  }
  const stopAuthListener = onAuthEpochChange((_epoch, { identityChanged }) => resetSession(identityChanged));
  onScopeDispose(() => { stopAuthListener(); resetSession(); });

  return {
    assets, relations, loading, error, syncing,
    hosts, projects, containers,
    load, loadTopology, sync, remove, addRelation, removeRelation,
  };
});
