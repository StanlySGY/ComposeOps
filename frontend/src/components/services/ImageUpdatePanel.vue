<template>
  <div :class="compact ? 'inline-flex items-center' : 'space-y-3'">
    <button v-if="!project || result?.hasUpdate || uncertain || error" class="btn-secondary" :disabled="busy" @click="project ? openProject(project.id) : check()"><RefreshCw v-if="!project" class="h-4 w-4" :class="{ 'animate-spin': busy }" /><AlertCircle v-else-if="uncertain || error" class="h-3.5 w-3.5 text-status-warn" /><Sparkles v-else class="h-3.5 w-3.5" />{{ project ? (result?.hasUpdate ? `可升级 ${updateCount} 项${uncertain ? ' · 部分待确认' : ''}` : '镜像检查待确认') : busy ? '正在检查镜像…' : '检查镜像更新' }}</button>
    <template v-if="!compact && checked">
      <p class="text-sm text-muted" role="status">{{ summary }}</p>
      <div v-for="item in projects" :key="item.projectId" class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-surface-800 p-3"><span class="text-sm">{{ item.projectName || item.projectId }}</span><button class="btn-ghost" @click="openProject(item.projectId)">{{ item.hasUpdate ? `有 ${item.images?.filter(image => image.hasUpdate).length || 1} 项可升级` : '查看检查结果' }} →</button></div>
    </template>
    <p v-if="error && !compact" class="text-xs text-status-error" role="alert">{{ error }}</p>
  </div>
</template>
<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AlertCircle, RefreshCw, Sparkles } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import { deepLink } from '../../lib/deep-links.js';
import { buildImageUpdateSummary } from '../../lib/image-update-summary.js';
const props = defineProps({ project: { type: Object, default: null }, compact: Boolean });
const emit = defineEmits(['result', 'open']);
const route = useRoute(); const router = useRouter();
const busy = ref(false); const error = ref(''); const result = ref(null); const projects = ref([]); const checked = ref(false);
let requestId = 0;
let controller = null, active = true;
const updateCount = computed(() => result.value?.images?.filter(image => image.hasUpdate).length || 0);
const uncertain = computed(() => result.value?.images?.some(image => ['failed', 'unknown', 'unresolved', 'needs_policy'].includes(image.status)) || false);
const summary = computed(() => buildImageUpdateSummary(projects.value));
async function check(force = true) {
  if (!active || busy.value || (props.project && (!props.project.managed || props.project.editable === false))) return;
  const current = ++requestId;
  const projectId = props.project?.id;
  controller = new AbortController();
  const signal = controller.signal;
  busy.value = true; error.value = '';
  try {
    if (projectId) { const response = await api.getProjectUpdates(projectId, force, { signal }); if (current !== requestId) return; result.value = response; emit('result', response); }
    else { const response = await api.checkAllUpdates({ signal }); if (current !== requestId) return; projects.value = response.projects || []; checked.value = true; }
  } catch (e) { if (current === requestId) error.value = e.message; } finally { if (current === requestId) busy.value = false; }
}
function openProject(id) {
  if (props.project) emit('open');
  else router.push(deepLink('/services', { projectId: id, upgrade: id, from: route.name }));
}
function cancel() { requestId++; controller?.abort(); controller = null; busy.value = false; }
function reset() { cancel(); error.value = ''; result.value = null; projects.value = []; checked.value = false; emit('result', null); }
function hostChanged() { reset(); }
onMounted(() => { window.addEventListener('composeops:host-changed', hostChanged); if (props.project) void check(false); });
watch(() => [props.project?.id, props.project?.hostId, props.project?.managed, props.project?.editable], () => { reset(); if (props.project) void check(false); });
onDeactivated(() => { active = false; cancel(); });
onActivated(() => { if (active) return; active = true; if (props.project && !result.value) void check(false); });
onBeforeUnmount(() => { active = false; cancel(); window.removeEventListener('composeops:host-changed', hostChanged); });
</script>
