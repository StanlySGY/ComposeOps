import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, bumpHostEpoch } from '../api/client.js';

export const useHostsStore = defineStore('hosts', () => {
  const hosts = ref([]);
  const activeHostId = ref('local');
  const loading = ref(false);
  const error = ref('');
  const pinging = ref('');
  let loadVersion = 0;
  let mutationVersion = 0;
  const probes = new Map();

  const active = computed(() => hosts.value.find((host) => host.id === activeHostId.value) || hosts.value[0] || null);

  async function load(force = false) {
    const request = ++loadVersion;
    const mutation = mutationVersion;
    loading.value = force || !hosts.value.length;
    error.value = '';
    try {
      const data = await api.getHosts(force || !!hosts.value.length);
      if (request !== loadVersion || mutation !== mutationVersion) return;
      hosts.value = Array.isArray(data.hosts) ? data.hosts : [];
      syncActive(hosts.value);
    } catch (e) {
      if (request === loadVersion && mutation === mutationVersion) error.value = e.message;
    } finally {
      if (request === loadVersion) loading.value = false;
    }
  }
  function syncActive(list) {
    const activeItem = list.find((host) => host.active);
    activeHostId.value = activeItem?.id || 'local';
    list.forEach((host) => { host.active = host.id === activeHostId.value; });
  }

  function ping(id) {
    if (probes.has(id)) return probes.get(id);
    pinging.value = id;
    const task = api.pingHost(id).then(result => {
      const host = hosts.value.find(item => item.id === id);
      if (host && result.host) {
        mutationVersion += 1;
        // A probe may finish after a switch/group edit; it only owns observation fields.
        for (const key of ['status', 'latencyMs', 'version', 'containerCount', 'runningCount', 'lastPingAt', 'error']) {
          host[key] = result.host[key];
        }
      }
      return result;
    }).finally(() => {
      probes.delete(id);
      pinging.value = [...probes.keys()].at(-1) || '';
    });
    probes.set(id, task);
    return task;
  }

  async function addOrUpdate(payload) {
    const result = await api.saveHost(payload);
    await load(true);
    return result.host;
  }

  async function remove(id) {
    await api.deleteHost(id);
    if (activeHostId.value === id) activeHostId.value = 'local';
    await load(true);
  }

  async function switchHost(id) {
    const result = await api.setActiveHost(id);
    mutationVersion += 1;
    bumpHostEpoch();
    activeHostId.value = result.activeHostId;
    hosts.value.forEach((host) => { host.active = host.id === result.activeHostId; });
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
    return result;
  }

  async function assignGroup(id, group) {
    const saved = await api.setHostGroup(id, group);
    const host = hosts.value.find(item => item.id === id);
    mutationVersion += 1;
    if (host) host.group = saved.group;
  }
  return { assignGroup, hosts, activeHostId, active, loading, error, pinging, load, ping, addOrUpdate, remove, switchHost };
});
