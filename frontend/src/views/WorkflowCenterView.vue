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

    <p v-if="error" class="alert-error">{{ error }}</p>

    <!-- 工作流定义 -->
    <section class="section-panel">
      <div class="mb-4"><h2 class="section-title">工作流定义</h2><p class="mt-1 text-muted">定义可复用的自动化流程</p></div>
      <div class="grid gap-3 lg:grid-cols-2">
        <div v-for="def in definitions" :key="def.id" class="rounded-xl border border-surface-800 bg-surface-950/40 p-4">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="truncate text-sm font-semibold text-surface-100">{{ def.name }}</h3>
                <span class="count-badge" :class="def.enabled ? 'text-emerald-300' : 'text-surface-500'">{{ def.enabled ? '启用' : '停用' }}</span>
              </div>
              <p class="mt-1 line-clamp-2 text-xs text-surface-500">{{ def.description || '无描述' }}</p>
            </div>
            <span class="count-badge text-sky-300">{{ def.nodes.length }} 节点</span>
          </div>
          <div class="mt-3 flex flex-wrap gap-1">
            <span v-for="node in def.nodes" :key="node.id" class="count-badge text-surface-400">{{ nodeLabel(node.type) }}</span>
          </div>
          <div class="mt-4 flex gap-2 border-t border-surface-800 pt-3">
            <button class="btn-secondary flex-1 px-2! py-1.5! text-xs" :disabled="!def.enabled" @click="run(def)"><Play class="w-3.5 h-3.5" />运行</button>
            <button class="btn-secondary flex-1 px-2! py-1.5! text-xs" @click="openEdit(def)"><Pencil class="w-3.5 h-3.5" />编辑</button>
            <button class="btn-secondary flex-1 px-2! py-1.5! text-xs" @click="deleteTarget = def"><Trash2 class="w-3.5 h-3.5" />删除</button>
          </div>
        </div>
        <div v-if="!definitions.length" class="rounded-xl border border-dashed border-surface-700 p-8 text-center text-sm text-surface-500">暂无工作流,点击「新建工作流」创建</div>
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
              <td class="text-xs text-surface-400">{{ inst.currentNode || '—' }}</td>
              <td class="text-xs text-surface-500">{{ formatTime(inst.createdAt) }}</td>
              <td>
                <div class="flex gap-1">
                  <button v-if="inst.status === 'waiting_approval'" class="btn-secondary px-2! py-1! text-xs" @click="approve(inst, true)">通过</button>
                  <button v-if="inst.status === 'waiting_approval'" class="btn-secondary px-2! py-1! text-xs" @click="approve(inst, false)">拒绝</button>
                  <button v-if="['pending', 'running', 'waiting_approval'].includes(inst.status)" class="icon-btn" title="取消" @click="cancel(inst)"><X class="w-4 h-4" /></button>
                </div>
              </td>
            </tr>
            <tr v-if="!instances.length"><td colspan="6" class="py-8 text-center text-sm text-surface-500">暂无运行实例</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 新建/编辑弹窗 -->
    <BaseModal :show="showEditor" :title="editingId ? '编辑工作流' : '新建工作流'" size-class="max-w-2xl!" body-class="space-y-3 p-5 pt-0" @close="showEditor = false">
      <div class="space-y-3">
          <div>
            <label class="form-label">名称</label>
            <input v-model="form.name" class="input" placeholder="如:故障自动处理" />
          </div>
          <div>
            <label class="form-label">描述</label>
            <input v-model="form.description" class="input" placeholder="流程说明" />
          </div>
          <div>
            <label class="form-label">触发方式</label>
            <select v-model="form.triggerType" class="input">
              <option value="manual">手动</option>
              <option value="cron">定时</option>
              <option value="event">事件</option>
            </select>
          </div>
          <div>
            <label class="form-label">节点编排</label>
            <div class="space-y-2">
              <div v-for="(node, i) in form.nodes" :key="i" class="rounded-lg border border-surface-800 bg-surface-900/60 p-3">
                <div class="flex items-center gap-2">
                  <span class="count-badge shrink-0 text-surface-400">{{ nodeLabel(node.type) }}</span>
                  <input v-model="node.id" class="input py-1! text-xs" placeholder="节点 ID" />
                  <select v-model="node.type" class="input py-1! text-xs" @change="normalizeNode(node)">
                    <option value="trigger">触发</option>
                    <option value="condition">条件</option>
                    <option value="agent">Agent</option>
                    <option value="approval">审批</option>
                    <option value="action">执行</option>
                    <option value="verify">验证</option>
                  </select>
                  <button class="icon-btn shrink-0" title="删除节点" @click="form.nodes.splice(i, 1)"><X class="w-4 h-4" /></button>
                </div>
                <div class="mt-2 grid gap-2 sm:grid-cols-3">
                  <label class="form-grid-label sm:col-span-3"><span>下一节点(可选)</span><input v-model="node.next" class="input py-1! text-xs" list="workflow-node-ids" placeholder="留空按列表顺序执行" /></label>
                  <template v-if="node.type === 'condition'">
                    <label class="form-grid-label sm:col-span-3"><span>条件表达式</span><input v-model="node.config.expression" class="input py-1! text-xs" placeholder="如: context.verified == true" /></label>
                    <label class="form-grid-label"><span>满足时跳转</span><input v-model="node.onTrue" class="input py-1! text-xs" list="workflow-node-ids" placeholder="节点 ID" /></label>
                    <label class="form-grid-label"><span>不满足时跳转</span><input v-model="node.onFalse" class="input py-1! text-xs" list="workflow-node-ids" placeholder="节点 ID" /></label>
                  </template>
                  <template v-else-if="node.type === 'agent'">
                    <label class="form-grid-label sm:col-span-3"><span>分析提示词</span><textarea v-model="node.config.prompt" class="input py-1! text-xs" rows="2" placeholder="请分析当前运维上下文并给出建议" /></label>
                    <label class="form-grid-label sm:col-span-3"><span>项目(可选)</span><select v-model="node.config.projectId" class="input py-1! text-xs"><option value="">使用运行上下文</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
                  </template>
                  <template v-else-if="node.type === 'action'">
                    <label class="form-grid-label"><span>操作</span><select v-model="node.config.action" class="input py-1! text-xs"><option value="">选择操作</option><option value="up">启动</option><option value="stop">停止</option><option value="restart">重启</option><option value="pull">拉取镜像</option></select></label>
                    <label class="form-grid-label sm:col-span-2"><span>项目</span><select v-model="node.config.projectId" class="input py-1! text-xs"><option value="">选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
                  </template>
                  <template v-else-if="node.type === 'verify'">
                    <label class="form-grid-label sm:col-span-3"><span>项目(可选)</span><select v-model="node.config.projectId" class="input py-1! text-xs"><option value="">使用运行上下文</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.projectName }}</option></select></label>
                  </template>
                </div>
              </div>
            </div>
            <datalist id="workflow-node-ids"><option v-for="node in form.nodes" :key="node.id" :value="node.id" /></datalist>
            <button class="btn-secondary mt-2 px-3! py-1.5! text-xs" @click="addNode"><Plus class="w-3.5 h-3.5" />添加节点</button>
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
import { onActivated, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
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
const form = reactive({ name: '', description: '', triggerType: 'manual', nodes: [] });
const projects = ref([]);

const { definitions, instances, loading, error } = storeToRefs(store);

function nodeLabel(type) {
  return { trigger: '触发', condition: '条件', agent: 'Agent', approval: '审批', action: '执行', verify: '验证' }[type] || type;
}
function instanceLabel(status) {
  return { pending: '待执行', running: '执行中', waiting_approval: '待审批', success: '成功', failed: '失败', cancelled: '已取消' }[status] || status;
}
function instanceTone(status) {
  if (status === 'success') return 'bg-emerald-500/10 text-emerald-400';
  if (status === 'failed') return 'bg-rose-500/10 text-rose-400';
  if (status === 'waiting_approval') return 'bg-amber-500/10 text-amber-400';
  if (status === 'running') return 'bg-sky-500/10 text-sky-400';
  if (status === 'cancelled') return 'bg-surface-800 text-surface-400';
  return 'bg-surface-800 text-surface-400';
}
function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts.replace(' ', 'T')).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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
    if (ids.has(node.id)) { toast.error(`节点 ID 重复:${node.id}`); return; }
    ids.add(node.id);
    if (node.type === 'condition' && !node.config.expression?.trim()) { toast.error(`条件节点「${node.id}」需要表达式`); return; }
    if (node.type === 'action' && (!node.config.action || !node.config.projectId)) { toast.error(`执行节点「${node.id}」需要选择操作和项目`); return; }
  }
  const payload = { ...form, nodes: form.nodes.map((node) => ({ ...node, config: { ...node.config } })) };
  try {
    if (editingId.value) await store.update(editingId.value, payload);
    else await store.create(payload);
    toast.success('工作流已保存');
    showEditor.value = false;
  } catch (e) {
    toast.error(e.message);
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
    toast.error(e.message);
  }
}
async function run(def) {
  try {
    await store.run(def.id);
    toast.success(`已启动工作流「${def.name}」`);
  } catch (e) {
    toast.error(e.message);
  }
}
async function approve(inst, approved) {
  try {
    await store.approve(inst.id, { approved });
    toast.success(approved ? '已通过审批' : '已拒绝');
  } catch (e) {
    toast.error(e.message);
  }
}
async function cancel(inst) {
  try {
    await store.cancel(inst.id);
    toast.success('已取消实例');
  } catch (e) {
    toast.error(e.message);
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

onMounted(() => { void load(); void loadProjects(); window.addEventListener('composeops:host-changed', onHostChanged); });
onBeforeUnmount(() => window.removeEventListener('composeops:host-changed', onHostChanged));
let activatedOnce = false;
onActivated(() => { if (activatedOnce) void load(); activatedOnce = true; });

</script>
