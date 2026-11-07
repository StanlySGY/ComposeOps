<template>
  <div ref="drawerRef" class="drawer operation-drawer max-w-[calc(100vw-2rem)] sm:max-w-[720px] z-51" role="dialog" aria-labelledby="operation-output-title" tabindex="-1">
    <div class="modal-header"><h2 id="operation-output-title" class="min-w-0 truncate">{{ label }} · {{ name }} 操作输出</h2><button class="icon-btn" title="关闭输出面板" aria-label="关闭输出面板" @click="$emit('close')"><X class="w-4 h-4" /></button></div>
    <div v-if="batchTasks.length" class="border-b border-surface-800 p-3">
      <div class="mb-2 flex items-center justify-between text-muted"><span>任务进度</span><span role="status" aria-live="polite" aria-atomic="true">{{ completedCount }} / {{ batchTasks.length }} 项任务已完成</span></div>
      <div class="progress mb-3" role="progressbar" aria-label="批量任务总体进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.max(0, Math.min(100, batchProgress))" :aria-valuetext="`${completedCount} / ${batchTasks.length} 项任务已完成`"><span aria-hidden="true" :style="{ width: `${batchProgress}%` }"></span></div>
      <div class="grid gap-2 sm:grid-cols-2">
        <div v-for="task in batchTasks" :key="task.id" class="batch-task">
          <LoaderCircle v-if="task.status === 'running'" class="h-4 w-4 animate-spin text-status-info" />
          <CircleCheck v-else-if="task.status === 'success'" class="h-4 w-4 text-status-ok" />
          <CircleX v-else-if="task.status === 'failed'" class="h-4 w-4 text-status-error" />
          <span v-else class="h-2 w-2 rounded-full bg-surface-600"></span>
          <span class="min-w-0 flex-1 truncate text-xs">{{ task.name }}</span>
          <span class="text-[10px] text-surface-400">{{ statusLabel(task.status) }}</span>
        </div>
      </div>
    </div>
    <div v-if="!batchTasks.length" class="operation-result" role="status" aria-live="polite" :data-state="running ? 'running' : failed ? 'failed' : exitCode === 0 ? 'success' : 'unknown'">
      <LoaderCircle v-if="running" class="h-5 w-5 animate-spin" /><CircleX v-else-if="failed" class="h-5 w-5" /><CircleCheck v-else-if="exitCode === 0" class="h-5 w-5" /><CircleHelp v-else class="h-5 w-5" />
      <div><strong>{{ running ? '正在执行' : failed ? '执行失败' : exitCode === 0 ? '命令执行成功' : '尚未确认执行结果' }}</strong><p>{{ running ? '输出会实时更新，关闭面板不会发送停止命令。' : failed ? (failureReason || '查看下方输出定位原因，也可以交给 AI 分析。') : exitCode === 0 ? '命令退出码为 0；请继续确认容器状态与业务是否正常。' : '没有收到退出码。请检查项目状态，避免重复提交操作。' }}</p></div>
    </div>
    <section v-if="!running && projectId" class="operation-verification" :data-verification="contextValid ? verification?.state : 'unknown'" aria-label="执行后状态核对" aria-live="polite">
      <div class="verification-heading"><span><ScanLine :size="14" />执行后状态</span><button v-if="contextValid && action !== 'pull'" class="btn-ghost btn-sm" :disabled="checking" @click="verify"><RefreshCw :size="13" :class="{ 'animate-spin': checking }" />{{ checking ? '核对中' : '重新核对' }}</button></div>
      <template v-if="!contextValid"><strong>当前节点已切换</strong><p>请切回操作所属节点后核对结果，避免将其他节点的状态当成本次结果。</p></template>
      <template v-else-if="action === 'pull'"><strong>{{ exitCode === 0 && !failed ? '镜像已拉取，尚未应用到容器' : '请先确认镜像拉取结果' }}</strong><p>拉取只下载镜像。检查配置后，再通过项目操作应用配置。</p><button v-if="exitCode === 0 && !failed" class="btn-secondary btn-sm mt-3" @click="$emit('review')"><FileCode2 :size="14" />检查配置</button></template>
      <p v-else-if="checking" class="verification-loading"><LoaderCircle :size="15" class="animate-spin" />正在读取最新容器状态…</p>
      <template v-else-if="verification"><strong>{{ verification.title }}</strong><p>{{ verification.detail }}</p><ul v-if="verification.containers.length" class="verification-containers"><li v-for="container in verification.containers" :key="container.id"><span>{{ container.name || container.id.slice(0, 12) }}</span><StatusBadge :status="container.state" :health="container.health" /></li></ul><small v-if="verification.checkedAt">核对于 {{ verification.checkedAt }} · 当前扫描结果</small></template>
    </section>
    <div class="output-toolbar"><span><TerminalSquare :size="13" />命令输出</span><div class="flex items-center gap-1"><button class="btn-ghost btn-sm" :aria-pressed="followOutput" @click="resumeFollow"><ArrowDownToLine :size="13" />{{ followOutput ? '跟随输出' : '回到最新' }}</button><button class="btn-ghost btn-sm" :disabled="!text" @click="downloadOutput"><Download :size="13" />下载输出</button></div></div>
    <pre ref="outputRef" class="terminal-output flex-1" role="region" aria-label="操作执行输出" aria-live="off" tabindex="0" @scroll.passive="onOutputScroll">{{ text || '等待操作输出…' }}</pre>
    <div v-if="!running && projectId" class="ai-diagnose-bar">
      <template v-if="failed">
        <button class="btn-primary" :disabled="!contextValid" @click="$emit('diagnose')"><Sparkles class="w-4 h-4" />一键 AI 诊断</button>
        <span class="text-xs text-muted">检测到执行失败，可交给 AI 分析根因与修复建议</span>
      </template>
      <template v-else>
        <span class="text-xs text-muted">{{ verification?.state === 'confirmed' ? '状态已核对，可返回项目继续操作' : '下一步：核实当前项目状态' }}</span>
      </template>
      <div class="operation-followups"><button v-if="contextValid && action !== 'stop'" class="btn-secondary btn-sm" @click="$emit('logs')"><ScrollText :size="14" />查看日志</button><button class="btn-secondary btn-sm" :disabled="!contextValid" @click="$emit('inspect')">查看项目状态</button></div>
    </div>
  </div>
</template>

<script setup>
import { ArrowDownToLine, CircleCheck, CircleHelp, CircleX, Download, FileCode2, LoaderCircle, RefreshCw, ScanLine, ScrollText, Sparkles, TerminalSquare, X } from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useEscapeKey } from '../../composables/useEscapeKey.js';
import { useOperationVerification } from '../../composables/useOperationVerification.js';
import StatusBadge from '../common/StatusBadge.vue';

const props = defineProps({
  label: { type: String, default: '' },
  name: { type: String, default: '' },
  text: { type: String, default: '' },
  projectId: { type: String, default: '' },
  action: { type: String, default: '' },
  contextValid: { type: Boolean, default: true },
  exitCode: { type: Number, default: null },
  running: { type: Boolean, default: false },
  failureReason: { type: String, default: '' },
  batchTasks: { type: Array, default: () => [] },
  batchProgress: { type: Number, default: 0 },
  completedCount: { type: Number, default: 0 },
});
const emit = defineEmits(['close', 'diagnose', 'inspect', 'logs', 'review']);
const { verification, checking, verify } = useOperationVerification(props);
const outputRef = ref(null);
const followOutput = ref(true);
function onOutputScroll() {
  const element = outputRef.value;
  if (element) followOutput.value = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
}
function scrollToLatest() { const element = outputRef.value; if (element) element.scrollTop = element.scrollHeight; }
function resumeFollow() { followOutput.value = true; scrollToLatest(); }
watch(() => props.text, async () => { if (followOutput.value) { await nextTick(); if (followOutput.value) scrollToLatest(); } });
function downloadOutput() {
  const url = URL.createObjectURL(new Blob([props.text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `composeops-${(props.name || 'operation').replace(/[^\p{L}\p{N}_.-]/gu, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const drawerRef = ref(null);
const activeElementBeforeOpen = document.activeElement;
let previousFocus = activeElementBeforeOpen instanceof HTMLElement && activeElementBeforeOpen !== document.body
  ? activeElementBeforeOpen
  : null;

onMounted(async () => {
  await nextTick();
  drawerRef.value?.focus({ preventScroll: true });
  scrollToLatest();
});

onBeforeUnmount(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  previousFocus = null;
});

const failed = computed(() => {
  if (props.failureReason) return true;
  if (props.exitCode != null) return props.exitCode !== 0;
  return false;
});
useEscapeKey({ active: computed(() => true), onClose: () => emit('close'), layer: 'drawer', lockBody: true });
function statusLabel(status) { return ({ pending: '等待', running: '执行中', success: '成功', failed: '失败' })[status] || status; }
</script>

<style scoped>
.operation-result { display: flex; align-items: flex-start; gap: 10px; padding: 16px; border-bottom: 1px solid var(--line-subtle); color: var(--color-surface-300); }
.operation-result strong { font-size: 13px; font-weight: 600; }
.operation-result p { margin-top: 5px; font-size: 11px; color: var(--color-surface-400); }
.operation-result[data-state="success"] > svg { color: #6ee7b7; }
.operation-result[data-state="failed"] > svg { color: #fda4af; }
.operation-result[data-state="unknown"] > svg { color: #fcd34d; }
.operation-drawer { overflow-y: auto; right: 16px; bottom: 16px; height: min(780px, calc(100dvh - 116px)); border-radius: 15px; background: #161b23; animation: operation-reveal 180ms ease-out both; animation-delay: 0ms; }
.operation-drawer > * { flex-shrink: 0; }
.operation-drawer .terminal-output { min-height: 120px; flex-shrink: 1; }
.operation-verification { margin: 14px 16px; padding: 14px; border: 1px solid var(--line-subtle); border-radius: 10px; background: var(--panel-surface); }
.verification-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.verification-heading > span, .verification-loading, .output-toolbar > span { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--color-surface-400); }
.operation-verification strong { font-size: 13px; font-weight: 550; }
.operation-verification p { margin-top: 5px; font-size: 12px; color: var(--color-surface-400); line-height: 1.7; }
.operation-verification[data-verification="confirmed"] strong { color: var(--color-status-ok); }
.operation-verification[data-verification="attention"] strong, .operation-verification[data-verification="pending"] strong { color: var(--color-status-warn); }
.verification-containers { margin-top: 12px; max-height: 140px; overflow: auto; }
.verification-containers li { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid var(--line-subtle); font-size: 11px; }.verification-containers li > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.operation-verification small { display: block; font-size: 10px; color: var(--color-surface-500); margin-top: 10px; }
.output-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 0 16px 6px; }
.operation-followups { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
@keyframes operation-reveal { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 639px) { .operation-drawer { right: 8px; bottom: 8px; height: calc(100dvh - 88px); max-width: calc(100vw - 16px); }.operation-verification { margin: 10px; padding: 12px; }.operation-followups { width: 100%; }.operation-followups button { flex: 1; min-height: 40px; }.operation-drawer .ai-diagnose-bar { padding: 12px; }.operation-drawer .modal-header { min-height: 48px; } }
@media (prefers-reduced-motion: reduce) { .operation-drawer { animation: none; } }
</style>
