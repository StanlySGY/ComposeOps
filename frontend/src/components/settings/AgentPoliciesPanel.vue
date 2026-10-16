<template>
  <div class="space-y-4">
    <div class="page-header">
      <div>
        <h2 class="section-title">Agent 持久化策略</h2>
        <p class="page-subtitle">策略组跨重启保留；拒绝规则优先，策略不替代权限校验或关键操作的人工确认。</p>
      </div>
      <button class="btn-secondary" :disabled="loading" @click="load">
        <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" />刷新
      </button>
    </div>

    <p v-if="error" class="alert-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="alert-success" role="status" aria-live="polite">{{ notice }}</p>

    <section class="section-panel space-y-3">
      <div>
        <h3 class="section-title">策略组</h3>
        <p class="text-muted mt-1">停用策略组会同时停用其中所有规则，但不删除历史审计。</p>
      </div>
      <form class="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end" @submit.prevent="createGroup">
        <label class="block text-xs text-surface-400">新策略组名称
          <input v-model="groupForm.name" class="input mt-1" maxlength="80" required placeholder="例如：生产环境保护" />
        </label>
        <label class="block text-xs text-surface-400">说明
          <input v-model="groupForm.description" class="input mt-1" maxlength="500" placeholder="适用范围或运维约定" />
        </label>
        <button class="btn-primary" type="submit" :disabled="saving || !groupForm.name.trim()"><Plus class="h-4 w-4" />创建策略组</button>
      </form>
      <div v-if="groups.length" class="grid gap-2 md:grid-cols-2">
        <div v-for="group in groups" :key="group.id" class="rounded-xl border p-3" :class="selectedGroupId === group.id ? 'border-accent/60 bg-accent/5' : 'border-surface-800 bg-surface-950/30'">
          <div class="flex items-start gap-3">
            <input type="radio" name="agent-policy-group" :aria-label="'选择策略组 ' + group.name" :checked="selectedGroupId === group.id" @change="selectedGroupId = group.id" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-surface-100">{{ group.name }}</span>
                <span class="status-badge" :class="group.enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-surface-800 text-surface-400'">{{ group.enabled ? '已启用' : '已停用' }}</span>
              </div>
              <p class="mt-1 break-words text-xs text-surface-500">{{ group.description || '未填写说明' }} · {{ group.ruleCount }} 条规则</p>
            </div>
            <button class="icon-btn" :aria-label="(group.enabled ? '停用' : '启用') + '策略组 ' + group.name" :title="group.enabled ? '停用' : '启用'" @click="toggleGroup(group)">
              <ShieldCheck class="h-4 w-4" />
            </button>
            <button class="icon-btn" :aria-label="'删除策略组 ' + group.name" title="删除策略组" @click="removeGroup(group)"><Trash2 class="h-4 w-4" /></button>
          </div>
        </div>
      </div>
      <p v-else class="rounded-lg border border-dashed border-surface-700 p-4 text-sm text-surface-500">尚无策略组。创建策略组后再添加规则；空策略组不会改变现有审批行为。</p>
    </section>

    <section class="section-panel space-y-3">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 class="section-title">规则管理</h3>
          <p class="text-muted mt-1">工具名与项目 ID 精确匹配；参数 JSON 采用字段子集精确匹配，不支持正则和任意命令表达式。</p>
        </div>
        <span class="status-badge bg-rose-500/10 text-rose-300">Deny 优先</span>
      </div>
      <p v-if="!groups.length" class="text-sm text-surface-500">请先创建策略组。</p>
      <template v-else>
        <form class="space-y-3 rounded-xl border border-surface-800 bg-surface-950/30 p-3" @submit.prevent="createRule">
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label class="block text-xs text-surface-400">所属策略组
              <select v-model="ruleForm.groupId" class="input mt-1" required aria-label="新规则所属策略组">
                <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}{{ group.enabled ? '' : '（已停用）' }}</option>
              </select>
            </label>
            <label class="block text-xs text-surface-400">规则名称
              <input v-model="ruleForm.name" class="input mt-1" maxlength="100" required placeholder="例如：禁止删除生产卷" />
            </label>
            <label class="block text-xs text-surface-400">效果
              <select v-model="ruleForm.effect" class="input mt-1" aria-label="策略规则效果">
                <option value="deny">拒绝（不能被确认覆盖）</option>
                <option value="allow">允许（仅低/中风险可免逐次确认）</option>
              </select>
            </label>
            <label class="block text-xs text-surface-400">工具名（完整名称或 *）
              <input v-model="ruleForm.toolName" class="input mt-1 font-mono" maxlength="128" required placeholder="compose.ps 或 *" />
            </label>
            <label class="block text-xs text-surface-400">项目 ID（精确值或 *）
              <input v-model="ruleForm.projectId" class="input mt-1 font-mono" maxlength="200" required placeholder="project-id 或 *" />
            </label>
            <label class="block text-xs text-surface-400">优先级（越小越先匹配）
              <input v-model.number="ruleForm.priority" type="number" min="-1000" max="1000" step="1" class="input mt-1" required />
            </label>
          </div>
          <label class="block text-xs text-surface-400">参数匹配 JSON（字段必须全部满足；留空对象表示不限制参数）
            <textarea v-model="ruleForm.parametersText" class="input mt-1 font-mono" rows="3" spellcheck="false" aria-label="参数匹配 JSON"></textarea>
          </label>
          <label class="block text-xs text-surface-400">命中原因（写入审计）
            <input v-model="ruleForm.reason" class="input mt-1" maxlength="500" placeholder="例如：生产环境禁止执行破坏性操作" />
          </label>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <label class="inline-flex items-center gap-2 text-sm text-surface-300"><input v-model="ruleForm.enabled" type="checkbox" />创建后立即启用</label>
            <button class="btn-primary" type="submit" :disabled="saving || !ruleForm.name.trim() || !ruleForm.groupId"><Plus class="h-4 w-4" />添加规则</button>
          </div>
          <p class="text-xs text-amber-300">安全边界：敏感字段和值会被拒绝保存；所有拒绝规则先于允许规则；允许规则不能跳过 critical 确认或服务端权限检查。</p>
        </form>

        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>规则</th><th>效果 / 范围</th><th>匹配条件</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="rule in rules" :key="rule.id">
                <td class="min-w-40">
                  <div class="font-medium text-surface-100">{{ rule.name }}</div>
                  <div class="mt-1 text-xs text-surface-500">{{ rule.groupName }} · 优先级 {{ rule.priority }}</div>
                  <div v-if="rule.reason" class="mt-1 text-xs text-surface-400">{{ rule.reason }}</div>
                </td>
                <td>
                  <span class="status-badge" :class="rule.effect === 'deny' ? 'bg-rose-500/10 text-rose-300' : 'bg-emerald-500/10 text-emerald-300'">{{ rule.effect === 'deny' ? '拒绝' : '允许' }}</span>
                  <div class="mt-1 max-w-52 break-all font-mono text-xs text-surface-400">{{ rule.toolName }}</div>
                  <div class="max-w-52 break-all font-mono text-xs text-surface-500">{{ rule.projectId === '*' ? '所有项目' : rule.projectId }}</div>
                </td>
                <td class="max-w-64 break-all font-mono text-xs text-surface-400">{{ JSON.stringify(rule.parameters) }}</td>
                <td><span class="status-badge" :class="rule.enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-surface-800 text-surface-400'">{{ rule.enabled ? '启用' : '停用' }}</span></td>
                <td><div class="flex gap-1">
                  <button class="icon-btn" :aria-label="(rule.enabled ? '停用' : '启用') + '规则 ' + rule.name" :title="rule.enabled ? '停用' : '启用'" @click="toggleRule(rule)"><ShieldCheck class="h-4 w-4" /></button>
                  <button class="icon-btn" :aria-label="'删除规则 ' + rule.name" title="删除规则" @click="removeRule(rule)"><Trash2 class="h-4 w-4" /></button>
                </div></td>
              </tr>
              <tr v-if="!rules.length"><td colspan="5" class="py-6 text-center text-sm text-surface-500">这个策略组还没有规则。</td></tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <section class="section-panel space-y-3">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="section-title">Agent 审计事件</h3>
          <p class="text-muted mt-1">追加式记录请求、策略决策、人工审批、执行结果和后置检查。详情不保存原始参数，只保存脱敏数据与参数指纹。</p>
        </div>
        <button class="btn-secondary" :disabled="loading" @click="loadAudit"><RefreshCw class="h-4 w-4" />刷新审计</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>时间</th><th>事件</th><th>工具 / 执行</th><th>决策与原因</th></tr></thead>
          <tbody>
            <tr v-for="event in auditEvents" :key="event.id">
              <td class="whitespace-nowrap text-xs text-surface-500">{{ event.createdAt }}</td>
              <td><span class="status-badge" :class="eventTone(event)">{{ eventLabel(event.eventType) }}</span><div class="mt-1 text-xs text-surface-500">{{ event.actor }}</div></td>
              <td class="min-w-36">
                <div class="font-mono text-xs text-surface-200">{{ event.toolName || '—' }}</div>
                <div class="mt-1 max-w-48 break-all font-mono text-[11px] text-surface-600">{{ event.executionId || event.planId || '' }}</div>
                <div v-if="event.parametersHash" class="mt-1 font-mono text-[10px] text-surface-600">SHA256 {{ event.parametersHash.slice(0, 12) }}…</div>
              </td>
              <td class="min-w-48">
                <div class="text-sm text-surface-200">{{ event.decision || '—' }}<span v-if="event.ruleName"> · {{ event.ruleName }}</span></div>
                <p v-if="event.reason" class="mt-1 whitespace-normal text-xs text-surface-500">{{ event.reason }}</p>
              </td>
            </tr>
            <tr v-if="!auditEvents.length"><td colspan="4" class="py-6 text-center text-sm text-surface-500">暂无审计事件。执行 Agent 工具后，策略决策与执行生命周期会显示在这里。</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-vue-next';
import { api } from '../../api/client.js';

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const groups = ref([]);
const rules = ref([]);
const auditEvents = ref([]);
const selectedGroupId = ref('');
const groupForm = ref({ name: '', description: '' });
const ruleForm = ref({ groupId: '', name: '', effect: 'deny', priority: 100, enabled: true, toolName: '*', projectId: '*', parametersText: '{}', reason: '' });

function reportError(cause) { error.value = cause?.message || String(cause || '请求失败'); notice.value = ''; }
function reportSuccess(value) { notice.value = value; error.value = ''; }

async function loadAudit() {
  try { auditEvents.value = (await api.getAgentAuditEvents(100)).events || []; }
  catch (cause) { reportError(cause); }
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [groupResponse, ruleResponse, auditResponse] = await Promise.all([
      api.getAgentPolicyGroups(), api.getAgentPolicyRules(), api.getAgentAuditEvents(100),
    ]);
    groups.value = groupResponse.groups || [];
    auditEvents.value = auditResponse.events || [];
    if (!groups.value.some((group) => group.id === selectedGroupId.value)) selectedGroupId.value = groups.value[0]?.id || '';
    rules.value = (ruleResponse.rules || []).filter((rule) => rule.groupId === selectedGroupId.value);
    if (!ruleForm.value.groupId || !groups.value.some((group) => group.id === ruleForm.value.groupId)) ruleForm.value.groupId = selectedGroupId.value;
  } catch (cause) { reportError(cause); }
  finally { loading.value = false; }
}

watch(selectedGroupId, async (groupId) => {
  if (!groupId) { rules.value = []; return; }
  try { rules.value = (await api.getAgentPolicyRules(groupId)).rules || []; }
  catch (cause) { reportError(cause); }
});

async function createGroup() {
  if (saving.value || !groupForm.value.name.trim()) return;
  saving.value = true;
  try {
    const { group } = await api.createAgentPolicyGroup(groupForm.value);
    groupForm.value = { name: '', description: '' };
    selectedGroupId.value = group.id;
    ruleForm.value.groupId = group.id;
    await load();
    reportSuccess('策略组已创建');
  } catch (cause) { reportError(cause); }
  finally { saving.value = false; }
}

async function toggleGroup(group) {
  try { await api.updateAgentPolicyGroup(group.id, { enabled: !group.enabled }); await load(); reportSuccess(`策略组已${group.enabled ? '停用' : '启用'}`); }
  catch (cause) { reportError(cause); }
}

async function removeGroup(group) {
  if (!window.confirm(`删除策略组“${group.name}”及其中所有规则？已写入的审计事件会保留。`)) return;
  try { await api.deleteAgentPolicyGroup(group.id); await load(); reportSuccess('策略组已删除'); }
  catch (cause) { reportError(cause); }
}

async function createRule() {
  if (saving.value) return;
  let parameters;
  try {
    parameters = JSON.parse(ruleForm.value.parametersText || '{}');
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('参数匹配必须是 JSON 对象');
  } catch (cause) { reportError(new Error(`参数匹配 JSON 格式错误：${cause.message}`)); return; }
  saving.value = true;
  try {
    await api.createAgentPolicyRule({
      groupId: ruleForm.value.groupId, name: ruleForm.value.name, effect: ruleForm.value.effect,
      priority: Number(ruleForm.value.priority), enabled: ruleForm.value.enabled,
      toolName: ruleForm.value.toolName.trim() || '*', projectId: ruleForm.value.projectId.trim() || '*',
      parameters, reason: ruleForm.value.reason,
    });
    ruleForm.value = { ...ruleForm.value, name: '', parametersText: '{}', reason: '', priority: 100, enabled: true };
    await load();
    reportSuccess('策略规则已创建');
  } catch (cause) { reportError(cause); }
  finally { saving.value = false; }
}

async function toggleRule(rule) {
  try { await api.updateAgentPolicyRule(rule.id, { enabled: !rule.enabled }); await load(); reportSuccess(`规则已${rule.enabled ? '停用' : '启用'}`); }
  catch (cause) { reportError(cause); }
}

async function removeRule(rule) {
  if (!window.confirm(`删除规则“${rule.name}”？历史审计记录不会删除。`)) return;
  try { await api.deleteAgentPolicyRule(rule.id); await load(); reportSuccess('策略规则已删除'); }
  catch (cause) { reportError(cause); }
}

function eventLabel(value) {
  return ({
    tool_requested: '工具请求', policy_decision: '策略判定', policy_authorized: '策略放行',
    approval_requested: '等待确认', approval_decision: '人工审批', execution_started: '开始执行',
    execution_completed: '执行结束', execution_blocked: '阻止执行', postcondition_completed: '后置检查',
  })[value] || value;
}

function eventTone(event) {
  if (event.decision === 'deny' || event.decision === 'denied' || event.decision === 'rejected' || event.decision === 'failed') return 'bg-rose-500/10 text-rose-300';
  if (event.decision === 'allow' || event.decision === 'allow_without_prompt' || event.decision === 'success' || event.decision === 'passed' || event.decision === 'approved') return 'bg-emerald-500/10 text-emerald-300';
  return 'bg-surface-800 text-surface-300';
}

onMounted(load);
</script>
