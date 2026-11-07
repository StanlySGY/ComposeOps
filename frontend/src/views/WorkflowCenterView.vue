<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">工作流中心</h1>
        <p class="page-subtitle">编排自动化运维流程:触发 → 条件 → Agent → 审批 → 执行 → 验证</p>
      </div>
      <div class="page-actions">
        <button class="btn-primary" @click="openCreate"><Plus class="w-4 h-4" />新建工作流</button>
        <button class="btn-secondary" :disabled="loading" @click="load"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />刷新</button>
      </div>
    </div>

    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>

    <!-- 工作流定义 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">工作流定义</h2><p class="mt-1 text-muted">定义可复用的自动化流程</p></div>
      <div class="grid gap-3 lg:grid-cols-2">
        <div v-for="def in definitions" :key="def.id" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="truncate text-sm font-semibold text-surface-100">{{ def.name }}</h3>
                <span class="count-badge" :class="def.enabled ? 'text-status-ok' : 'text-surface-400'">{{ def.enabled ? '启用' : '停用' }}</span>
              </div>
              <p class="mt-1 line-clamp-2 text-xs text-surface-400">{{ def.description || '无描述' }}</p>
            </div>
            <span class="count-badge text-sky-300">{{ def.nodes.length }} 节点</span>
          </div>
          <div class="mt-3 flex flex-wrap gap-1">
            <span v-for="node in def.nodes" :key="node.id" class="count-badge text-surface-400">{{ nodeLabel(node.type) }}</span>
          </div>
          <div class="mt-4 flex gap-2 border-t border-surface-800 pt-3">
            <button class="btn-secondary flex-1 btn-sm" :disabled="!def.enabled" @click="run(def)"><Play class="w-3.5 h-3.5" />运行</button>
            <button class="btn-secondary flex-1 btn-sm" @click="openEdit(def)"><Pencil class="w-3.5 h-3.5" />编辑</button>
            <button class="btn-secondary flex-1 btn-sm" @click="deleteTarget = def"><Trash2 class="w-3.5 h-3.5" />删除</button>
          </div>
        </div>
        <EmptyState v-if="!definitions.length" compact title="还没有工作流" description="将常用操作编排成可重复运行的流程。" action-label="新建工作流" @action="openCreate" />
      </div>
    </section>

    <!-- 运行实例 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">运行实例</h2><p class="mt-1 text-muted">查看工作流执行状态,处理待审批项</p></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>实例</th><th>工作流</th><th>状态</th><th>当前节点</th><th>创建时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="inst in instances" :key="inst.id" class="hover:bg-surface-800/25">
              <td class="font-mono text-xs text-surface-400">{{ inst.id }}</td>
              <td class="text-sm text-surface-100">{{ inst.name }}</td>
              <td><span class="status-badge" :class="instanceTone(inst.status)">{{ instanceLabel(inst.status) }}</span></td>
              <td class="text-xs text-surface-400">
                <div>{{ inst.currentNode || '—' }}</div>
                <div v-if="inst.status === 'waiting_approval' && inst.context?.pendingApprovalIntent" class="mt-1 max-w-xs whitespace-normal rounded-md border border-status-warn/20 bg-status-warn/5 px-2 py-1 text-[11px] text-status-warn">
                  <template v-if="inst.context.pendingApprovalIntent.actionIntent">
                    待确认：{{ actionLabel(inst.context.pendingApprovalIntent.actionIntent.action) }} · 项目 {{ inst.context.pendingApprovalIntent.actionIntent.projectId || '运行上下文' }}
                  </template>
                  <template v-else>此审批节点后没有可识别的执行动作</template>
                </div>
                <div v-else-if="inst.status === 'waiting_approval'" class="mt-1 max-w-xs whitespace-normal rounded-md border border-status-error/20 bg-status-error/5 px-2 py-1 text-[11px] text-status-error">
                  缺少审批意图快照。为安全起见，请取消此旧实例并重新运行。
                </div>
              </td>
              <td class="text-xs text-surface-400">{{ formatTime(inst.createdAt) }}</td>
              <td>
                <div class="flex gap-1">
                  <button v-if="inst.status === 'waiting_approval'" class="btn-secondary btn-sm" :disabled="!inst.context?.pendingApprovalIntent" @click="approve(inst, true)">通过</button>
                  <button v-if="inst.status === 'waiting_approval'" class="btn-secondary btn-sm" @click="approve(inst, false)">拒绝</button>
                  <button v-if="['pending', 'running', 'waiting_approval'].includes(inst.status)" class="icon-btn" title="取消" :aria-label="`取消工作流 ${inst.name}`" @click="cancel(inst)"><X class="w-4 h-4" /></button>
                </div>
              </td>
            </tr>
            <tr v-if="!instances.length"><td colspan="6" class="py-8 text-center text-sm text-surface-400"><EmptyState compact title="暂无运行实例" description="运行一个已启用的工作流后，可在这里查看状态和审批。" action-label="刷新实例" @action="load" /></td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 新建/编辑弹窗 -->
    <BaseModal :show="showEditor" :title="editingId ? '编辑工作流' : '新建工作流'" size-class="sm:max-w-2xl" body-class="space-y-3 p-5 pt-0" @close="showEditor = false">
      <div class="space-y-3">
          <div>
            <label class="form-label" for="workflow-name">名称</label>
            <input id="workflow-name" v-model="form.name" class="input" placeholder="如:故障自动处理" />
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
            <label class="form-grid-label sm:col-span-2"><span>事件类型(必填，逗号分隔)</span><input v-model="form.triggerConfig.eventTypes" class="input" placeholder="container, alert, gitops" /></label>
            <label class="form-grid-label"><span>来源(可选)</span><input v-model="form.triggerConfig.sources" class="input" placeholder="docker, alert" /></label>
            <label class="form-grid-label"><span>动作(可选)</span><input v-model="form.triggerConfig.actions" class="input" placeholder="die, health_status: unhealthy" /></label>
            <label class="form-grid-label sm:col-span-2"><span>项目 ID(可选，限制到一个纳管项目)</span><input v-model="form.triggerConfig.projectId" class="input" aria-label="不填则匹配所选事件类型的所有纳管项目" placeholder="不填则匹配所选事件类型的所有纳管项目" /></label>
            <p class="sm:col-span-2 text-xs text-surface-400">事件必须显式选择类型。工作流自身事件不会再次触发工作流；Docker、告警和统一事件中心事件均经过去重。</p>
          </div>
          <div v-else-if="form.triggerType === 'cron'" class="grid gap-2 rounded-lg border border-surface-800 bg-surface-950/40 p-3 sm:grid-cols-2">
            <label class="form-grid-label"><span>Cron 表达式(必填)</span><input v-model="form.triggerConfig.cron" class="input font-mono" placeholder="*/5 * * * *" /></label>
            <label class="form-grid-label"><span>项目 ID(可选)</span><select v-model="form.triggerConfig.projectId" class="input"><option value="">使用工作流运行上下文</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
            <p class="sm:col-span-2 text-xs text-surface-400">按服务端本地时区解析；同一分钟最多触发一次，重复 tick 和重启由 SQLite 幂等键去重。</p>
          </div>
          <div>
            <label class="form-label">节点编排</label>
            <div class="space-y-2">
              <div v-for="(node, i) in form.nodes" :key="i" class="rounded-lg border border-surface-800 bg-surface-900/60 p-3">
                <div class="flex items-center gap-2">
                  <span class="count-badge shrink-0 text-surface-400">{{ nodeLabel(node.type) }}</span>
                  <input v-model="node.id" class="input input-sm" :aria-label="`第 ${i + 1} 个节点 ID`" placeholder="节点 ID" />
                  <select v-model="node.type" class="input input-sm" :aria-label="`第 ${i + 1} 个节点类型`" @change="normalizeNode(node)">
                    <option value="trigger">触发</option>
                    <option value="condition">条件</option>
                    <option value="agent">Agent</option>
                    <option value="approval">审批</option>
                    <option value="action">执行</option>
                    <option value="verify">验证</option>
                  </select>
                  <button class="icon-btn shrink-0" title="删除节点" :aria-label="`删除节点 ${i + 1}`" @click="form.nodes.splice(i, 1)"><X class="w-4 h-4" /></button>
                </div>
                <div class="mt-2 grid gap-2 sm:grid-cols-3">
                  <label class="form-grid-label sm:col-span-3"><span>下一节点(可选)</span><input v-model="node.next" class="input input-sm" list="workflow-node-ids" aria-label="留空按列表顺序执行" placeholder="留空按列表顺序执行" /></label>
                  <template v-if="node.type === 'condition'">
                    <label class="form-grid-label sm:col-span-3"><span>条件表达式</span><input v-model="node.config.expression" class="input input-sm" aria-label="如: context.verified == true" placeholder="如: context.verified == true" /></label>
                    <label class="form-grid-label"><span>满足时跳转</span><input v-model="node.onTrue" class="input input-sm" list="workflow-node-ids" aria-label="节点 ID" placeholder="节点 ID" /></label>
                    <label class="form-grid-label"><span>不满足时跳转</span><input v-model="node.onFalse" class="input input-sm" list="workflow-node-ids" aria-label="节点 ID" placeholder="节点 ID" /></label>
                  </template>
                  <template v-else-if="node.type === 'agent'">
                    <label class="form-grid-label sm:col-span-3"><span>分析提示词</span><textarea v-model="node.config.prompt" class="input input-sm" rows="2" aria-label="请分析当前运维上下文并给出建议" placeholder="请分析当前运维上下文并给出建议" /></label>
                    <label class="form-grid-label sm:col-span-3"><span>项目(可选)</span><select v-model="node.config.projectId" class="input input-sm"><option value="">使用运行上下文</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
                  </template>
                  <template v-else-if="node.type === 'action'">
                    <label class="form-grid-label"><span>操作</span><select v-model="node.config.action" class="input input-sm"><option value="">选择操作</option><option value="up">启动</option><option value="stop">停止</option><option value="restart">重启</option><option value="pull">拉取镜像</option></select></label>
                    <label class="form-grid-label sm:col-span-2"><span>项目</span><select v-model="node.config.projectId" class="input input-sm"><option value="">选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
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
        </div>
        <template #footer>
          <button class="btn-secondary" @click="showEditor = false">取消</button>
          <button class="btn-primary" @click="save">保存</button>
        </template>
    </BaseModal>
    <ConfirmDialog :show="!!deleteTarget" title="删除工作流" :message="`确认删除工作流「${deleteTarget?.name}」?该操作不可恢复。`" tone="danger" confirm-text="删除" @confirm="confirmRemove" @cancel="deleteTarget = null" />
  </div>
</template>

<script setup>
import EmptyState from '../components/common/EmptyState.vue';
import { onActivated, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { usePullRefresh } from '../composables/usePullRefresh.js';
import { storeToRefs } from 'pinia';
import { Pencil, Play, Plus, RefreshCw, Trash2, X } from 'lucide-vue-next';
import { useWorkflowStore } from '../stores/workflow.js';
import { useToastStore } from '../stores/toast.js';
import { api } from '../api/client.js';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
import BaseModal from '../components/common/BaseModal.vue';

const store = useWorkflowStore();
const toast = useToastStore();
const showEditor = ref(false);
const editingId = ref('');
const form = reactive({ name: '', description: '', triggerType: 'manual', triggerConfig: {}, nodes: [] });
const projects = ref([]);

const { definitions, instances, loading, error } = storeToRefs(store);

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
function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts.replace(' ', 'T')).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

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
  if (!form.name.trim()) { toast.error('请填写工作流名称'); return; }
  const ids = new Set();
  for (const node of form.nodes) {
    normalizeNode(node);
    if (!node.id?.trim()) { toast.error('每个节点都需要填写 ID'); return; }
    if (ids.has(node.id)) { toast.error(`节点 ID 重复：${node.id}`); return; }
    ids.add(node.id);
    if (node.type === 'condition' && !node.config.expression?.trim()) { toast.error(`条件节点「${node.id}」需要表达式`); return; }
    if (node.type === 'action' && (!node.config.action || !node.config.projectId)) { toast.error(`执行节点「${node.id}」需要选择操作和项目`); return; }
  }
  normalizeTriggerConfig();
  if (form.triggerType === 'event' && !String(form.triggerConfig.eventTypes || '').trim()) { toast.error('事件触发必须选择至少一种事件类型'); return; }
  if (form.triggerType === 'cron' && !String(form.triggerConfig.cron || '').trim()) { toast.error('请填写 Cron 表达式'); return; }
  const payload = { ...form, triggerConfig: { ...form.triggerConfig }, nodes: form.nodes.map((node) => ({ ...node, config: { ...node.config } })) };
  try {
    if (editingId.value) await store.update(editingId.value, payload);
    else await store.create(payload);
    toast.success('工作流已保存');
    showEditor.value = false;
  } catch (e) {
    toast.error(e);
  }
}
const deleteTarget = ref(null);
async function confirmRemove() {
  const def = deleteTarget.value;
  deleteTarget.value = null;
  if (!def) return;
  try {
    await store.remove(def.id);
    toast.success('工作流已删除');
  } catch (e) {
    toast.error(e);
  }
}
async function run(def) {
  try {
    await store.run(def.id);
    toast.success(`已启动工作流「${def.name}」`);
  } catch (e) {
    toast.error(e);
  }
}
async function approve(inst, approved) {
  try {
    await store.approve(inst.id, { approved });
    toast.success(approved ? '已通过审批' : '已拒绝');
  } catch (e) {
    toast.error(e);
  }
}
async function cancel(inst) {
  try {
    await store.cancel(inst.id);
    toast.success('已取消实例');
  } catch (e) {
    toast.error(e);
  }
}

async function load() {
  await store.loadDefinitions();
  await store.loadInstances();
}
async function loadProjects() {
  try {
    projects.value = ((await api.getProjects(true)).projects || []).filter((project) => project.managed);
  } catch {
    projects.value = [];
  }
}
function onHostChanged() { void loadProjects(); }

usePullRefresh(load, { keepAlive: true });
onMounted(() => { void load(); void loadProjects(); window.addEventListener('composeops:host-changed', onHostChanged); });
onBeforeUnmount(() => window.removeEventListener('composeops:host-changed', onHostChanged));
let activatedOnce = false;
onActivated(() => { if (activatedOnce) void load(); activatedOnce = true; });

</script>
