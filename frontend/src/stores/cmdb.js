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
      return false;
    } finally {
      if (request === requestVersion) loading.value = false;
    }
  }

  async function loadTopology(force = false, { throwOnError = false } = {}) {
    const request = ++requestVersion;
    error.value = ''; loading.value = force || !assets.value.length;
    try {
      const data = await api.getCmdbTopology();
      if (request !== requestVersion) return false;
      assets.value = data.assets || [];
      relations.value = data.relations || [];
      return true;
    } catch (e) {
      if (request === requestVersion) error.value = e.message;
      if (throwOnError) throw e;
      return false;
    } finally {
      if (request === requestVersion) loading.value = false;
    }
  }

  function invalidateReads() {
    ++requestVersion;
    loading.value = false;
    error.value = '';
  }

  async function refreshAfterWrite(message) {
    invalidateReads();
    try {
      await loadTopology(true, { throwOnError: true });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(`${message}，但清单刷新失败：${e.message}。请刷新查看结果，无需重复提交。`);
    }
  }

  async function sync() {
    const epoch = getAuthEpoch(), version = ++syncVersion;
    syncing.value = true;
    try {
      await api.syncCmdbAssets();
      assertAuthEpoch(epoch);
      await refreshAfterWrite('资产同步已完成');
      assertAuthEpoch(epoch);
    } finally {
      if (version === syncVersion) syncing.value = false;
    }
  }

  async function remove(id) {
    const epoch = getAuthEpoch();
    await api.deleteCmdbAsset(id);
    assertAuthEpoch(epoch);
    invalidateReads();
    assets.value = assets.value.filter((a) => a.id !== id);
    relations.value = relations.value.filter((r) => r.sourceId !== id && r.targetId !== id);
  }

  async function addRelation(payload) {
    const epoch = getAuthEpoch();
    await api.addCmdbRelation(payload);
    assertAuthEpoch(epoch);
    await refreshAfterWrite('关系已保存');
    assertAuthEpoch(epoch);
  }

  async function removeRelation(id) {
    const epoch = getAuthEpoch();
    await api.deleteCmdbRelation(id);
    assertAuthEpoch(epoch);
    invalidateReads();
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
