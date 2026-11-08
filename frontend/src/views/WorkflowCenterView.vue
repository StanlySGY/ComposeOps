<template>
  <div class="page-shell">
    <div class="page-header">
      <div><h1 class="page-title">工作流中心</h1><p class="page-subtitle">把日常运维串成清晰的步骤，在关键动作前确认，在结束后核对结果</p></div>
      <div class="page-actions"><button class="btn-primary" :disabled="globalBusy" @click="openCreate"><Plus class="w-4 h-4" />新建工作流</button><button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button></div>
    </div>
    <section class="workflow-overview" aria-label="工作流概览">
      <div class="min-w-0"><p class="workflow-eyebrow"><GitBranch class="h-3.5 w-3.5" />每一步，都有来处与结果</p><h2 class="mt-3 text-lg font-medium text-surface-100">把重复操作，变成可检查的流程</h2><p class="mt-2 text-sm leading-6 text-surface-400">先编排，再运行。审批会固定本次动作和目标项目，处理后可追踪执行状态。</p><div class="workflow-overview-stats"><span><b>{{ definitions.length }}</b> 个工作流</span><span><b>{{ runningCount }}</b> 个运行中</span><button :disabled="!waitingCount" @click="instanceFilter = 'waiting_approval'; instanceSection?.scrollIntoView({ block: 'start' })"><b>{{ waitingCount }}</b> 个待审批<ChevronRight class="h-3.5 w-3.5" /></button></div></div>
      <SceneIllustration kind="schedule" :min-width="768" class="workflow-art" sizes="200px" eager />
    </section>
    <p v-if="feedback" ref="feedbackEl" tabindex="-1" role="status" class="workflow-success"><CheckCircle2 class="h-4 w-4 shrink-0" />{{ feedback }}</p>
    <section class="section-panel" :aria-busy="definitionsLoading">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 class="section-title">工作流定义</h2><p class="mt-1 text-muted">可重复运行的步骤与审批顺序</p></div><label class="workflow-search"><Search class="h-4 w-4" /><input v-model="search" aria-label="搜索工作流定义" type="search" placeholder="搜索名称或描述" /></label></div>
      <p v-if="definitionsError" class="alert-error mb-3" role="alert"><span class="min-w-0 flex-1">工作流读取失败：{{ definitionsError }}</span><button class="text-link shrink-0" :disabled="definitionsLoading" @click="store.loadDefinitions()">重试工作流</button></p>
      <p v-if="definitionsLoading && !definitions.length" class="text-muted py-8 text-center" role="status">正在加载工作流…</p>
      <div class="grid gap-3 lg:grid-cols-2">
        <article v-for="def in filteredDefinitions" :key="def.id" class="workflow-definition" :aria-label="`工作流 ${def.name}`">
          <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h3 class="break-words text-sm font-semibold text-surface-100">{{ def.name }}</h3><p class="mt-1 break-words text-xs leading-5 text-surface-400">{{ def.description || '暂无描述' }}</p></div><span class="count-badge shrink-0" :class="def.enabled ? 'text-status-ok' : 'text-surface-400'">{{ def.enabled ? '启用' : '停用' }}</span></div>
          <ol class="workflow-node-track" aria-label="步骤顺序"><li v-for="(node, index) in def.nodes" :key="node.id" :title="node.id"><span>{{ index + 1 }}</span>{{ nodeLabel(node.type) }}<span v-if="node.config?.action" class="workflow-action-label">{{ actionLabel(node.config.action) }}</span><ArrowRight v-if="index < def.nodes.length - 1" class="h-3 w-3 text-surface-600" /></li></ol>
          <p class="text-xs text-surface-500">{{ {manual: '手动触发', cron: '定时触发', event: '事件触发'}[def.triggerType] || '手动触发' }} · {{ def.nodes.length }} 个节点<span v-if="def.nodes.some(node => node.next || node.onTrue || node.onFalse)"> · 含条件跳转，执行顺序以跳转目标为准</span></p>
          <div v-if="definitionFeedback[def.id]?.text" class="workflow-row-feedback" :class="{ 'is-error': definitionFeedback[def.id].error }" :role="definitionFeedback[def.id].error ? 'alert' : 'status'"><p>{{ definitionFeedback[def.id].text }}</p><button v-if="!definitionFeedback[def.id].error && !definitionBusy[def.id]" class="text-link mt-2" @click="showRuns">查看运行记录<ArrowRight class="h-3 w-3" /></button></div>
          <div class="mt-auto flex flex-wrap gap-2 border-t border-surface-800 pt-3"><button class="btn-primary flex-1 btn-sm" :disabled="!def.enabled || globalBusy || definitionBusy[def.id]" @click="run(def)"><LoaderCircle v-if="definitionBusy[def.id]" class="h-3.5 w-3.5 animate-spin" /><Play v-else class="h-3.5 w-3.5" />{{ definitionBusy[def.id] ? '启动中…' : '运行' }}</button><button class="btn-secondary btn-sm" :disabled="globalBusy || definitionBusy[def.id]" @click="openEdit(def)"><Pencil class="h-3.5 w-3.5" />编辑</button><button class="btn-ghost btn-sm" :disabled="globalBusy || definitionBusy[def.id]" @click="selectDelete(def)"><Trash2 class="h-3.5 w-3.5" />删除</button></div>
        </article>
      </div>
      <EmptyState v-if="!definitionsLoading && !definitionsError && !definitions.length" compact title="还没有工作流" description="将常用操作编排成可重复运行的流程。" action-label="新建工作流" @action="openCreate" />
      <EmptyState v-else-if="definitions.length && !filteredDefinitions.length" compact icon="Search" title="没有匹配的工作流" description="试试其他名称或清空搜索条件。" action-label="清空搜索" @action="search = ''" />
    </section>
    <section ref="instanceSection" tabindex="-1" class="section-panel workflow-instance-section" :aria-busy="instancesLoading">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 class="section-title">运行实例</h2><p class="mt-1 text-muted">最近 100 条运行记录 · 活动实例每 5 秒自动刷新</p></div><label class="workflow-status-filter">状态<select v-model="instanceFilter" class="input input-sm" aria-label="筛选运行状态"><option value="">全部状态</option><option v-for="status in ['pending','waiting_approval','running','success','failed','cancelled','outcome_unknown']" :key="status" :value="status">{{ instanceLabel(status) }}</option></select></label></div>
      <p v-if="instancesError" class="alert-error mb-3" role="alert"><span class="min-w-0 flex-1">运行记录读取失败：{{ instancesError }}。保留上次结果。</span><button class="text-link shrink-0" :disabled="instancesLoading" @click="store.loadInstances()">重试实例</button></p>
      <p v-if="instancesLoading && !instances.length" class="text-muted py-8 text-center" role="status">正在加载运行记录…</p>
      <div class="space-y-3">
        <article v-for="inst in filteredInstances" :key="inst.id" class="workflow-instance" :class="{ 'is-waiting': inst.status === 'waiting_approval' }" :aria-label="`运行实例 ${inst.name}`">
          <div class="workflow-instance-heading"><div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h3 class="break-words text-sm font-medium">{{ inst.name }}</h3><span class="status-badge" :class="instanceTone(inst.status)">{{ instanceLabel(inst.status) }}</span></div><p class="mt-2 text-xs text-surface-400">{{ formatTime(inst.createdAt) }}<span class="mx-2 text-surface-600">·</span>当前节点 {{ inst.currentNode || '—' }}</p><p class="mt-1 break-all font-mono text-[10px] text-surface-500">{{ inst.id }}</p></div><button class="btn-secondary btn-sm shrink-0" @click="openDetail(inst)"><History class="h-3.5 w-3.5" />步骤详情</button></div>
          <div v-if="inst.status === 'waiting_approval'" class="workflow-approval">
            <template v-if="inst.context?.pendingApprovalIntent"><p class="text-xs font-medium text-status-warn">等待你确认</p><p v-if="inst.context.pendingApprovalIntent.actionIntent" class="mt-1.5 text-sm leading-6">{{ actionLabel(inst.context.pendingApprovalIntent.actionIntent.action) }} · 项目 {{ projectName(inst.context.pendingApprovalIntent.actionIntent.projectId) }}</p><p v-else class="mt-1.5 text-xs leading-5 text-surface-300">此审批节点后没有可识别的执行动作，请查看步骤详情后决定。</p><p class="mt-1 text-xs leading-5 text-surface-400">批准后将继续执行这次运行，定义或目标改变时需重新审批。</p></template>
            <p v-else class="text-xs leading-5 text-status-error">缺少审批意图快照。请取消此旧实例并重新运行。</p>
          </div>
          <div v-if="instanceFeedback[inst.id]?.text" class="workflow-row-feedback" :class="{ 'is-error': instanceFeedback[inst.id].error }" :role="instanceFeedback[inst.id].error ? 'alert' : 'status'">{{ instanceFeedback[inst.id].text }}</div>
          <div v-if="activeStatuses.includes(inst.status)" class="flex flex-wrap items-center gap-2"><button v-if="inst.status === 'waiting_approval'" class="btn-primary btn-sm" :disabled="globalBusy || !!instanceBusy[inst.id] || !inst.context?.pendingApprovalIntent" @click="approve(inst, true)">通过审批</button><button v-if="inst.status === 'waiting_approval'" class="btn-secondary btn-sm" :disabled="globalBusy || !!instanceBusy[inst.id]" @click="approve(inst, false)">拒绝</button><button class="btn-ghost btn-sm" :disabled="globalBusy || !!instanceBusy[inst.id]" :aria-label="`取消工作流 ${inst.name}`" @click="cancel(inst)">取消实例</button><span v-if="instanceBusy[inst.id]" class="flex items-center gap-1 text-xs text-surface-400" role="status"><LoaderCircle class="h-3.5 w-3.5 animate-spin" />{{ instanceBusy[inst.id] }}</span></div>
        </article>
      </div>
      <EmptyState v-if="!instancesLoading && !instancesError && !instances.length" compact title="暂无运行实例" description="运行一个已启用的工作流后，可在这里查看状态和审批。" action-label="刷新实例" @action="store.loadInstances()" />
      <EmptyState v-else-if="instances.length && !filteredInstances.length" compact icon="Search" title="此状态下暂无运行记录" description="可切换到全部状态查看其他运行。" action-label="查看全部" @action="instanceFilter = ''" />
    </section>
    <BaseModal :show="!!selectedInstance" title="运行步骤详情" size-class="sm:max-w-2xl flex max-h-[85dvh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4 space-y-3" @close="closeDetail">
      <p v-if="detailLoading" class="text-muted" role="status">正在读取执行步骤…</p><p v-if="detailError" class="alert-error" role="alert"><span class="min-w-0 flex-1">{{ detailError }}</span><button class="text-link shrink-0" @click="openDetail(selectedInstance)">重试详情</button></p>
      <template v-if="detail"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="min-w-0 break-words text-sm font-medium">{{ detail.name }}</h3><span class="status-badge" :class="instanceTone(detail.status)">{{ instanceLabel(detail.status) }}</span></div><p class="break-all text-xs text-surface-400">{{ detail.id }} · {{ formatTime(detail.createdAt) }}</p><ol class="space-y-2"><li v-for="(step, index) in detail.steps || []" :key="step.id" class="workflow-step"><span class="workflow-step-index">{{ index + 1 }}</span><div class="min-w-0 flex-1"><div class="flex flex-wrap gap-2 text-xs"><b>{{ nodeLabel(step.nodeType) }}</b><span class="text-surface-400 break-all">{{ step.nodeId }}</span><span :class="instanceTone(step.status)" class="status-badge">{{ instanceLabel(step.status) }}</span></div><p class="mt-2 text-xs text-surface-500">{{ formatTime(step.startedAt) }}<span v-if="step.finishedAt"> → {{ formatTime(step.finishedAt) }}</span></p><p v-if="step.error" class="mt-2 break-words text-xs text-status-error">{{ step.error }}</p><details v-if="step.output && Object.keys(step.output).length" class="mt-2 text-xs text-surface-400"><summary>查看步骤输出</summary><pre class="mt-2 whitespace-pre-wrap break-all rounded-md bg-surface-950 p-2">{{ JSON.stringify(step.output, null, 2) }}</pre></details></div></li></ol><p v-if="!detail.steps?.length" class="text-muted">此实例暂未记录执行步骤。</p></template>
      <template #footer><button class="btn-secondary" :disabled="detailLoading" @click="openDetail(selectedInstance)"><RefreshCw class="h-3.5 w-3.5" />刷新详情</button><button class="btn-primary" @click="closeDetail">关闭</button></template>
    </BaseModal>
    <!-- 新建/编辑弹窗 -->
    <BaseModal :show="showEditor" :title="editingId ? '编辑工作流' : '新建工作流'" :close-disabled="saving" size-class="sm:max-w-2xl flex max-h-[90dvh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto space-y-3 p-5 pt-0" @close="showEditor = false">
      <p v-if="projectsError" class="alert-error" role="alert"><span class="min-w-0 flex-1">项目读取失败：{{ projectsError }}</span><button class="text-link shrink-0" :disabled="projectsLoading" @click="loadProjects">重试项目</button></p>
      <p v-if="projectsLoading" class="text-xs text-surface-400" role="status">正在读取可选项目…</p>
      <fieldset ref="editorBodyRef" :disabled="saving" :aria-busy="saving" class="min-w-0 space-y-3">
          <div>
            <label class="form-label" for="workflow-name">名称</label>
            <input id="workflow-name" v-model="form.name" v-bind="fieldErrorProps('workflow-name')" class="input" placeholder="如:故障自动处理" />
          </div>
          <div>
            <label class="form-label" for="workflow-description">描述</label>
            <input id="workflow-description" v-model="form.description" class="input" placeholder="流程说明" />
          </div>
          <div>
            <label class="form-label" for="workflow-trigger-type">触发方式</label>
            <select id="workflow-trigger-type" v-model="form.triggerType" class="input" @change="normalizeTriggerConfig">
              <option value="manual">手动</option>
              <option value="cron">定时</option>
              <option value="event">事件</option>
            </select>
          </div>
          <div v-if="form.triggerType === 'event'" class="grid gap-2 rounded-lg border border-surface-800 bg-surface-950/40 p-3 sm:grid-cols-2">
            <label class="form-grid-label sm:col-span-2"><span>事件类型(必填，逗号分隔)</span><input id="workflow-event-types" v-model="form.triggerConfig.eventTypes" v-bind="fieldErrorProps('workflow-event-types')" class="input" placeholder="container, alert, gitops" /></label>
            <label class="form-grid-label"><span>来源(可选)</span><input v-model="form.triggerConfig.sources" class="input" placeholder="docker, alert" /></label>
            <label class="form-grid-label"><span>动作(可选)</span><input v-model="form.triggerConfig.actions" class="input" placeholder="die, health_status: unhealthy" /></label>
            <label class="form-grid-label sm:col-span-2"><span>项目 ID(可选，限制到一个纳管项目)</span><input v-model="form.triggerConfig.projectId" class="input" aria-label="不填则匹配所选事件类型的所有纳管项目" placeholder="不填则匹配所选事件类型的所有纳管项目" /></label>
            <p class="sm:col-span-2 text-xs text-surface-400">事件必须显式选择类型。工作流自身事件不会再次触发工作流；Docker、告警和统一事件中心事件均经过去重。</p>
          </div>
          <div v-else-if="form.triggerType === 'cron'" class="grid gap-2 rounded-lg border border-surface-800 bg-surface-950/40 p-3 sm:grid-cols-2">
            <label class="form-grid-label"><span>Cron 表达式(必填)</span><input id="workflow-cron" v-model="form.triggerConfig.cron" v-bind="fieldErrorProps('workflow-cron')" class="input font-mono" placeholder="*/5 * * * *" /></label>
            <label class="form-grid-label"><span>项目 ID(可选)</span><select v-model="form.triggerConfig.projectId" class="input"><option value="">使用工作流运行上下文</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
            <p class="sm:col-span-2 text-xs text-surface-400">按服务端本地时区执行，同一分钟最多触发一次。项目可以在每个执行节点中单独指定。</p>
          </div>
          <div>
            <label class="form-label">节点编排</label>
            <div class="space-y-2">
              <div v-for="(node, i) in form.nodes" :key="i" class="rounded-lg border border-surface-800 bg-surface-900/60 p-3">
                <div class="workflow-node-editor">
                  <span class="count-badge shrink-0 text-surface-400">{{ nodeLabel(node.type) }}</span>
                  <input :id="`workflow-node-${i}-id`" v-model="node.id" v-bind="fieldErrorProps(`workflow-node-${i}-id`)" class="input input-sm" :aria-label="`第 ${i + 1} 个节点 ID`" placeholder="节点 ID" />
                  <select v-model="node.type" class="input input-sm" :aria-label="`第 ${i + 1} 个节点类型`" @change="normalizeNode(node)">
                    <option value="trigger">触发</option>
                    <option value="condition">条件</option>
                    <option value="agent">Agent</option>
                    <option value="approval">审批</option>
                    <option value="action">执行</option>
                    <option value="verify">验证</option>
                  </select>
                  <button class="icon-btn h-7! w-7!" title="删除节点" :aria-label="`删除节点 ${i + 1}`" @click="form.nodes.splice(i, 1)"><X class="w-4 h-4" /></button>
                </div>
                <div class="mt-2 grid gap-2 sm:grid-cols-3">
                  <label class="form-grid-label sm:col-span-3"><span>下一节点(可选)</span><input v-model="node.next" class="input input-sm" list="workflow-node-ids" aria-label="留空按列表顺序执行" placeholder="留空按列表顺序执行" /></label>
                  <template v-if="node.type === 'condition'">
                    <label class="form-grid-label sm:col-span-3"><span>条件表达式</span><input :id="`workflow-node-${i}-expression`" v-model="node.config.expression" v-bind="fieldErrorProps(`workflow-node-${i}-expression`)" class="input input-sm" placeholder="如: context.verified == true" /></label>
                    <label class="form-grid-label"><span>满足时跳转</span><input v-model="node.onTrue" class="input input-sm" list="workflow-node-ids" placeholder="节点 ID" /></label>
                    <label class="form-grid-label"><span>不满足时跳转</span><input v-model="node.onFalse" class="input input-sm" list="workflow-node-ids" placeholder="节点 ID" /></label>
                  </template>
                  <template v-else-if="node.type === 'agent'">
                    <label class="form-grid-label sm:col-span-3"><span>分析提示词</span><textarea v-model="node.config.prompt" class="input input-sm" rows="2" aria-label="请分析当前运维上下文并给出建议" placeholder="请分析当前运维上下文并给出建议" /></label>
                    <label class="form-grid-label sm:col-span-3"><span>项目(可选)</span><select v-model="node.config.projectId" class="input input-sm"><option value="">使用运行上下文</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
                  </template>
                  <template v-else-if="node.type === 'action'">
                    <label class="form-grid-label"><span>操作</span><select :id="`workflow-node-${i}-action`" v-model="node.config.action" v-bind="fieldErrorProps(`workflow-node-${i}-action`)" class="input input-sm"><option value="">选择操作</option><option value="up">启动</option><option value="stop">停止</option><option value="restart">重启</option><option value="pull">拉取镜像</option></select></label>
                    <label class="form-grid-label sm:col-span-2"><span>项目</span><select :id="`workflow-node-${i}-project`" v-model="node.config.projectId" v-bind="fieldErrorProps(`workflow-node-${i}-project`)" class="input input-sm"><option value="">选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
                  </template>
                  <template v-else-if="node.type === 'verify'">
                    <label class="form-grid-label sm:col-span-3"><span>项目(可选)</span><select v-model="node.config.projectId" class="input input-sm"><option value="">使用运行上下文</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
                  </template>
                </div>
              </div>
            </div>
            <datalist id="workflow-node-ids"><option v-for="node in form.nodes" :key="node.id" :value="node.id" /></datalist>
            <button class="btn-secondary mt-2 btn-sm" @click="addNode"><Plus class="w-3.5 h-3.5" />添加节点</button>
          </div>
        </fieldset>
        <template #footer>
          <div class="w-full space-y-2">
            <p v-if="editorError" id="workflow-editor-error" ref="editorErrorRef" role="alert" tabindex="-1" class="rounded-lg border border-status-error/20 bg-status-error/10 px-3 py-2 text-xs text-status-error">{{ editorError }}</p>
            <div class="flex justify-end gap-2">
              <button class="btn-secondary" :disabled="saving" @click="showEditor = false">取消</button>
              <button class="btn-primary" :disabled="saving" @click="save"><LoaderCircle v-if="saving" class="h-4 w-4 animate-spin" />{{ saving ? '保存中…' : '保存' }}</button>
            </div>
          </div>
        </template>
    </BaseModal>
    <ConfirmDialog :show="!!deleteTarget" title="删除工作流" :message="`确认删除工作流「${deleteTarget?.name}」？它的全部运行实例与步骤历史也会被删除，无法恢复。仍有运行或待审批实例时不能删除。`" tone="danger" :busy="deleteBusy" :confirm-text="deleteBusy ? '删除中…' : '删除'" @confirm="confirmRemove" @cancel="!deleteBusy && (deleteTarget = null)"><p v-if="deleteError" role="alert" class="text-xs text-status-error">{{ deleteError }}</p></ConfirmDialog>
  </div>
</template>

<script setup>
import EmptyState from '../components/common/EmptyState.vue';
import { computed, nextTick, onActivated, onDeactivated, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { storeToRefs } from 'pinia';
import { ArrowRight, CheckCircle2, ChevronRight, GitBranch, History, LoaderCircle, Pencil, Play, Plus, RefreshCw, Search, Trash2, X } from 'lucide-vue-next';
import { useWorkflowStore } from '../stores/workflow.js';
import { useToastStore } from '../stores/toast.js';
import { api } from '../api/client.js';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import BaseModal from '../components/common/BaseModal.vue';
import SceneIllustration from '../components/common/SceneIllustration.vue';
import { formatTimestamp } from '../lib/date-time.js';

const store = useWorkflowStore();
const toast = useToastStore();
const showEditor = ref(false);
const editingId = ref('');
const saving = ref(false);
const editorError = ref('');
const editorErrorField = ref('');
const editorBodyRef = ref(null);
const editorErrorRef = ref(null);
const form = reactive({ name: '', description: '', triggerType: 'manual', triggerConfig: {}, nodes: [] });
const projects = ref([]);

const { definitions, instances, loading, definitionsLoading, instancesLoading, definitionsError, instancesError } = storeToRefs(store);
const projectsLoading = ref(false);
const projectsError = ref('');
const definitionBusy = ref({});
const instanceBusy = ref({});
const definitionFeedback = ref({});
const instanceFeedback = ref({});
const deleteBusy = ref(false);
const deleteError = ref('');
const feedback = ref('');
const feedbackEl = ref(null);
const instanceSection = ref(null);
const search = ref('');
const instanceFilter = ref('');
const selectedInstance = ref(null);
const detail = ref(null);
const detailLoading = ref(false);
const detailError = ref('');
const activeStatuses = ['pending', 'running', 'waiting_approval'];
const filteredDefinitions = computed(() => definitions.value.filter(item => !search.value.trim() || [item.name, item.description].some(value => String(value || '').toLowerCase().includes(search.value.trim().toLowerCase()))));
const filteredInstances = computed(() => instances.value.filter(item => !instanceFilter.value || item.status === instanceFilter.value));
const waitingCount = computed(() => instances.value.filter(item => item.status === 'waiting_approval').length);
const runningCount = computed(() => instances.value.filter(item => ['pending', 'running'].includes(item.status)).length);
const globalBusy = computed(() => saving.value || deleteBusy.value);
let active = true;
let contextVersion = 0;
let projectRequest = 0;
let detailRequest = 0;
let editorRequest = 0;
let pollTimer = null;
const current = version => active && contextVersion === version;
function projectName(id) { return projects.value.find(project => project.id === id)?.projectName || id || '运行上下文'; }
function setFeedback(bucket, id, text, error = false) { bucket.value = { ...bucket.value, [id]: { text, error } }; }
async function announce(message) {
  feedback.value = message; toast.success(message); await nextTick();
  feedbackEl.value?.focus({ preventScroll: true }); feedbackEl.value?.scrollIntoView?.({ block: 'nearest' });
}


function nodeLabel(type) {
  return { trigger: '触发', condition: '条件', agent: 'Agent', approval: '审批', action: '执行', verify: '验证' }[type] || type;
}
function instanceLabel(status) {
  return { pending: '待执行', running: '执行中', waiting_approval: '待审批', success: '成功', failed: '失败', cancelled: '已取消', outcome_unknown: '结果待核对' }[status] || status;
}
function actionLabel(action) {
  return { up: '启动', stop: '停止', restart: '重启', pull: '拉取镜像' }[action] || action || '未知动作';
}
function instanceTone(status) {
  if (status === 'success') return 'bg-status-ok/10 text-status-ok';
  if (status === 'failed') return 'bg-status-error/10 text-status-error';
  if (status === 'waiting_approval') return 'bg-status-warn/10 text-status-warn';
  if (status === 'running') return 'bg-sky-500/10 text-sky-400';
  if (status === 'outcome_unknown') return 'bg-status-warn/10 text-status-warn';
  if (status === 'cancelled') return 'bg-surface-800 text-surface-400';
  return 'bg-surface-800 text-surface-400';
}
function formatTime(ts) { return formatTimestamp(ts); }

function normalizeTriggerConfig() {
  if (!form.triggerConfig || typeof form.triggerConfig !== 'object' || Array.isArray(form.triggerConfig)) form.triggerConfig = {};
  if (form.triggerType === 'event' && !String(form.triggerConfig.eventTypes || '').trim()) form.triggerConfig.eventTypes = 'container';
  if (form.triggerType === 'cron' && !String(form.triggerConfig.cron || '').trim()) form.triggerConfig.cron = '*/5 * * * *';
}
function normalizeNode(node) {
  if (!node.config || typeof node.config !== 'object' || Array.isArray(node.config)) node.config = {};
  if (node.type === 'action' && !node.config.action) node.config.action = 'restart';
  return node;
}
function cloneNode(node) {
  return normalizeNode({ ...node, config: { ...(node.config || {}) } });
}

function openCreate() {
  if (!active || globalBusy.value) return;
  editorError.value = ''; editorErrorField.value = '';
  editingId.value = '';
  form.name = '';
  form.description = '';
  form.triggerType = 'manual';
  form.triggerConfig = {};
  form.nodes = [
    { id: 'trigger', type: 'trigger', config: {} },
    { id: 'approval', type: 'approval', config: {} },
    { id: 'action', type: 'action', config: { action: 'restart', projectId: '' } },
  ];
  showEditor.value = true;
}
function openEdit(def) {
  if (!active || globalBusy.value || definitionBusy.value[def.id]) return;
  editorError.value = ''; editorErrorField.value = '';
  editingId.value = def.id;
  form.name = def.name;
  form.description = def.description;
  form.triggerType = def.triggerType;
  form.triggerConfig = { ...(def.triggerConfig || {}) };
  form.nodes = def.nodes.map(cloneNode);
  showEditor.value = true;
}
function addNode() {
  form.nodes.push({ id: `node-${form.nodes.length + 1}`, type: 'action', config: { action: 'restart', projectId: '' } });
}
async function save() {
  if (!active || saving.value) return;
  editorError.value = ''; editorErrorField.value = '';
  if (!form.name.trim()) return reportEditorError('请填写工作流名称', 'workflow-name');
  if (form.triggerType === 'event' && !String(form.triggerConfig.eventTypes || '').trim()) return reportEditorError('事件触发必须选择至少一种事件类型', 'workflow-event-types');
  if (form.triggerType === 'cron' && !String(form.triggerConfig.cron || '').trim()) return reportEditorError('请填写 Cron 表达式', 'workflow-cron');
  const ids = new Set();
  for (const [i, node] of form.nodes.entries()) {
    normalizeNode(node);
    if (!node.id?.trim()) return reportEditorError('每个节点都需要填写 ID', `workflow-node-${i}-id`);
    if (ids.has(node.id)) return reportEditorError(`节点 ID 重复：${node.id}`, `workflow-node-${i}-id`);
    ids.add(node.id);
    if (node.type === 'condition' && !node.config.expression?.trim()) return reportEditorError(`条件节点「${node.id}」需要表达式`, `workflow-node-${i}-expression`);
    if (node.type === 'action' && (!node.config.action || !node.config.projectId)) return reportEditorError(`执行节点「${node.id}」需要选择操作和项目`, `workflow-node-${i}-${!node.config.action ? 'action' : 'project'}`);
  }
  const payload = { ...form, triggerConfig: { ...form.triggerConfig }, nodes: form.nodes.map((node) => ({ ...node, config: { ...node.config } })) };
  const version = contextVersion;
  const request = ++editorRequest;
  const id = editingId.value;
  saving.value = true;
  try {
    if (id) await store.update(id, payload);
    else await store.create(payload);
    if (!current(version) || request !== editorRequest) return;
    showEditor.value = false; search.value = '';
    await announce('工作流已保存，可在定义卡片查看或运行。');
  } catch (e) {
    if (current(version) && request === editorRequest) await reportEditorError(e.message || '保存失败，请重试');
  } finally {
    if (current(version) && request === editorRequest) saving.value = false;
  }
}
function fieldErrorProps(id) {
  return editorErrorField.value === id ? { 'aria-invalid': 'true', 'aria-describedby': 'workflow-editor-error' } : {};
}
async function reportEditorError(message, field = '') {
  editorError.value = message;
  editorErrorField.value = field;
  await nextTick();
  const target = field ? editorBodyRef.value?.querySelector(`#${field}`) : editorErrorRef.value;
  target?.focus({ preventScroll: true });
  target?.scrollIntoView?.({ block: 'nearest' });
}
const deleteTarget = ref(null);
function selectDelete(def) {
  if (!active || globalBusy.value || definitionBusy.value[def.id]) return;
  deleteTarget.value = { ...def }; deleteError.value = '';
}
async function confirmRemove() {
  const def = deleteTarget.value;
  if (!def || !active || globalBusy.value || definitionBusy.value[def.id]) return;
  const version = contextVersion;
  deleteBusy.value = true; deleteError.value = '';
  try {
    await store.remove(def.id);
    if (!current(version)) return;
    deleteTarget.value = null;
    await announce(`工作流「${def.name}」及其运行历史已删除。`);
  } catch (error) { if (current(version)) deleteError.value = error.message || '删除失败，请重试'; }
  finally { if (current(version)) deleteBusy.value = false; }
}
async function run(def) {
  if (!active || !def.enabled || globalBusy.value || definitionBusy.value[def.id]) return;
  const version = contextVersion;
  definitionBusy.value = { ...definitionBusy.value, [def.id]: true };
  setFeedback(definitionFeedback, def.id, '正在创建运行实例…');
  try {
    const instance = await store.run(def.id);
    if (!current(version)) return;
    setFeedback(definitionFeedback, def.id, `运行已受理：${instanceLabel(instance.status)}。可在运行记录查看后续进度。`);
    instanceFilter.value = '';
  } catch (error) { if (current(version)) setFeedback(definitionFeedback, def.id, `运行失败：${error.message}。可重试运行。`, true); }
  finally { if (current(version)) { definitionBusy.value = { ...definitionBusy.value, [def.id]: false }; schedulePoll(); } }
}
async function operateInstance(inst, action, approved) {
  if (!active || globalBusy.value || instanceBusy.value[inst.id]) return;
  if (action === 'approve' && approved && !inst.context?.pendingApprovalIntent) return;
  const version = contextVersion;
  instanceBusy.value = { ...instanceBusy.value, [inst.id]: action === 'cancel' ? '正在取消…' : approved ? '正在通过…' : '正在拒绝…' };
  setFeedback(instanceFeedback, inst.id, '');
  try {
    const result = action === 'cancel' ? await store.cancel(inst.id) : await store.approve(inst.id, { approved });
    if (!current(version)) return;
    const message = action === 'cancel' ? '实例已取消；已经执行的操作不会撤销，请核对服务实际状态。' : approved ? '已通过审批，工作流继续运行，请查看最终结果。' : '已拒绝审批，此实例已取消。';
    setFeedback(instanceFeedback, inst.id, message);
    if (selectedInstance.value === inst.id) detail.value = { ...detail.value, ...result };
    if (instanceFilter.value && instanceFilter.value !== result.status) await announce(message);
  } catch (error) { if (current(version)) setFeedback(instanceFeedback, inst.id, `${action === 'cancel' ? '取消' : '审批'}失败：${error.message}`, true); }
  finally { if (current(version)) { instanceBusy.value = { ...instanceBusy.value, [inst.id]: '' }; schedulePoll(); } }
}
function approve(inst, approved) { return operateInstance(inst, 'approve', approved); }
function cancel(inst) { return operateInstance(inst, 'cancel'); }
async function openDetail(inst) {
  if (!active) return;
  const id = typeof inst === 'string' ? inst : inst.id;
  if (selectedInstance.value !== id) detail.value = null;
  selectedInstance.value = id; detailError.value = ''; detailLoading.value = true;
  const request = ++detailRequest;
  try {
    const data = await api.getWorkflowInstance(id);
    if (active && request === detailRequest && selectedInstance.value === id) detail.value = data.instance;
  } catch (error) { if (active && request === detailRequest && selectedInstance.value === id) detailError.value = error.message || '读取步骤失败'; }
  finally { if (active && request === detailRequest) detailLoading.value = false; }
}
function closeDetail() { ++detailRequest; selectedInstance.value = null; detailLoading.value = false; }
function showRuns() { instanceFilter.value = ''; instanceSection.value?.scrollIntoView?.({ block: 'start', behavior: 'auto' }); instanceSection.value?.focus({ preventScroll: true }); }
async function load() { if (active) await Promise.all([store.loadDefinitions(), store.loadInstances()]); }
async function loadProjects() {
  if (!active) return;
  const request = ++projectRequest; projectsLoading.value = true; projectsError.value = '';
  try {
    const data = await api.getProjects(true);
    if (active && request === projectRequest) projects.value = (data.projects || []).filter(project => project.managed);
  } catch (error) { if (active && request === projectRequest) projectsError.value = error.message || '读取项目失败'; }
  finally { if (active && request === projectRequest) projectsLoading.value = false; }
}
function stopPoll() { clearTimeout(pollTimer); pollTimer = null; }
function schedulePoll() {
  stopPoll();
  if (!active || document.visibilityState === 'hidden' || !instances.value.some(item => activeStatuses.includes(item.status))) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    if (!active || document.visibilityState === 'hidden') return;
    if (!instancesLoading.value && !Object.values(instanceBusy.value).some(Boolean)) await store.loadInstances();
    schedulePoll();
  }, 5000);
}
function invalidateContext() {
  ++contextVersion; ++projectRequest; ++editorRequest; stopPoll(); closeDetail();
  store.invalidateContext();
  showEditor.value = false; saving.value = false; deleteTarget.value = null; deleteBusy.value = false;
  projectsLoading.value = false; definitionBusy.value = {}; instanceBusy.value = {}; definitionFeedback.value = {}; instanceFeedback.value = {}; feedback.value = '';
}
function onHostChanged() { invalidateContext(); projects.value = []; if (active) { void load(); void loadProjects(); } }
function onVisibilityChanged() { schedulePoll(); }
watch(() => instances.value.map(item => `${item.id}:${item.status}`).join('|'), schedulePoll);
usePullRefresh(() => Promise.all([load(), loadProjects()]), { keepAlive: true });
onMounted(() => { void load(); void loadProjects(); window.addEventListener('composeops:host-changed', onHostChanged); document.addEventListener('visibilitychange', onVisibilityChanged); });
let activatedOnce = false;
onActivated(() => { active = true; if (activatedOnce) { void load(); void loadProjects(); } activatedOnce = true; schedulePoll(); });
onDeactivated(() => { active = false; invalidateContext(); });
onBeforeUnmount(() => { active = false; invalidateContext(); window.removeEventListener('composeops:host-changed', onHostChanged); document.removeEventListener('visibilitychange', onVisibilityChanged); });

</script>

<style scoped>
@reference '../style.css';
.form-label { @apply mb-1 block text-xs font-medium text-surface-400; }
.form-grid-label { @apply flex min-w-0 flex-col gap-1 text-xs text-surface-400; }
.input { @apply w-full min-w-0; }
.input[aria-invalid='true'] { @apply border-status-error/60 ring-1 ring-rose-500/20; }
.workflow-overview { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; padding: 1.5rem; overflow: hidden; border: 1px solid var(--color-surface-800); border-radius: 1rem; background: radial-gradient(ellipse at 90% 40%, rgb(16 185 129 / .05), transparent 60%), var(--color-surface-900); }
.workflow-eyebrow { display: flex; gap: .5rem; align-items: center; font-size: .7rem; letter-spacing: .05em; color: var(--color-status-ok); }
.workflow-art { width: 200px; margin: -1.5rem 0; }
.workflow-overview-stats { display: flex; flex-wrap: wrap; gap: .75rem 1.25rem; margin-top: 1.25rem; font-size: .75rem; color: var(--color-surface-400); }
.workflow-overview-stats b { font: 500 1rem ui-monospace, monospace; color: var(--color-surface-100); }
.workflow-overview-stats button { display: flex; align-items: center; gap: .3rem; color: var(--color-status-warn); }
.workflow-overview-stats button:disabled { color: var(--color-surface-400); }
.workflow-success { display: flex; gap: .5rem; align-items: start; padding: 1rem; border: 1px solid rgb(16 185 129 / .2); border-radius: .75rem; background: rgb(16 185 129 / .05); font-size: .8rem; }
.workflow-status-filter { display: flex; align-items: center; gap: .5rem; max-width: 100%; white-space: nowrap; font-size: .75rem; color: var(--color-surface-400); }
.workflow-status-filter select { width: auto; min-width: 8rem; }
.workflow-search { display: flex; align-items: center; gap: .5rem; min-width: 0; max-width: 100%; padding: .6rem .75rem; border: 1px solid var(--color-surface-700); border-radius: .5rem; color: var(--color-surface-400); }
.workflow-search:focus-within { border-color: var(--color-accent); }
.workflow-search input { min-width: 0; max-width: 100%; background: none; outline: none; font-size: .75rem; }
.workflow-definition { display: flex; flex-direction: column; gap: .85rem; padding: 1rem; min-width: 0; border: 1px solid var(--color-surface-800); border-radius: .75rem; background: rgb(0 0 0 / .08); transition: border-color 160ms ease; }
.workflow-definition:hover, .workflow-definition:focus-within { border-color: rgb(110 231 183 / .25); }
.workflow-node-track { display: flex; flex-wrap: wrap; gap: .5rem; }
.workflow-node-track li { display: flex; align-items: center; gap: .4rem; font-size: .7rem; color: var(--color-surface-300); }
.workflow-node-track li > span:first-child { display: grid; place-items: center; width: 1.2rem; height: 1.2rem; border: 1px solid var(--color-surface-700); border-radius: .35rem; font: .6rem ui-monospace, monospace; color: var(--color-status-ok); }
.workflow-action-label { color: var(--color-surface-500); }
.workflow-instance { display: flex; flex-direction: column; gap: .85rem; padding: 1rem; min-width: 0; border: 1px solid var(--color-surface-800); border-radius: .75rem; }
.workflow-instance.is-waiting { border-color: rgb(245 158 11 / .25); }
.workflow-instance-heading { display: flex; justify-content: space-between; align-items: start; gap: .75rem; }
.workflow-approval { padding: .85rem; border-radius: .5rem; background: rgb(245 158 11 / .04); border: 1px solid rgb(245 158 11 / .15); }
.workflow-row-feedback { padding: .75rem; border-radius: .5rem; font-size: .75rem; line-height: 1.6; background: rgb(16 185 129 / .05); color: var(--color-surface-300); }
.workflow-row-feedback.is-error { background: rgb(239 68 68 / .07); color: var(--color-status-error); }
.workflow-step { display: flex; align-items: start; gap: .75rem; padding: .75rem; border: 1px solid var(--color-surface-800); border-radius: .5rem; }
.workflow-step-index { display: grid; place-items: center; flex: none; width: 1.5rem; height: 1.5rem; background: rgb(16 185 129 / .08); border-radius: 50%; font-size: .65rem; color: var(--color-status-ok); }
.workflow-step summary { cursor: pointer; }
.workflow-node-editor { display: grid; grid-template-columns: auto minmax(0, 1fr) 5.5rem 1.75rem; align-items: center; gap: .5rem; }
@media (max-width: 767px) { .workflow-art { display: none; } .workflow-overview { padding: 1rem; } }
@media (max-width: 479px) { .workflow-instance-heading { flex-direction: column; } .workflow-search { width: 100%; } .workflow-node-editor { grid-template-columns: minmax(0, 1fr) 1.75rem; } .workflow-node-editor > span { grid-column: 1; } .workflow-node-editor > input { grid-column: 1 / -1; grid-row: 2; } .workflow-node-editor > select { grid-column: 1 / -1; grid-row: 3; } .workflow-node-editor > button { grid-column: 2; grid-row: 1; } }
@media (prefers-reduced-motion: reduce) { .workflow-definition { transition: none; } }
</style>
