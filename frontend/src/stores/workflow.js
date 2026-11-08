import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api/client.js';

export const useWorkflowStore = defineStore('workflow', () => {
  const definitions = ref([]);
  const instances = ref([]);
  const definitionsLoading = ref(false);
  const instancesLoading = ref(false);
  const definitionsError = ref('');
  const instancesError = ref('');
  const loading = computed(() => definitionsLoading.value || instancesLoading.value);
  const error = computed(() => [definitionsError.value, instancesError.value].filter(Boolean).join('；'));
  let contextVersion = 0;
  let definitionsRequest = 0;
  let instancesRequest = 0;

  async function loadDefinitions() {
    const request = ++definitionsRequest;
    definitionsLoading.value = true;
    definitionsError.value = '';
    try {
      const data = await api.getWorkflowDefinitions(true);
      if (request === definitionsRequest) definitions.value = data.definitions || [];
    } catch (error) {
      if (request === definitionsRequest) definitionsError.value = error.message || '读取工作流失败';
    } finally {
      if (request === definitionsRequest) definitionsLoading.value = false;
    }
  }
  async function loadInstances(params = {}) {
    const request = ++instancesRequest;
    instancesLoading.value = true;
    instancesError.value = '';
    try {
      const data = await api.getWorkflowInstances({ limit: 100, ...params }, true);
      if (request === instancesRequest) instances.value = data.instances || [];
    } catch (error) {
      if (request === instancesRequest) instancesError.value = error.message || '读取运行记录失败';
    } finally {
      if (request === instancesRequest) instancesLoading.value = false;
    }
  }
  function invalidateContext({ clear = false } = {}) {
    ++contextVersion; ++definitionsRequest; ++instancesRequest;
    definitionsLoading.value = instancesLoading.value = false;
    if (clear) {
      definitions.value = []; instances.value = [];
      definitionsError.value = instancesError.value = '';
    }
  }
  function upsert(list, row) {
    const index = list.value.findIndex(item => item.id === row.id);
    if (index >= 0) list.value[index] = { ...list.value[index], ...row };
    else list.value = [row, ...list.value];
  }
  async function saveDefinition(action) {
    const version = contextVersion;
    ++definitionsRequest; definitionsLoading.value = false;
    const data = await action();
    if (version === contextVersion) {
      ++definitionsRequest;
      upsert(definitions, data.definition);
      void loadDefinitions();
    }
    return data.definition;
  }
  function create(payload) { return saveDefinition(() => api.createWorkflowDefinition(payload)); }
  function update(id, payload) { return saveDefinition(() => api.updateWorkflowDefinition(id, payload)); }
  async function remove(id) {
    const version = contextVersion;
    ++definitionsRequest; ++instancesRequest;
    definitionsLoading.value = instancesLoading.value = false;
    await api.deleteWorkflowDefinition(id);
    if (version !== contextVersion) return;
    ++definitionsRequest; ++instancesRequest;
    definitions.value = definitions.value.filter(item => item.id !== id);
    instances.value = instances.value.filter(item => item.definitionId !== id);
    void loadDefinitions(); void loadInstances();
  }
  async function updateInstance(action) {
    const version = contextVersion;
    ++instancesRequest; instancesLoading.value = false;
    const data = await action();
    if (version === contextVersion) {
      ++instancesRequest;
      upsert(instances, data.instance);
      void loadInstances();
    }
    return data.instance;
  }
  function run(id, context = {}) { return updateInstance(() => api.runWorkflow(id, context)); }
  function approve(id, payload) { return updateInstance(() => api.approveWorkflowInstance(id, payload)); }
  function cancel(id) { return updateInstance(() => api.cancelWorkflowInstance(id)); }
  return {
    definitions, instances, definitionsLoading, instancesLoading, definitionsError, instancesError,
    loading, error, loadDefinitions, loadInstances, create, update, remove, run, approve, cancel, invalidateContext,
  };
});
