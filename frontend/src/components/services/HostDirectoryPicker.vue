<template>
  <div class="grid gap-2 text-xs text-surface-300">
    <label class="grid gap-1.5">项目根目录
      <div class="flex gap-2">
        <input :value="modelValue" class="input min-w-0 flex-1 font-mono" :disabled="disabled" aria-label="项目根目录" placeholder="输入宿主机绝对路径，例如 /srv/apps" @input="$emit('update:modelValue', $event.target.value)" @keydown.enter.prevent="browse(modelValue)" />
        <button type="button" class="btn-secondary shrink-0" :disabled="disabled || loading" @click="browse(modelValue || '/')">浏览目录</button>
      </div>
    </label>
    <div class="flex flex-wrap gap-2" aria-label="目录快捷入口">
      <button v-for="root in roots" :key="root" type="button" class="text-status-info hover:underline" :disabled="disabled" @click="$emit('update:modelValue', root)">{{ root }}</button>
    </div>
    <section v-if="opened" class="rounded-lg border border-surface-700 p-2" aria-label="宿主机目录浏览器" :aria-busy="loading">
      <div class="mb-2 flex items-center gap-2">
        <button class="btn-secondary btn-sm" :disabled="disabled || loading || !listing?.parent" @click="browse(listing.parent)">上级目录</button>
        <span class="min-w-0 flex-1 break-all font-mono">{{ listing?.path || modelValue }}</span>
        <button class="btn-ghost btn-sm" aria-label="收起目录浏览器" @click="close">收起</button>
      </div>
      <p v-if="loading" class="py-2 text-muted" role="status">正在读取目标节点目录…</p>
      <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
      <div v-if="listing" class="grid max-h-44 gap-1 overflow-auto sm:grid-cols-2">
        <button v-for="entry in listing.entries" :key="entry.path" class="flex items-center gap-2 rounded px-2 py-2 text-left hover:bg-surface-800" :disabled="disabled || loading" @click="browse(entry.path)">
          <Folder :size="15" class="shrink-0 text-status-info" /><span class="break-all">{{ entry.name }}{{ entry.symlink ? ' ↗' : '' }}</span>
        </button>
        <span v-if="!listing.entries.length && !loading" class="p-2 text-muted">没有子目录，可在当前目录创建项目。</span>
      </div>
      <button v-if="listing?.next" class="btn-secondary btn-sm mt-2" :disabled="loading" @click="browse(listing.path, listing.next)">加载更多目录</button>
    </section>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { Folder } from 'lucide-vue-next';
import { api } from '../../api/client.js';
const props = defineProps({ modelValue: { type: String, default: '' }, hostId: { type: String, default: '' }, roots: { type: Array, default: () => [] }, disabled: Boolean });
const emit = defineEmits(['update:modelValue']);
const opened = ref(false), listing = ref(null), loading = ref(false), error = ref('');
let controller, version = 0;
function close() { version++; controller?.abort(); opened.value = false; loading.value = false; }
async function browse(directory, after = '') {
  if (props.disabled) return;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal, request = ++version;
  opened.value = true; loading.value = true; error.value = '';
  const timer = setTimeout(() => controller?.signal === signal && controller.abort(), 15000);
  try {
    const result = await api.getHostDirectories({ directory, expectedHostId: props.hostId, ...(after ? { after } : {}) }, signal);
    if (request !== version) return;
    listing.value = { ...result, entries: after ? [...(listing.value?.entries || []), ...result.entries] : result.entries };
    emit('update:modelValue', result.path);
  } catch (cause) {
    if (request === version) error.value = signal.aborted ? '读取目录超时，请重试。' : cause.message;
  } finally { clearTimeout(timer); if (request === version) loading.value = false; }
}
watch(() => props.hostId, () => { close(); listing.value = null; });
onBeforeUnmount(close);
onDeactivated(close);
</script>
