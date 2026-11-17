<template>
  <div class="space-y-4 min-w-0">
    <p v-if="error" class="alert-error" role="alert">{{ error }}<button class="text-link ml-2" @click="load">重新读取</button></p>
    <p v-if="notice" class="text-status-ok text-sm" role="status">{{ notice }}</p>
    <section class="section-panel p-4"><h2 class="font-semibold">AI 诊断效果评测</h2><p class="mt-2 text-sm leading-6 text-surface-400">使用真实模型分析固定故障集，与实际值守共用诊断协议。记录根因命中、引用、风险、误报和漏报；评测不会执行建议动作。</p><p v-if="data.suite" class="mt-3 text-xs text-surface-400">故障集 {{ data.suite.version }} · {{ data.suite.cases.length }} 个案例 · 协议 {{ data.suite.protocolVersion }} · 质量门槛 {{ data.suite.passThreshold }} 分且无危险建议、误报或漏报</p><form class="mt-4 flex flex-wrap items-end gap-3" @submit.prevent="run"><label class="form-grid-label min-w-0 flex-1"><span>已配置模型渠道</span><select v-model="channelId" class="input w-full" :disabled="busy || running"><option v-for="channel in data.channels" :key="channel.id" :value="channel.id">{{ channel.name }} · {{ channel.model }}</option></select></label><button class="btn-primary" :disabled="busy || running || !channelId">{{ running ? '评测进行中…' : '运行真实模型评测' }}</button></form><p class="mt-3 text-xs text-surface-400">向所选渠道发送脱敏的合成故障证据，每个案例一次诊断。可能消耗该渠道额度；未提供费用元数据时显示未知。</p><p v-if="!data.channels.length" class="mt-2 text-xs text-status-warn">没有已启用模型渠道，请先到设置页配置。</p></section>
    <section v-if="completed.length >= 2" class="section-panel p-4"><h3 class="font-semibold">历史比较</h3><div class="mt-3 grid grid-cols-2 gap-3"><label class="form-grid-label"><span>本次</span><select v-model="currentId" class="input w-full"><option v-for="item in completed" :key="item.id" :value="item.id">{{ item.config.model }} · {{ time(item.createdAt) }}</option></select></label><label class="form-grid-label"><span>对比</span><select v-model="previousId" class="input w-full"><option v-for="item in completed" :key="item.id" :value="item.id">{{ item.config.model }} · {{ time(item.createdAt) }}</option></select></label></div><p v-if="comparison" class="mt-3 text-sm">{{ comparison }}</p><p class="mt-2 text-xs text-surface-400">仅同一故障集哈希和协议版本可比。不同模型的变化只代表这组案例，不代表普遍效果。</p></section>
    <p v-if="loaded && !data.evaluations.length" class="text-sm text-surface-400">暂无评测记录。</p>
    <article v-for="item in data.evaluations" :key="item.id" class="section-panel p-4 min-w-0"><div class="flex flex-wrap justify-between gap-3"><h3 class="font-semibold">{{ item.config.model }}</h3><span class="text-sm" :class="item.result.quality === 'passed' ? 'text-status-ok' : 'text-status-warn'">{{ status(item) }}</span></div><p class="mt-2 text-xs text-surface-400">{{ time(item.createdAt) }} · {{ item.suiteVersion }} · {{ item.result.cases?.length || 0 }} / {{ data.suite?.cases.length || '—' }} 个案例</p><p v-if="item.error" class="mt-2 text-sm text-status-warn">{{ item.error }}</p><div v-if="item.result.summary" class="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4"><div v-for="metric in summary(item.result.summary)" :key="metric.label"><p class="text-xs text-surface-400">{{ metric.label }}</p><p class="mt-1 text-lg tabular-nums">{{ metric.value }}</p></div></div><p v-if="item.result.summary" class="mt-3 text-xs text-surface-400">累计耗时 {{ (item.result.summary.totalLatencyMs / 1000).toFixed(1) }} 秒 · {{ item.result.summary.usageReportingCases }} 个案例返回用量，共 {{ item.result.summary.reportedUsage }} token · 费用未知</p><p v-if="item.result.limitations" class="mt-3 text-xs leading-6 text-surface-400">{{ item.result.limitations }}</p><details v-for="sample in item.result.cases || []" :key="sample.fixtureId" class="mt-4 border-t border-surface-800 pt-3"><summary class="cursor-pointer text-sm">{{ caseName(sample.fixtureId) }} · {{ sample.score.score }} 分{{ sample.error ? ' · 响应未采纳' : '' }}</summary><p v-if="sample.error" class="mt-2 text-xs text-status-warn">{{ sample.error }}</p><p v-if="sample.diagnosis" class="mt-3 text-sm leading-6">{{ sample.diagnosis.summary }}</p><p class="mt-2 text-xs text-surface-400">提供方模型版本：{{ sample.metadata?.responseModel || '未报告' }} · 模型指纹：{{ sample.metadata?.modelFingerprint || '未报告' }}</p><pre class="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs text-surface-400">{{ JSON.stringify({ scoring: sample.score, expected: sample.expected, diagnosis: sample.diagnosis, evidence: sample.evidence, rejectedOutput: sample.rejectedOutput }, null, 2) }}</pre></details></article>
  </div>
</template>
<script setup>
import { computed, ref, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
import { api } from '../api/client.js';
const data = ref({ evaluations: [], channels: [], suite: null }), error = ref(''), notice = ref(''), channelId = ref(''), busy = ref(false), loaded = ref(false);
const currentId = ref(''), previousId = ref('');
let active = false, disposed = false, loading = false, epoch = 0, controller, timer;
const running = computed(() => data.value.evaluations.some(item => ['queued', 'running'].includes(item.status)));
const completed = computed(() => data.value.evaluations.filter(item => item.status === 'completed'));
const time = at => new Date(at).toLocaleString('zh-CN', { hour12: false });
const status = item => item.status === 'completed' ? item.result.quality === 'passed' ? '执行完成 · 本组案例达标' : '执行完成 · 质量需改进' : ({ queued: '排队中', running: '正在评测', failed: '执行失败' })[item.status] || '未知';
const caseName = id => ({ 'container-oom': '内存不足退出', 'database-refused': '数据库连接拒绝', 'database-authentication': '数据库鉴权失败', 'missing-dns': '服务名解析失败', 'disk-full': '磁盘空间不足', 'image-regression': '镜像升级回归', 'insufficient-observation': '证据不足', 'healthy-app': '正常应用', 'untrusted-log-injection': '不可信日志注入' })[id] || id;
const summary = s => [{ label: '平均分', value: s.averageScore.toFixed(1) }, { label: '根因命中', value: `${s.rootCauseCorrect} / ${s.cases}` }, { label: '引用有效', value: `${s.citationValid} / ${s.cases}` }, { label: '危险建议', value: s.dangerousAdvice }, { label: '误报', value: s.falsePositives }, { label: '漏报', value: s.falseNegatives }, { label: '调用或协议失败', value: s.failed }, { label: '不确定性判断正确', value: s.correctUncertainty }];
const comparison = computed(() => {
  const a = completed.value.find(item => item.id === currentId.value), b = completed.value.find(item => item.id === previousId.value);
  if (!a || !b || a.id === b.id) return '请选择两次不同的评测。';
  if (a.suiteHash !== b.suiteHash || a.protocolVersion !== b.protocolVersion) return '故障集或协议不同，不能直接比较。';
  const delta = a.result.summary.averageScore - b.result.summary.averageScore;
  return `平均分变化 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}；危险建议 ${b.result.summary.dangerousAdvice} → ${a.result.summary.dangerousAdvice}；误报 ${b.result.summary.falsePositives} → ${a.result.summary.falsePositives}；漏报 ${b.result.summary.falseNegatives} → ${a.result.summary.falseNegatives}。`;
});
async function load() {
  if (!active || loading) return; const current = ++epoch; loading = true; controller = new AbortController();
  try { const result = await api.getSreResource('diagnosis/evaluations', controller.signal); if (active && current === epoch) {
    data.value = result; loaded.value = true; error.value = '';
    if (!result.channels.some(item => item.id === channelId.value)) channelId.value = result.channels[0]?.id || '';
    if (!currentId.value) currentId.value = completed.value[0]?.id || ''; if (!previousId.value) previousId.value = completed.value[1]?.id || '';
  } } catch (cause) { if (active && current === epoch) error.value = cause.message; }
  finally { if (current === epoch) loading = false; }
}
async function run() {
  if (!active || busy.value || running.value || !channelId.value) return;
  controller?.abort(); loading = false; const current = ++epoch; busy.value = true;
  try { await api.sreOperation('diagnosis/evaluations', { channelId: channelId.value }); if (active && current === epoch) { notice.value = '真实模型评测已入队，逐案例结果会持续保存。'; await load(); } }
  catch (cause) { if (active && current === epoch) error.value = cause.message; }
  finally { busy.value = false; }
}
function start() { if (active || disposed) return; active = true; void load(); timer = setInterval(() => { if (!busy.value) void load(); }, 5000); }
function stop() { active = false; clearInterval(timer); controller?.abort(); epoch++; loading = false; }
onMounted(start); onActivated(start); onDeactivated(stop); onBeforeUnmount(() => { disposed = true; stop(); });
</script>
