<template>
  <BaseModal :show="true" :title="`${project.projectName} · 访问入口`" size-class="w-[calc(100vw-1.5rem)] sm:max-w-2xl max-h-[88vh] flex flex-col" body-class="min-h-0 overflow-auto p-4 space-y-4" :close-disabled="saving" @close="close">
    <p class="text-xs leading-5 text-surface-400">为需要安全入口的应用填写访问路径，例如 <code>/web/</code>。只调整面板中的访问链接，保存后立即生效。</p>
    <p v-if="loading" class="py-6 text-center text-sm text-surface-400" role="status">正在读取访问入口…</p>
    <div v-else-if="loadError" class="alert-warning flex items-center gap-2" role="alert"><span class="flex-1">{{ loadError }}</span><button class="btn-secondary" @click="load">重试</button></div>
    <template v-else>
      <div v-for="(entry, index) in rows" :key="JSON.stringify([entry.service, entry.port])" class="entry-setting">
        <div class="entry-setting__heading"><span class="entry-setting__name">{{ entry.service }}</span><span class="entry-setting__port">{{ entry.port }}/tcp</span><span v-if="entry.path && entry.path !== '/'" class="entry-setting__badge">自定义路径</span></div>
        <label class="block text-xs text-surface-400" :for="`entry-path-${index}`">访问路径</label>
        <div class="flex min-w-0 gap-2"><input :id="`entry-path-${index}`" v-model="entry.path" class="input min-w-0 flex-1 font-mono text-xs" :aria-label="`${entry.service} ${entry.port} 访问路径`" placeholder="/（默认）" :maxlength="512" :disabled="saving" autocomplete="off" spellcheck="false" /><button class="btn-secondary shrink-0 text-xs" :disabled="saving || !entry.path" @click="entry.path = ''">恢复默认</button></div>
        <div class="entry-setting__preview"><span>链接预览</span><code v-if="preview(entry)">{{ preview(entry) }}</code><span v-else class="text-amber-400">{{ entry.url ? '路径需以 / 开头，例如 /web/' : '当前端口未发现；配置将在入口恢复后生效' }}</span></div>
      </div>
      <p v-if="!rows.length" class="py-5 text-center text-sm text-surface-500">暂未发现可配置的网页入口</p>
      <p class="text-xs leading-5 text-surface-500">留空恢复端口根地址。配置按当前 Docker 节点、应用和端口保存，重建容器后继续保留。</p>
    </template>
    <p v-if="saveError" class="alert-error" role="alert">{{ saveError }}</p>
    <template #footer><button class="btn-ghost" :disabled="saving" @click="close">取消</button><button class="btn-primary" :disabled="loading || !!loadError || saving || !dirty" @click="save"><Save class="h-4 w-4" />{{ saving ? '正在保存…' : '保存入口' }}</button></template>
    <ConfirmDialog :show="discard" title="放弃访问入口修改" message="离开后，本次未保存的路径修改将丢失。" confirm-text="放弃修改" tone="warning" @confirm="emit('close')" @cancel="discard = false" />
  </BaseModal>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { Save } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';
import ConfirmDialog from '../common/ConfirmDialog.vue';
import { api } from '../../api/client.js';

const props = defineProps({ project: { type: Object, required: true }, initialService: { type: String, default: '' } });
const emit = defineEmits(['close', 'saved']);
const loading = ref(true), saving = ref(false), loadError = ref(''), saveError = ref(''), discard = ref(false);
const rows = ref([]), baseline = ref('[]');
let disposed = false, hostId = '', revision = 0;
const payload = () => rows.value.map(({ service, port, path }) => ({ service, port, path }));
const dirty = computed(() => JSON.stringify(payload()) !== baseline.value);
function preview(entry) {
  if (!entry.url) return '';
  const path = entry.path.trim();
  if (path && (!path.startsWith('/') || path.startsWith('//') || /[\\?#\s]/.test(path))) return '';
  try { const url = new URL(entry.url); url.pathname = path || '/'; return url.href; } catch { return ''; }
}
async function load() {
  loading.value = true; loadError.value = ''; saveError.value = '';
  try {
    const data = await api.getProjectWebUiSettings(props.project.id);
    if (disposed) return;
    hostId = data.hostId; revision = data.revision;
    const entries = new Map(data.entries.map(entry => [JSON.stringify([entry.service, entry.port]), { ...entry, url: '' }]));
    for (const target of data.targets) for (const port of target.ports) {
      const key = JSON.stringify([target.serviceName, port.port]);
      entries.set(key, { service: target.serviceName, port: port.port, path: entries.get(key)?.path || '', url: port.url });
    }
    rows.value = [...entries.values()].sort((a, b) => Number(b.service === props.initialService) - Number(a.service === props.initialService) || a.service.localeCompare(b.service) || a.port - b.port);
    baseline.value = JSON.stringify(payload());
  } catch (error) { if (!disposed) loadError.value = error.message; }
  finally { if (!disposed) loading.value = false; }
}
function close() { if (!saving.value) { if (dirty.value) discard.value = true; else emit('close'); } }
async function save() {
  if (loading.value || saving.value || loadError.value) return;
  saving.value = true; saveError.value = '';
  try {
    await api.saveProjectWebUiSettings(props.project.id, { hostId, revision, entries: payload() });
    if (!disposed) { emit('saved'); emit('close'); }
  } catch (error) { if (!disposed) saveError.value = error.message; }
  finally { if (!disposed) saving.value = false; }
}
function hostChanged() { emit('close'); }
window.addEventListener('composeops:host-changed', hostChanged);
onBeforeUnmount(() => { disposed = true; window.removeEventListener('composeops:host-changed', hostChanged); });
load();
</script>

<style scoped>
.entry-setting { display: grid; gap: 9px; padding: 14px; border: 1px solid rgba(var(--ui-line-rgb), .23); border-radius: 8px; }
.entry-setting__heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 2px; }
.entry-setting__name { color: var(--text-bright); font-family: var(--font-mono); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
.entry-setting__port { color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; }
.entry-setting__badge { margin-left: auto; color: var(--ui-link); font-size: 10px; }
.entry-setting__preview { display: grid; gap: 5px; padding: 9px 10px; border-radius: 5px; background: rgba(var(--ui-line-rgb), .05); font-size: 10px; color: var(--text-faint); }
.entry-setting__preview code { color: var(--ui-link); overflow-wrap: anywhere; line-height: 1.6; }
</style>
