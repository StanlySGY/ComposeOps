<template>
  <div :class="embedded ? '' : 'page-shell'">
    <div v-if="!embedded" class="page-header">
      <div>
        <h1 class="page-title">AI 变更评审</h1>
        <p class="page-subtitle">部署前自动审查 Compose 变更,评估影响范围与风险等级</p>
      </div>
      <div class="page-actions">
        <select v-model="selectedProjectId" class="input sm:w-56" aria-label="选择项目" @change="loadProject">
          <option value="">选择项目</option>
          <option v-for="p in composeProjects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
        </select>
        <button class="btn-secondary" :disabled="loading" @click="loadProject"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>
    <!-- embedded 模式(变更与回滚页 tab)没有页头,单独保留选择项目的工具条,否则无法选择项目 -->
    <div v-else class="mb-3 flex flex-wrap items-center justify-end gap-2">
      <select v-model="selectedProjectId" class="input sm:w-56" aria-label="选择项目" @change="loadProject">
        <option value="">选择项目</option>
        <option v-for="p in composeProjects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
      </select>
      <button class="btn-secondary" :disabled="loading" @click="loadProject"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
    </div>

    <p v-if="error" class="alert-error">{{ error }}</p>

    <EmptyState v-if="!selectedProjectId" icon="ShieldCheck" title="选择项目进行变更评审" description="从上方下拉框选择一个 Compose 项目,自动分析当前配置的风险与影响" class="flex-1" />

    <template v-else>
      <!-- 风险评分横幅 -->
      <section class="rounded-3xl border p-6" :class="riskBannerClass">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="flex items-center gap-4">
            <div class="grid h-16 w-16 place-items-center rounded-2xl border font-mono text-2xl font-bold" :class="riskScoreClass">{{ riskScore }}</div>
            <div>
              <h2 class="text-lg font-semibold text-surface-100">风险等级:{{ riskLabel }}</h2>
              <p class="mt-1 text-sm text-surface-400">{{ riskSummary }}</p>
            </div>
          </div>
          <div class="flex gap-3">
            <div class="rounded-xl border border-surface-800 px-4 py-2 text-center">
              <div class="text-xs text-surface-500">服务</div>
              <div class="text-lg font-semibold text-surface-100">{{ services.length }}</div>
            </div>
            <div class="rounded-xl border border-surface-800 px-4 py-2 text-center">
              <div class="text-xs text-surface-500">错误</div>
              <div class="text-lg font-semibold text-rose-400">{{ errorCount }}</div>
            </div>
            <div class="rounded-xl border border-surface-800 px-4 py-2 text-center">
              <div class="text-xs text-surface-500">警告</div>
              <div class="text-lg font-semibold text-amber-400">{{ warningCount }}</div>
            </div>
          </div>
          <button class="btn-primary" :disabled="deploying || errorCount > 0" :title="errorCount > 0 ? '存在语义错误,无法部署' : '按当前配置执行部署'" @click="openDeployConfirm">
            <Rocket class="w-4 h-4" :class="{ 'animate-pulse': deploying }" />{{ deploying ? '部署中...' : '一键部署' }}
          </button>
        </div>
      </section>

      <!-- 部署预演 -->
      <section class="section-panel">
        <div class="mb-4 flex items-center justify-between">
          <div><h2 class="section-title">部署预演</h2><p class="mt-1 text-muted">部署将创建、重建、移除的容器,以及受影响的卷与端口</p></div>
          <span class="count-badge" :class="deployImpactCount ? 'text-amber-300' : 'text-emerald-300'">{{ deployImpactCount ? `${deployImpactCount} 项影响` : '无影响' }}</span>
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
            <div class="text-sm font-semibold text-emerald-300">将创建 {{ preview.added.length }}</div>
            <div class="mt-2 flex flex-wrap gap-1.5"><span v-for="item in preview.added" :key="item.service" class="count-badge text-emerald-300">{{ item.service }}</span></div>
          </div>
          <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
            <div class="text-sm font-semibold text-amber-300">将重建 {{ preview.changed.length }}</div>
            <div class="mt-2 flex flex-wrap gap-1.5"><span v-for="item in preview.changed" :key="item.service" class="count-badge text-amber-300">{{ item.service }}</span></div>
          </div>
          <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
            <div class="text-sm font-semibold text-sky-300">将重启 {{ preview.restarted.length }}</div>
            <div class="mt-2 flex flex-wrap gap-1.5"><span v-for="item in preview.restarted" :key="item.service" class="count-badge text-sky-300">{{ item.service }}</span></div>
          </div>
          <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
            <div class="text-sm font-semibold text-rose-300">将移除 {{ preview.removed.length }}</div>
            <div class="mt-2 flex flex-wrap gap-1.5"><span v-for="item in preview.removed" :key="item.service" class="count-badge text-rose-300">{{ item.service }}</span></div>
          </div>
          <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
            <div class="text-sm font-semibold text-violet-300">受影响卷 {{ volumeImpact.length }}</div>
            <div class="mt-2 flex flex-wrap gap-1.5"><span v-for="v in volumeImpact" :key="v" class="count-badge font-mono text-violet-300">{{ v }}</span></div>
          </div>
          <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
            <div class="text-sm font-semibold text-rose-300">端口映射 {{ preview.portConflicts.length }}</div>
            <div class="mt-2 flex flex-wrap gap-1.5"><span v-for="p in preview.portConflicts" :key="p" class="count-badge font-mono text-rose-300">{{ p }}</span></div>
          </div>
        </div>
      </section>

      <!-- 语义校验 -->
      <section class="section-panel">
        <div class="mb-4"><h2 class="section-title">语义校验</h2><p class="mt-1 text-muted">静态分析 depends_on、links、端口冲突、镜像声明等</p></div>
        <div v-if="!issues.length" class="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-4 text-sm text-emerald-300">✓ 未发现语义问题,配置结构健康</div>
        <div v-else class="space-y-2">
          <div v-for="(issue, idx) in issues" :key="idx" class="flex items-start gap-3 rounded-xl border p-3" :class="issue.level === 'error' ? 'border-rose-900/40 bg-rose-950/20' : issue.level === 'warn' ? 'border-amber-900/40 bg-amber-950/20' : 'border-sky-900/40 bg-sky-950/20'">
            <span class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold" :class="issue.level === 'error' ? 'bg-rose-500/20 text-rose-300' : issue.level === 'warn' ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300'">{{ issue.level === 'error' ? '错误' : issue.level === 'warn' ? '警告' : '提示' }}</span>
            <div class="min-w-0 flex-1">
              <p class="text-sm text-surface-200">{{ issue.message }}</p>
              <p v-if="issue.service" class="mt-0.5 font-mono text-xs text-surface-500">服务:{{ issue.service }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- 变更影响预览 -->
      <section class="section-panel">
        <div class="mb-4"><h2 class="section-title">变更影响预览</h2><p class="mt-1 text-muted">对比当前运行容器,评估部署将影响哪些服务</p></div>
        <div class="grid gap-3 md:grid-cols-2">
          <div v-if="preview.added.length" class="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-4">
            <div class="text-sm font-semibold text-emerald-300">新增服务 {{ preview.added.length }}</div>
            <div class="mt-2 flex flex-wrap gap-1.5"><span v-for="item in preview.added" :key="item.service" class="count-badge text-emerald-300">{{ item.service }}</span></div>
          </div>
          <div v-if="preview.changed.length" class="rounded-xl border border-amber-900/40 bg-amber-950/20 p-4">
            <div class="text-sm font-semibold text-amber-300">配置变更,容器将重建 {{ preview.changed.length }}</div>
            <div class="mt-2 space-y-1"><p v-for="item in preview.changed" :key="item.service" class="text-xs text-surface-300">{{ item.service }} <span class="text-surface-500">· {{ item.reasons.join(', ') }} · {{ item.container }}</span></p></div>
          </div>
          <div v-if="preview.restarted.length" class="rounded-xl border border-sky-900/40 bg-sky-950/20 p-4">
            <div class="text-sm font-semibold text-sky-300">运行中容器将重启 {{ preview.restarted.length }}</div>
            <div class="mt-2 flex flex-wrap gap-1.5"><span v-for="item in preview.restarted" :key="item.service" class="count-badge text-sky-300">{{ item.service }}</span></div>
          </div>
          <div v-if="preview.removed.length" class="rounded-xl border border-rose-900/40 bg-rose-950/20 p-4">
            <div class="text-sm font-semibold text-rose-300">将被移除的服务 {{ preview.removed.length }}</div>
            <div class="mt-2 space-y-1"><p v-for="item in preview.removed" :key="item.service" class="text-xs text-surface-300">{{ item.service }} <span class="text-surface-500">· {{ item.container }} ({{ item.state }})</span></p></div>
          </div>
          <div v-if="preview.portConflicts.length" class="rounded-xl border border-rose-900/40 bg-rose-950/20 p-4">
            <div class="text-sm font-semibold text-rose-300">端口映射 {{ preview.portConflicts.length }}</div>
            <div class="mt-2 flex flex-wrap gap-1.5"><span v-for="p in preview.portConflicts" :key="p" class="count-badge font-mono text-rose-300">{{ p }}</span></div>
          </div>
          <div v-if="!preview.added.length && !preview.changed.length && !preview.restarted.length && !preview.removed.length && !preview.portConflicts.length" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4 text-sm text-surface-400">未检测到会影响现有容器的变更。</div>
        </div>
      </section>

      <!-- AI 建议 -->
      <section class="section-panel">
        <div class="mb-4 flex items-center gap-2"><h2 class="section-title">AI 评审建议</h2><Bot class="h-4 w-4 text-emerald-400" /></div>
        <div class="space-y-2">
          <div v-for="(advice, idx) in aiAdvice" :key="idx" class="flex items-start gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-3">
            <span class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold" :class="advice.tone === 'danger' ? 'bg-rose-500/20 text-rose-300' : advice.tone === 'warning' ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'">{{ advice.tag }}</span>
            <p class="text-sm text-surface-200">{{ advice.text }}</p>
          </div>
        </div>
      </section>
    </template>

    <!-- 部署确认门 -->
    <BaseModal :show="showDeployConfirm" title="确认部署" size-class="max-w-[calc(100vw-2rem)] sm:max-w-lg" body-class="p-4 space-y-3" @close="showDeployConfirm = false">
      <p class="text-sm text-surface-300">将按当前配置对项目 <b class="text-surface-100">{{ project?.projectName }}</b> 执行部署。预演影响:</p>
      <div class="grid grid-cols-2 gap-2 text-sm">
        <div class="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-2.5"><span class="text-emerald-300">创建 {{ preview.added.length }}</span></div>
        <div class="rounded-lg border border-amber-900/40 bg-amber-950/20 p-2.5"><span class="text-amber-300">重建 {{ preview.changed.length }}</span></div>
        <div class="rounded-lg border border-sky-900/40 bg-sky-950/20 p-2.5"><span class="text-sky-300">重启 {{ preview.restarted.length }}</span></div>
        <div class="rounded-lg border border-rose-900/40 bg-rose-950/20 p-2.5"><span class="text-rose-300">移除 {{ preview.removed.length }}</span></div>
      </div>
      <p v-if="preview.removed.length" class="text-xs text-rose-300">有服务将被移除,部署后对应容器会停止。</p>
      <p v-if="preview.portConflicts.length" class="text-xs text-amber-300">存在 {{ preview.portConflicts.length }} 处端口映射,请确认宿主机端口可用。</p>
      <template #footer>
        <button class="btn-secondary" @click="showDeployConfirm = false">取消</button>
        <button class="btn-primary" :disabled="deploying" @click="confirmDeploy"><Rocket class="w-4 h-4" />{{ deploying ? '部署中...' : '确认部署' }}</button>
      </template>
    </BaseModal>

    <!-- 部署输出抽屉 -->
    <BaseModal :show="deployOutput.open" :title="`部署输出 · ${project?.projectName || ''}`" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[80vh] flex-col" body-class="flex min-h-0 flex-1 flex-col p-0" @close="deployOutput.open = false">
      <template #header-actions>
        <span v-if="deployOutput.running" class="count-badge text-sky-300">执行中</span>
      </template>
      <pre class="terminal-output max-h-[70vh] min-h-48 flex-1 overflow-auto p-4">{{ deployOutput.text || '等待输出...' }}</pre>
      <template #footer>
        <button class="btn-secondary" @click="deployOutput.open = false">关闭</button>
      </template>
    </BaseModal>
  </div>
</template>

<script setup>
// embedded 模式供 ReleaseView 的 tab 复用,隐藏独立页头
defineProps({ embedded: { type: Boolean, default: false } });
import { computed, onMounted, ref } from 'vue';
import { Bot, RefreshCw, Rocket, ShieldCheck } from 'lucide-vue-next';
import { api, streamComposeControl } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';
import EmptyState from '../components/common/EmptyState.vue';
import BaseModal from '../components/common/BaseModal.vue';

const store = useServicesStore();
const composeProjects = computed(() => store.projects.filter((project) => project.editable));
const selectedProjectId = ref('');
const loading = ref(false);
const error = ref('');
const issues = ref([]);
const preview = ref({ added: [], changed: [], restarted: [], removed: [], portConflicts: [] });
const services = ref([]);
const showDeployConfirm = ref(false);
const deploying = ref(false);
const deployOutput = ref({ open: false, text: '', running: false });
let deployController = null;

const project = computed(() => store.projects.find((p) => p.id === selectedProjectId.value));
const volumeImpact = computed(() => {
  const set = new Set();
  for (const svc of services.value) {
    for (const v of svc.volumes || []) {
      const name = String(v).split(':')[0];
      if (name && !name.startsWith('/') && !name.startsWith('.')) set.add(name);
    }
  }
  return [...set];
});
const deployImpactCount = computed(() => preview.value.added.length + preview.value.changed.length + preview.value.restarted.length + preview.value.removed.length + preview.value.portConflicts.length);

const errorCount = computed(() => issues.value.filter((i) => i.level === 'error').length);
const warningCount = computed(() => issues.value.filter((i) => i.level === 'warn').length);

const riskScore = computed(() => {
  let score = 100;
  score -= errorCount.value * 25;
  score -= warningCount.value * 8;
  score -= preview.value.removed.length * 15;
  score -= preview.value.changed.length * 5;
  score -= preview.value.portConflicts.length * 20;
  return Math.max(0, score);
});
const riskLabel = computed(() => riskScore.value >= 90 ? '低' : riskScore.value >= 70 ? '中' : '高');
const riskBannerClass = computed(() => riskScore.value >= 90 ? 'border-emerald-900/40 bg-emerald-950/10' : riskScore.value >= 70 ? 'border-amber-900/40 bg-amber-950/10' : 'border-rose-900/40 bg-rose-950/10');
const riskScoreClass = computed(() => riskScore.value >= 90 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : riskScore.value >= 70 ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300');
const riskSummary = computed(() => {
  const parts = [];
  if (errorCount.value) parts.push(`${errorCount.value} 个语义错误`);
  if (preview.value.removed.length) parts.push(`${preview.value.removed.length} 个服务将被移除`);
  if (preview.value.changed.length) parts.push(`${preview.value.changed.length} 个服务将重建`);
  if (preview.value.portConflicts.length) parts.push(`${preview.value.portConflicts.length} 处端口映射`);
  return parts.length ? `检测到:${parts.join('、')}` : '配置健康,可安全部署';
});

const aiAdvice = computed(() => {
  const advice = [];
  if (errorCount.value) advice.push({ tone: 'danger', tag: '阻断', text: `存在 ${errorCount.value} 个语义错误,建议修复后再部署,否则可能导致服务无法启动。` });
  if (preview.value.removed.length) advice.push({ tone: 'danger', tag: '删除', text: `${preview.value.removed.length} 个服务将从 Compose 中移除,对应容器会被停止。请确认这些服务不再需要。` });
  if (preview.value.portConflicts.length) advice.push({ tone: 'danger', tag: '端口', text: `检测到 ${preview.value.portConflicts.length} 处端口映射,可能存在宿主机端口占用风险。` });
  if (preview.value.changed.length) advice.push({ tone: 'warning', tag: '重建', text: `${preview.value.changed.length} 个服务因镜像/环境/卷/端口变化将被重建,期间会有短暂不可用。` });
  if (preview.value.restarted.length) advice.push({ tone: 'warning', tag: '重启', text: `${preview.value.restarted.length} 个运行中容器将重启,建议在低峰期执行。` });
  if (warningCount.value) advice.push({ tone: 'warning', tag: '警告', text: `存在 ${warningCount.value} 个警告,建议检查镜像声明与环境变量定义。` });
  if (!advice.length) advice.push({ tone: 'success', tag: '通过', text: '未发现明显风险,配置结构健康,可以安全部署。' });
  return advice;
});

async function loadProject() {
  if (!selectedProjectId.value) return;
  loading.value = true;
  error.value = '';
  issues.value = [];
  preview.value = { added: [], changed: [], restarted: [], removed: [], portConflicts: [] };
  services.value = [];
  try {
    const data = await api.getComposeFile(selectedProjectId.value, 0);
    const content = data.content || '';
    const [validateResult, previewResult] = await Promise.all([
      api.validateCompose(selectedProjectId.value, 0, content),
      api.previewCompose(selectedProjectId.value, content),
    ]);
    issues.value = validateResult.issues || [];
    preview.value = previewResult || { added: [], changed: [], restarted: [], removed: [], portConflicts: [] };
    const parsed = (await import('yaml')).parse(content);
    services.value = Object.entries(parsed?.services || {}).map(([name, cfg]) => ({ name, volumes: cfg?.volumes || [] }));
  } catch (e) {
    error.value = `变更评审失败: ${e.message}`;
  } finally {
    loading.value = false;
  }
}

function openDeployConfirm() {
  if (errorCount.value) return;
  showDeployConfirm.value = true;
}
async function confirmDeploy() {
  showDeployConfirm.value = false;
  deploying.value = true;
  deployOutput.value = { open: true, text: '', running: true };
  deployController?.abort();
  deployController = new AbortController();
  try {
    await streamComposeControl(selectedProjectId.value, 'up', (frame) => {
      if (frame.type === 'stdout' || frame.type === 'stderr') deployOutput.value.text += frame.data;
      else if (frame.type === 'error') deployOutput.value.text += `\n[错误] ${frame.data}`;
      else if (frame.type === 'exit') deployOutput.value.text += `\n[退出码 ${frame.data.code}]`;
    }, null, null, deployController.signal);
    await store.refresh(true);
  } catch (e) {
    if (e.name !== 'AbortError') deployOutput.value.text += `\n[请求失败] ${e.message}`;
  } finally {
    deployController = null;
    deploying.value = false;
    deployOutput.value.running = false;
  }
}

onMounted(async () => {
  await store.refresh(false);
});
</script>
