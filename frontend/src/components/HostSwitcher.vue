<template>
  <div class="relative">
    <button class="host-switch" title="切换 Docker 节点" aria-label="切换 Docker 节点" @click="toggle">
      <span v-if="!active || active.status === 'online'" class="status-ping bg-emerald-400"></span>
      <span v-else class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
      <span class="max-w-10 truncate sm:hidden">{{ active?.type === 'local' ? '本机' : (active?.name || '节点') }}</span>
      <span class="hidden lg:inline max-w-24 truncate">{{ active?.name || 'Local' }}</span>
      <ChevronDown class="w-3 h-3 text-surface-500" />
    </button>
    <div v-if="open" class="fixed inset-0 z-50" @click="open = false"></div>
    <section v-if="open" class="host-dropdown z-50">
      <header class="flex items-center justify-between border-b border-surface-800 px-3 py-2">
        <span class="text-xs font-medium text-surface-300">Docker 节点</span>
        <button class="icon-btn" title="刷新节点状态" :disabled="loading" @click="reload"><RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" /></button>
      </header>
      <div class="max-h-72 overflow-y-auto p-1.5">
        <button v-for="host in store.hosts" :key="host.id" class="host-item" :class="{ active: host.id === store.activeHostId }" @click="select(host)">
          <span class="w-2 h-2 rounded-full shrink-0" :class="host.status === 'online' ? 'bg-emerald-400' : host.status === 'offline' ? 'bg-rose-400' : 'bg-surface-500'"></span>
          <span class="min-w-0 flex-1 text-left">
            <strong class="block truncate text-sm font-medium text-surface-200">{{ host.name }}</strong>
            <small class="block truncate text-muted">{{ host.type === 'local' ? '本机 Docker' : `${host.type.toUpperCase()} · ${host.host}:${host.port}` }}<template v-if="host.latencyMs"> · {{ host.latencyMs }}ms</template></small>
          </span>
          <CircleCheck v-if="host.id === store.activeHostId" class="w-4 h-4 shrink-0 text-emerald-400" />
        </button>
        <button class="host-item" @click="goManage">
          <Settings class="w-4 h-4 shrink-0 text-surface-400" />
          <span class="flex-1 text-left text-sm text-surface-300">节点管理</span>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useEscapeKey } from '../composables/useEscapeKey.js';
import { useRouter } from 'vue-router';
import { useHostsStore } from '../stores/hosts.js';
import { useToastStore } from '../stores/toast.js';
import { ChevronDown, CircleCheck, RefreshCw, Settings } from 'lucide-vue-next';

const store = useHostsStore();
const toast = useToastStore();
const router = useRouter();
const goManage = () => { open.value = false; router.push('/settings?tab=hosts'); };
const open = ref(false);
const active = computed(() => store.active);

async function toggle() {
  open.value = !open.value;
  if (open.value && !store.hosts.length) await reload();
}
async function reload() { await store.load().catch((e) => toast.error(e.message)); }
async function select(host) {
  if (host.id === store.activeHostId) { open.value = false; return; }
  try {
    await store.switchHost(host.id);
    toast.success(`已切换到节点 ${host.name},项目列表正在刷新`);
    open.value = false;
    window.dispatchEvent(new CustomEvent('composeops:host-changed'));
  } catch (e) {
    toast.error(e.message);
  }
}
useEscapeKey({ active: open, onClose: () => { open.value = false; }, layer: 'event' });
onMounted(() => { if (!store.hosts.length) void store.load(); });
</script>
