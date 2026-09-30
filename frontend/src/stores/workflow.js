import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api/client.js';

export const useWorkflowStore = defineStore('workflow', () => {
  const definitions = ref([]);
  const instances = ref([]);
  const loading = ref(false);
  const error = ref('');

  async function loadDefinitions(force = false) {
    if (!force && definitions.value.length) {
      await api.getWorkflowDefinitions(true).then((data) => { definitions.value = data.definitions || []; error.value = ''; }).catch((e) => { error.value = e.message; });
      return;
    }
    loading.value = true;
    error.value = '';
    try {
      const data = await api.getWorkflowDefinitions(true);
      definitions.value = data.definitions || [];
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  async function loadInstances(params = {}) {
    try {
      const data = await api.getWorkflowInstances({ limit: 100, ...params }, true);
      instances.value = data.instances || [];
    } catch (e) {
      error.value = e.message;
    }
  }

  async function create(payload) {
    const data = await api.createWorkflowDefinition(payload);
    await loadDefinitions(true);
    return data.definition;
  }

  async function update(id, payload) {
    const data = await api.updateWorkflowDefinition(id, payload);
    await loadDefinitions(true);
    return data.definition;
  }

  async function remove(id) {
    await api.deleteWorkflowDefinition(id);
    await loadDefinitions(true);
  }

  async function run(id, context = {}) {
    const data = await api.runWorkflow(id, context);
    await loadInstances();
    return data.instance;
  }

  async function approve(id, payload) {
    const data = await api.approveWorkflowInstance(id, payload);
    await loadInstances();
    return data.instance;
  }

  async function cancel(id) {
    const data = await api.cancelWorkflowInstance(id);
    await loadInstances();
    return data.instance;
  }

  return {
    definitions, instances, loading, error,
    loadDefinitions, loadInstances, create, update, remove, run, approve, cancel,
  };
});
