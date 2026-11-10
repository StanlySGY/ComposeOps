<template>
  <section class="space-y-3 border-t border-surface-800 pt-4">
    <h2 class="section-title">AI 历史保留</h2>
    <p class="text-sm text-muted">对话、用量、Agent 计划与执行记录共用此期限。启动后及每 6 小时清理一次；边界时刻的记录保留。</p>
    <p v-if="error" class="text-sm text-red-400" role="alert">{{ error }} <button class="btn-secondary" @click="load">重试</button></p>
    <div class="flex flex-wrap items-center gap-2">
      <label class="text-sm">保留天数 <input v-model.number="days" class="input w-28" type="number" min="7" max="3650" aria-label="AI 历史保留天数" :disabled="busy || !state" @input="preview = null" /></label>
      <button class="btn-secondary" :disabled="busy || !state || !validDays" @click="save">保存期限</button>
      <button class="btn-secondary" :disabled="busy || !state || days !== state.days" @click="load(true)">预览 AI 清理</button>
    </div>
    <p v-if="state" class="text-sm text-muted">当前生效：{{ state.days }} 天。{{ days !== state.days ? '请先保存修改再预览。' : '' }}</p>
    <div v-if="preview" class="space-y-2 text-sm" role="status">
      <p>早于 {{ new Date(preview.cutoff).toLocaleString() }}：对话 {{ preview.counts.history }} 条，用量 {{ preview.counts.usage }} 条，计划 {{ preview.counts.plans }} 个，执行 {{ preview.counts.executions }} 条。</p>
      <button class="btn-secondary" :disabled="busy" @click="confirm = true">清理过期 AI 历史</button>
    </div>
    <p v-if="state?.lastResult" class="text-sm text-muted">最近清理：{{ new Date(state.lastResult.at).toLocaleString() }}，按 {{ state.lastResult.days }} 天保留，删除对话 {{ state.lastResult.counts.history }} 条、用量 {{ state.lastResult.counts.usage }} 条、计划 {{ state.lastResult.counts.plans }} 个、执行 {{ state.lastResult.counts.executions }} 条。</p>
    <p v-else-if="state" class="text-sm text-muted">尚无清理记录。</p>
    <ConfirmDialog :show="confirm" title="清理过期 AI 历史" :message="`按已保存的 ${state?.days} 天期限删除过期对话、用量和计划。此操作无法撤销，执行时以最新数据为准。`" confirm-text="执行清理" tone="warning" @cancel="confirm = false" @confirm="prune" />
  </section>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client.js';
import ConfirmDialog from '../common/ConfirmDialog.vue';
const state = ref(null); const preview = ref(null); const days = ref(90);
const busy = ref(false); const error = ref(''); const confirm = ref(false);
const validDays = computed(() => Number.isInteger(days.value) && days.value >= 7 && days.value <= 3650);
async function run(fn) {
  busy.value = true; error.value = '';
  try { await fn(); } catch (e) { error.value = e.message || '读取 AI 保留策略失败'; } finally { busy.value = false; }
}
function load(showPreview = false) { return run(async () => {
  state.value = await api.getAiRetention(); days.value = state.value.days;
  preview.value = showPreview === true ? state.value : null;
}); }
function save() { return run(async () => { state.value = await api.saveAiRetention(days.value); days.value = state.value.days; preview.value = null; }); }
function prune() { confirm.value = false; return run(async () => { state.value = await api.pruneAiRetention(state.value.days); preview.value = null; }); }
onMounted(() => load());
</script>
