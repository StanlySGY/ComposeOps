<template>
  <div :class="embedded ? 'space-y-4' : 'page-shell space-y-4'" :aria-busy="loading">
    <div v-if="!embedded" class="page-header">
      <div>
        <h1 class="page-title">变更评审</h1>
        <p class="page-subtitle">部署前自动审查 Compose 变更,评估影响范围与风险等级</p>
      </div>
      <div class="page-actions">
        <select v-model="selectedProjectId" class="input sm:w-56" aria-label="选择项目" :disabled="deploying" @change="loadProject">
          <option value="">选择项目</option>
          <option v-for="p in composeProjects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
        </select>
        <button class="btn-secondary" :disabled="loading || deploying || !selectedProjectId" @click="loadProject"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>
    <!-- embedded 模式(变更与回滚页 tab)没有页头,单独保留选择项目的工具条,否则无法选择项目 -->
    <div v-else class="mb-3 flex flex-wrap items-center justify-end gap-2">
      <select v-model="selectedProjectId" class="input sm:w-56" aria-label="选择项目" :disabled="deploying" @change="loadProject">
        <option value="">选择项目</option>
        <option v-for="p in composeProjects" :key="p.id" :value="p.id">{{ p.projectName }}</option>
      </select>
      <button class="btn-secondary" :disabled="loading || deploying || !selectedProjectId" @click="loadProject"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
    </div>

    <div v-if="deployOutput.projectName" class="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-surface-800 bg-surface-900/50 px-4 py-3">
      <p class="min-w-0 text-sm text-surface-300">{{ deployOutput.projectName }} · {{ deployOutput.running ? '部署执行中' : deployOutput.status === 'completed' ? '部署完成' : deployOutput.status === 'failed' ? '部署失败' : '部署结果未确认' }}</p>
      <button class="btn-secondary" @click="deployOutput.open = true">查看部署输出</button>
    </div>
    <p v-if="loading" class="sr-only" role="status" aria-live="polite" aria-atomic="true">正在加载变更评审</p>
    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>

    <EmptyState v-if="!selectedProjectId" icon="ShieldCheck" title="选择项目进行变更评审" description="从上方下拉框选择一个 Compose 项目,检查当前配置的风险与影响" class="flex-1" />

    <section v-else-if="!reviewReady" class="section-panel flex min-h-64 flex-col items-center justify-center gap-4 px-5 py-8 text-center" data-testid="review-pending">
      <div class="grid h-14 w-14 place-items-center rounded-2xl border" :class="loading ? 'border-sky-900/50 bg-sky-950/30 text-sky-300' : 'border-amber-900/50 bg-amber-950/30 text-amber-300'">
        <RefreshCw v-if="loading" class="h-6 w-6 animate-spin motion-reduce:animate-none" /><ShieldCheck v-else class="h-6 w-6" />
      </div>
      <div class="max-w-lg"><h2 class="section-title">{{ loading ? '正在检查当前项目' : '评审尚未完成' }}</h2><p class="mt-2 text-sm leading-6 text-surface-400">{{ loading ? '正在读取配置并检查语义与变更影响，结果就绪后才能确认部署。' : '还没有可用的检查结果。请重新评审，确认项目与影响后再部署。' }}</p></div>
      <button v-if="!loading" class="btn-secondary" @click="loadProject"><RefreshCw class="h-4 w-4" />重新评审</button>
    </section>

    <template v-else>
      <!-- 风险评分横幅 -->
      <section class="rounded-3xl border p-4 sm:p-6" :class="riskBannerClass">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="flex items-center gap-4">
            <div class="grid h-16 w-16 place-items-center rounded-2xl border font-mono text-2xl font-bold" :class="riskScoreClass">{{ riskScore }}</div>
            <div>
              <p class="mb-1 text-xs text-surface-400">{{ reviewed.projectName }} · 检查于 {{ checkedTime }}</p><h2 class="text-lg font-semibold text-surface-100">规则风险等级:{{ riskLabel }}</h2>
              <p class="mt-1 text-sm text-surface-400">{{ riskSummary }}</p><p class="mt-1 text-xs text-surface-500">检查范围：首个 Compose 文件；执行时使用项目配置文件组合。</p>
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
          <button class="btn-primary" :disabled="!canDeploy" :title="errorCount > 0 ? '存在语义错误,无法部署' : '核对已评审配置后执行部署'" @click="openDeployConfirm">
            <Rocket class="w-4 h-4" :class="{ 'animate-pulse': deploying }" />{{ deploying ? '部署中...' : '确认部署…' }}
          </button>
        </div>
      </section>

      <!-- 部署预演 -->
      <section class="section-panel">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><h2 class="section-title">部署预演</h2><p class="mt-1 text-muted">部署将创建、重建、移除的容器,以及受影响的卷与端口</p></div>
          <span class="count-badge" :class="deployImpactCount ? 'text-amber-300' : 'text-emerald-300'">{{ deployImpactCount ? `${deployImpactCount} 项影响` : '无影响' }}</span>
        </div>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
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

      <!-- 部署预言(宿主实况) -->
      <section class="section-panel">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><h2 class="section-title">宿主检查</h2><p class="mt-1 text-muted">对照宿主真实状态推演 up:镜像是否在位、端口是否被占、卷与 bind 路径是否存在、哪些容器会重建</p></div>
          <button class="btn-secondary" :disabled="hostPreview.loading || deploying || !reviewReady" @click="runHostPreview"><Telescope class="w-4 h-4" :class="{ 'animate-spin': hostPreview.loading }" />{{ hostPreview.loading ? '推演中...' : '检查宿主' }}</button>
        </div>
        <p v-if="hostPreview.loading" class="sr-only" role="status" aria-live="polite" aria-atomic="true">正在生成宿主实况预演</p>
        <p v-if="hostPreview.error" class="alert-error" role="alert">{{ hostPreview.error }}</p>
        <template v-if="hostPreview.data">
          <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-3 text-center"><div class="text-lg font-semibold text-emerald-300">{{ hostPreview.data.summary.create }}</div><div class="text-xs text-surface-500">将新建</div></div>
            <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-3 text-center"><div class="text-lg font-semibold text-amber-300">{{ hostPreview.data.summary.recreate }}</div><div class="text-xs text-surface-500">将重建</div></div>
            <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-3 text-center"><div class="text-lg font-semibold text-surface-200">{{ hostPreview.data.summary.keep }}</div><div class="text-xs text-surface-500">预计不动</div></div>
            <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-3 text-center"><div class="text-lg font-semibold text-sky-300">{{ hostPreview.data.summary.pulls }}</div><div class="text-xs text-surface-500">需拉取镜像</div></div>
            <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-3 text-center"><div class="text-lg font-semibold" :class="hostPreview.data.summary.conflicts ? 'text-rose-300' : 'text-surface-200'">{{ hostPreview.data.summary.conflicts }}</div><div class="text-xs text-surface-500">端口冲突</div></div>
            <div class="rounded-xl border border-surface-800 bg-surface-950/40 p-3 text-center"><div class="text-lg font-semibold" :class="hostPreview.data.summary.orphan ? 'text-amber-300' : 'text-surface-200'">{{ hostPreview.data.summary.orphan }}</div><div class="text-xs text-surface-500">孤儿容器</div></div>
          </div>
          <div class="mt-3 grid gap-3 md:grid-cols-2">
            <div v-if="hostPreview.data.pullsNeeded.length" class="rounded-xl border border-amber-900/40 bg-amber-950/20 p-3">
              <div class="text-sm font-semibold text-amber-300">本地缺少镜像(up 时将拉取)</div>
              <div class="mt-1.5 flex flex-wrap gap-1.5"><span v-for="img in hostPreview.data.pullsNeeded" :key="img" class="count-badge font-mono text-amber-300">{{ img }}</span></div>
            </div>
            <div v-if="hostPreview.data.conflicts.length" class="rounded-xl border border-rose-900/40 bg-rose-950/20 p-3">
              <div class="text-sm font-semibold text-rose-300">宿主端口已被其他容器占用</div>
              <p v-for="item in hostPreview.data.conflicts" :key="item.port" class="mt-1 text-xs text-surface-300">端口 <b class="font-mono">{{ item.port }}</b> 被 <span class="font-mono">{{ item.holder }}</span> 占用(服务 {{ item.service }})</p>
            </div>
            <div v-if="hostPreview.data.volumeRisks.length" class="rounded-xl border border-violet-900/40 bg-violet-950/20 p-3">
              <div class="text-sm font-semibold text-violet-300">卷风险</div>
              <p v-for="item in hostPreview.data.volumeRisks" :key="item.volume" class="mt-1 text-xs text-surface-300"><span class="font-mono">{{ item.volume }}</span>({{ item.service }}):{{ item.risk }}</p>
            </div>
            <div v-if="hostPreview.data.bindRisks.length" class="rounded-xl border border-amber-900/40 bg-amber-950/20 p-3">
              <div class="text-sm font-semibold text-amber-300">Bind 路径风险</div>
              <p v-for="item in hostPreview.data.bindRisks" :key="item.path" class="mt-1 text-xs text-surface-300"><span class="font-mono">{{ item.path }}</span>({{ item.service }}):{{ item.risk }}</p>
            </div>
          </div>
          <details v-if="hostPreview.data.services?.length" class="mt-3">
            <summary class="cursor-pointer text-xs text-surface-400">逐服务明细({{ hostPreview.data.services.length }})</summary>
            <div class="mt-2 space-y-1">
              <p v-for="item in hostPreview.data.services" :key="item.name" class="flex flex-wrap items-center gap-2 rounded-lg border border-surface-800/60 bg-surface-950/40 px-2.5 py-1.5 text-xs">
                <span class="count-badge" :class="item.action === 'create' ? 'text-emerald-300' : item.action === 'recreate' ? 'text-amber-300' : item.action === 'orphan' ? 'text-rose-300' : 'text-surface-400'">{{ { create: '新建', recreate: '重建', keep: '不动', orphan: '孤儿' }[item.action] || item.action }}</span>
                <b class="font-mono text-surface-200">{{ item.name }}</b>
                <span class="text-surface-500">{{ item.reason }}</span>
              </p>
            </div>
          </details>
          <p v-if="hostPreview.data.aiSummary" class="mt-3 rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-3 text-sm leading-6 text-emerald-200"><Bot class="mr-1.5 inline h-4 w-4" />{{ hostPreview.data.aiSummary }}</p>
          <p class="mt-2 text-[11px] text-surface-600">静态推演基于 compose config 与宿主实况,容器级最终行为以实际 up 输出为准。</p>
        </template>
        <div v-else-if="!hostPreview.loading && !hostPreview.error" class="rounded-xl border border-dashed border-surface-700 p-4 text-center text-sm text-surface-500">点击"检查宿主"对照宿主实况推演本次部署</div>
      </section>

      <!-- 语义校验 -->
      <section class="section-panel">
        <div class="mb-4"><h2 class="section-title">语义校验</h2><p class="mt-1 text-muted">静态分析 depends_on、links、端口冲突、镜像声明等</p></div>
        <div v-if="!issues.length" class="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-4 text-sm text-emerald-300">✓ 未发现语义问题,配置结构健康</div>
        <div v-else class="space-y-2">
          <div v-for="(issue, idx) in issues" :key="idx" class="flex items-start gap-3 rounded-xl border p-3" :class="issue.level === 'error' ? 'border-rose-900/40 bg-rose-950/20' : issue.level === 'warn' ? 'border-amber-900/40 bg-amber-950/20' : 'border-sky-900/40 bg-sky-950/20'">
            <span class="mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold" :class="issue.level === 'error' ? 'bg-rose-500/20 text-rose-300' : issue.level === 'warn' ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300'">{{ issue.level === 'error' ? '错误' : issue.level === 'warn' ? '警告' : '提示' }}</span>
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

      <!-- 规则建议 -->
      <section class="section-panel">
        <div class="mb-4"><h2 class="section-title">规则检查建议</h2><p class="mt-1 text-muted">基于配置语义、容器差异与端口映射生成；分数不代表部署成功率。</p></div>
        <div class="space-y-2">
          <div v-for="(advice, idx) in ruleAdvice" :key="idx" class="flex items-start gap-3 rounded-xl border border-surface-800 bg-surface-950/40 p-3">
            <span class="mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold" :class="advice.tone === 'danger' ? 'bg-rose-500/20 text-rose-300' : advice.tone === 'warning' ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'">{{ advice.tag }}</span>
            <p class="text-sm text-surface-200">{{ advice.text }}</p>
          </div>
        </div>
      </section>
    </template>

    <!-- 部署确认门 -->
    <BaseModal :show="showDeployConfirm" title="确认部署" size-class="max-w-[calc(100vw-2rem)] sm:max-w-lg" body-class="p-4 space-y-3" @close="closeDeployConfirm">
      <p class="text-sm text-surface-300">将按当前配置对项目 <b class="text-surface-100">{{ pendingDeploy?.projectName }}</b> 执行部署。预演影响:</p>
      <div class="grid grid-cols-2 gap-2 text-sm">
        <div class="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-2.5"><span class="text-emerald-300">创建 {{ preview.added.length }}</span></div>
        <div class="rounded-lg border border-amber-900/40 bg-amber-950/20 p-2.5"><span class="text-amber-300">重建 {{ preview.changed.length }}</span></div>
        <div class="rounded-lg border border-sky-900/40 bg-sky-950/20 p-2.5"><span class="text-sky-300">重启 {{ preview.restarted.length }}</span></div>
        <div class="rounded-lg border border-rose-900/40 bg-rose-950/20 p-2.5"><span class="text-rose-300">移除 {{ preview.removed.length }}</span></div>
      </div>
      <p v-if="preview.removed.length" class="text-xs text-rose-300">有服务将被移除,部署后对应容器会停止。</p>
      <p v-if="preview.portConflicts.length" class="text-xs text-amber-300">存在 {{ preview.portConflicts.length }} 处端口映射,请确认宿主机端口可用。</p>
      <template #footer>
        <button class="btn-secondary" @click="closeDeployConfirm">取消</button>
        <button class="btn-primary" :disabled="!canDeploy || !pendingDeploy" @click="confirmDeploy"><Rocket class="w-4 h-4" />{{ deploying ? '部署中...' : '确认部署' }}</button>
      </template>
    </BaseModal>

    <!-- 部署输出抽屉 -->
    <BaseModal :show="deployOutput.open" :title="`部署输出 · ${deployOutput.projectName || ''}`" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[80vh] flex-col" body-class="flex min-h-0 flex-1 flex-col p-0" @close="deployOutput.open = false">
      <template #header-actions>
        <span v-if="deployOutput.open" role="status" aria-live="polite" aria-atomic="true" class="count-badge" :class="deployOutput.running ? 'text-sky-300' : deployOutput.status === 'failed' ? 'text-rose-300' : deployOutput.status === 'cancelled' || deployOutput.status === 'unknown' ? 'text-amber-300' : 'text-emerald-300'">{{ deployOutput.running ? '部署执行中' : deployOutput.status === 'failed' ? '部署失败' : deployOutput.status === 'cancelled' ? '部署已中断' : deployOutput.status === 'unknown' ? '部署结果未确认' : '部署完成' }}</span>
      </template>
      <pre class="terminal-output max-h-[70vh] min-h-48 flex-1 overflow-auto p-4" role="region" aria-label="部署执行输出" tabindex="0" aria-live="off" :aria-busy="deployOutput.running">{{ deployOutput.text || '等待输出...' }}</pre>
      <template #footer>
        <button class="btn-secondary" @click="deployOutput.open = false">关闭</button>
      </template>
    </BaseModal>
  </div>
</template>

<script setup>
// embedded 模式供 ReleaseView 的 tab 复用,隐藏独立页头
defineProps({ embedded: { type: Boolean, default: false } });
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { Bot, RefreshCw, Rocket, ShieldCheck, Telescope } from 'lucide-vue-next';
import { api, streamComposeControl } from '../api/client.js';
import { useServicesStore } from '../stores/services.js';
import EmptyState from '../components/common/EmptyState.vue';
import BaseModal from '../components/common/BaseModal.vue';

const emit = defineEmits(['busy']);
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
const deployOutput = ref({ open: false, text: '', running: false, status: 'completed' });
let deployController = null;
const hostPreview = ref({ loading: false, error: '', data: null });
const reviewed = ref(null);
const pendingDeploy = ref(null);
let requestVersion = 0;
let hostPreviewVersion = 0;
const active = ref(true);
let disposed = false;
const reviewReady = computed(() => !!reviewed.value && reviewed.value.projectId === selectedProjectId.value && !loading.value && !error.value);
const canDeploy = computed(() => active.value && reviewReady.value && !deploying.value && errorCount.value === 0);
const checkedTime = computed(() => reviewed.value ? new Date(reviewed.value.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '');
watch(deploying, value => emit('busy', value), { flush: 'sync' });
function closeDeployConfirm() { showDeployConfirm.value = false; pendingDeploy.value = null; }
function current(version, id) { return active.value && !disposed && version === requestVersion && id === selectedProjectId.value; }


async function runHostPreview() {
  if (!reviewReady.value || hostPreview.value.loading || deploying.value) return;
  const snapshot = reviewed.value;
  const version = ++hostPreviewVersion;
  hostPreview.value = { loading: true, error: '', data: null };
  const valid = () => active.value && !disposed && version === hostPreviewVersion && reviewed.value === snapshot;
  try {
    const data = await api.previewDeploy(snapshot.projectId, false);
    if (valid()) hostPreview.value.data = data;
  } catch (e) {
    if (valid()) hostPreview.value.error = `宿主检查失败:${e.message}`;
  } finally {
    if (valid()) hostPreview.value.loading = false;
  }
}

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
  return parts.length ? `检测到:${parts.join('、')}` : '规则检查未发现阻断项，请核对部署影响';
});

const ruleAdvice = computed(() => {
  const advice = [];
  if (errorCount.value) advice.push({ tone: 'danger', tag: '阻断', text: `存在 ${errorCount.value} 个语义错误,建议修复后再部署,否则可能导致服务无法启动。` });
  if (preview.value.removed.length) advice.push({ tone: 'danger', tag: '删除', text: `${preview.value.removed.length} 个服务将从 Compose 中移除,对应容器会被停止。请确认这些服务不再需要。` });
  if (preview.value.portConflicts.length) advice.push({ tone: 'danger', tag: '端口', text: `检测到 ${preview.value.portConflicts.length} 处端口映射,可能存在宿主机端口占用风险。` });
  if (preview.value.changed.length) advice.push({ tone: 'warning', tag: '重建', text: `${preview.value.changed.length} 个服务因镜像/环境/卷/端口变化将被重建,期间会有短暂不可用。` });
  if (preview.value.restarted.length) advice.push({ tone: 'warning', tag: '重启', text: `${preview.value.restarted.length} 个运行中容器将重启,建议在低峰期执行。` });
  if (warningCount.value) advice.push({ tone: 'warning', tag: '警告', text: `存在 ${warningCount.value} 个警告,建议检查镜像声明与环境变量定义。` });
  if (!advice.length) advice.push({ tone: 'success', tag: '通过', text: '当前规则未发现阻断项。宿主环境与实际启动结果仍需核对。' });
  return advice;
});

async function loadProject() {
  if (!active.value || disposed || deploying.value) return;
  const id = selectedProjectId.value;
  const version = ++requestVersion;
  ++hostPreviewVersion;
  closeDeployConfirm();
  reviewed.value = null;
  loading.value = !!id;
  error.value = '';
  issues.value = [];
  preview.value = { added: [], changed: [], restarted: [], removed: [], portConflicts: [] };
  services.value = [];
  hostPreview.value = { loading: false, error: '', data: null };
  if (!id) return;
  try {
    const data = await api.getComposeFile(id, 0, true);
    if (!current(version, id)) return;
    const content = data.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('配置内容为空，请先检查 Compose 文件');
    const [validateResult, previewResult] = await Promise.all([
      api.validateCompose(id, 0, content),
      api.previewCompose(id, content),
    ]);
    if (!current(version, id)) return;
    if (!Array.isArray(validateResult?.issues) || !previewResult || !['added', 'changed', 'restarted', 'removed', 'portConflicts'].every(key => Array.isArray(previewResult[key]))) {
      throw new Error('检查结果不完整，请重试');
    }
    const parsed = (await import('yaml')).parse(content);
    if (!current(version, id)) return;
    issues.value = validateResult.issues;
    preview.value = previewResult;
    services.value = Object.entries(parsed?.services || {}).map(([name, cfg]) => ({ name, volumes: cfg?.volumes || [] }));
    reviewed.value = { projectId: id, projectName: project.value?.projectName || id, content, hostId: data.hostId, checkedAt: Date.now() };
  } catch (e) {
    if (current(version, id)) error.value = `变更评审失败: ${e.message}`;
  } finally {
    if (current(version, id)) loading.value = false;
  }
}

function openDeployConfirm() {
  if (!canDeploy.value) return;
  pendingDeploy.value = reviewed.value;
  showDeployConfirm.value = true;
}

async function confirmDeploy() {
  if (!canDeploy.value || !pendingDeploy.value || pendingDeploy.value !== reviewed.value) return;
  const snapshot = pendingDeploy.value;
  const version = requestVersion;
  closeDeployConfirm();
  deploying.value = true;
  deployOutput.value = { open: true, text: '', running: true, status: 'running', projectName: snapshot.projectName };
  deployController?.abort();
  deployController = new AbortController();
  let exitCode = null;
  let streamReportedError = false;
  try {
    const latest = await api.getComposeFile(snapshot.projectId, 0, true);
    if (!current(version, snapshot.projectId)) throw new Error('评审上下文已变化，本次未部署。请重新评审。');
    if (latest.content !== snapshot.content || latest.hostId !== snapshot.hostId) {
      reviewed.value = null;
      error.value = '配置或节点已变化，本次未部署。请重新评审。';
      throw new Error(error.value);
    }
    await streamComposeControl(snapshot.projectId, 'up', (frame) => {
      if (disposed) return;
      if (frame.type === 'stdout' || frame.type === 'stderr') deployOutput.value.text += frame.data;
      else if (frame.type === 'error') {
        streamReportedError = true;
        deployOutput.value.text += `\n[错误] ${frame.data}`;
      }
      else if (frame.type === 'exit') {
        exitCode = Number(frame.data?.code);
        deployOutput.value.text += `\n[退出码 ${frame.data.code}]`;
      }
    }, null, { action: 'up', expectedHostId: snapshot.hostId, expectedContent: snapshot.content }, deployController.signal);
    if (streamReportedError || exitCode !== 0) {
      deployOutput.value.status = exitCode === null && !streamReportedError ? 'unknown' : 'failed';
      if (exitCode === null && !streamReportedError) deployOutput.value.text += '\n[未收到 Compose 退出码，部署结果未确认]';
      return;
    }
    deployOutput.value.status = 'completed';
    try { await store.refresh(true); } catch (refreshError) {
      // 部署命令已经以退出码 0 结束;后续状态刷新失败不能倒置部署结果。
      deployOutput.value.text += `\n[部署已完成，但刷新项目状态失败] ${refreshError.message}`;
    }
  } catch (e) {
    if (e.name === 'AbortError') deployOutput.value.status = 'unknown';
    else {
      if (deployOutput.value.status !== 'completed') deployOutput.value.status = 'failed';
      deployOutput.value.text += `\n[请求失败] ${e.message}`;
    }
  } finally {
    deployController = null;
    reviewed.value = null;
    deploying.value = false;
    deployOutput.value.running = false;
  }
}

function invalidateContext() {
  requestVersion += 1;
  hostPreviewVersion += 1;
  closeDeployConfirm();
  reviewed.value = null;
  loading.value = false;
  hostPreview.value = { loading: false, error: '', data: null };
}
function onHostChanged() {
  invalidateContext();
  selectedProjectId.value = '';
  error.value = '节点已变化，请重新选择项目进行评审。';
  deployController?.abort();
}
function deactivate() {
  active.value = false;
  requestVersion += 1;
  hostPreviewVersion += 1;
  closeDeployConfirm();
  if (loading.value) reviewed.value = null;
  loading.value = false;
  hostPreview.value.loading = false;
  deployOutput.value.open = false;
}
onActivated(() => { active.value = true; if (selectedProjectId.value && !reviewed.value && !deploying.value) void loadProject(); });
onDeactivated(deactivate);
onBeforeUnmount(() => {
  disposed = true;
  deactivate();
  deployController?.abort();
  window.removeEventListener('composeops:host-changed', onHostChanged);
  emit('busy', false);
});
usePullRefresh(loadProject, { keepAlive: true, enabled: () => !deploying.value });
onMounted(async () => {
  window.addEventListener('composeops:host-changed', onHostChanged);
  await store.refresh(false);
  if (!disposed && store.error) error.value = `项目列表加载失败: ${store.error}`;
});
</script>
