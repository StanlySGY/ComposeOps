<template>
  <div :class="compact ? 'inline-flex items-center' : 'space-y-3'">
    <button v-if="!project || result?.hasUpdate" class="btn-secondary" :disabled="busy" @click="project ? openProject(project.id) : check()"><RefreshCw v-if="!project" class="h-4 w-4" :class="{ 'animate-spin': busy }" /><Sparkles v-else class="h-3.5 w-3.5" />{{ project ? `可升级 ${updateCount} 项` : busy ? '正在检查镜像…' : '检查镜像更新' }}</button>
    <template v-if="!compact && checked">
      <p class="text-sm text-muted" role="status">{{ summary }}</p>
      <div v-for="item in projects" :key="item.projectId" class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-surface-800 p-3"><span class="text-sm">{{ item.projectName || item.projectId }}</span><button class="btn-ghost" @click="openProject(item.projectId)">{{ item.hasUpdate ? `有 ${item.images?.filter(image => image.hasUpdate).length || 1} 项可升级` : '查看检查结果' }} →</button></div>
    </template>
    <p v-if="error" class="text-xs text-status-error" role="alert">{{ error }}</p>
  </div>
</template>
<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { RefreshCw, Sparkles } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import { deepLink } from '../../lib/deep-links.js';
import { buildImageUpdateSummary } from '../../lib/image-update-summary.js';
const props = defineProps({ project: { type: Object, default: null }, compact: Boolean });
const emit = defineEmits(['result', 'open']);
const route = useRoute(); const router = useRouter();
const busy = ref(false); const error = ref(''); const result = ref(null); const projects = ref([]); const checked = ref(false);
let requestId = 0;
const updateCount = computed(() => result.value?.images?.filter(image => image.hasUpdate).length || 0);
const summary = computed(() => buildImageUpdateSummary(projects.value));
async function check(force = true) {
  if (busy.value || (props.project && !props.project.managed)) return;
  const current = ++requestId;
  const projectId = props.project?.id;
  busy.value = true; error.value = '';
  try {
    if (projectId) { const response = await api.getProjectUpdates(projectId, force); if (current !== requestId) return; result.value = response; emit('result', response); }
    else { const response = await api.checkAllUpdates(); projects.value = response.projects || []; checked.value = true; }
  } catch (e) { if (current === requestId) error.value = e.message; } finally { if (current === requestId) busy.value = false; }
}
function openProject(id) {
  if (props.project) emit('open');
  else router.push(deepLink('/services', { projectId: id, upgrade: id, from: route.name }));
}
onMounted(() => { if (props.project) void check(false); });
watch(() => props.project?.id, () => { requestId += 1; busy.value = false; result.value = null; emit('result', null); void check(false); });
</script>
