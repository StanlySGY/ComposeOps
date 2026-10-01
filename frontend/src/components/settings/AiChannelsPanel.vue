<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><h2 class="section-title">AI 渠道</h2><p class="mt-1 text-xs leading-5 text-surface-400">每条渠道独立保存。已启用渠道按顺序使用，排序调整即时生效。</p></div>
      <button class="btn-secondary" data-action="add" :disabled="channels.length >= 12 || ordering" @click="addChannel"><Plus class="w-4 h-4" />添加渠道</button>
    </div>
    <p v-if="orderMessage" class="text-xs text-surface-300" role="status">{{ orderMessage }}</p>
    <p v-if="!channels.length" class="rounded-xl border border-dashed border-surface-700 p-6 text-center text-sm text-surface-400">还没有 AI 渠道。添加直连接口或现有 New API 的地址和令牌。</p>
    <article v-for="(channel, index) in channels" :key="channel.id" class="card min-w-0 space-y-4 p-4 sm:p-5" :data-channel-id="channel.id" :aria-busy="!!busy[channel.id]">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-surface-800 pb-3">
        <div class="flex min-w-0 flex-wrap items-center gap-2"><span class="count-badge">{{ index + 1 }}</span><strong class="text-sm text-surface-100 break-all">{{ channel.name || '新渠道' }}</strong><span class="text-xs" :class="channel.dirty ? 'text-amber-400' : channel.health?.status === 'healthy' ? 'text-emerald-400' : 'text-surface-400'">{{ statusLabel(channel) }}</span></div>
        <div class="flex items-center gap-1">
          <label class="toggle-label mr-2"><input type="checkbox" data-field="enabled" :checked="channel.enabled" :disabled="!!busy[channel.id]" @change="update(channel.id, { enabled: $event.target.checked })" />启用</label>
          <button class="icon-btn" title="提高优先级（立即保存顺序）" aria-label="提高优先级" :disabled="!canMove(index, -1)" @click="move(index, -1)"><ArrowUp class="w-4 h-4" /></button>
          <button class="icon-btn" title="降低优先级（立即保存顺序）" aria-label="降低优先级" :disabled="!canMove(index, 1)" @click="move(index, 1)"><ArrowDown class="w-4 h-4" /></button>
          <button class="icon-btn hover:text-rose-400" title="删除渠道" aria-label="删除渠道" :disabled="!!busy[channel.id] || ordering" @click="removeTarget = channel"><Trash2 class="w-4 h-4" /></button>
        </div>
      </div>
      <fieldset class="form-grid min-w-0" :disabled="!!busy[channel.id]">
        <label>渠道名称<input class="input" data-field="name" :value="channel.name" maxlength="80" placeholder="例如：主渠道 / 备用 / New API" @input="update(channel.id, { name: $event.target.value })" /></label>
        <label>接口地址<input class="input" data-field="baseUrl" :value="channel.baseUrl" placeholder="https://example.com/v1" @input="update(channel.id, { baseUrl: $event.target.value })" /></label>
        <div class="min-w-0 space-y-2">
          <label class="flex flex-col gap-1 text-xs text-surface-400">{{ channel.hasApiKey ? '更新 API Key' : 'API Key' }}<input class="input" data-field="apiKey" type="password" autocomplete="new-password" :value="channel.apiKey" :placeholder="channel.hasApiKey ? '留空保留已保存的密钥' : '填写此渠道的密钥或 New API 令牌'" @input="update(channel.id, { apiKey: $event.target.value })" /></label>
          <button v-if="channel.saved && channel.hasApiKey" class="inline-flex items-center gap-1.5 text-xs text-surface-300 hover:text-emerald-400" data-action="reveal" @click="toggleKey(channel)"><component :is="revealed[channel.id] ? EyeOff : Eye" class="h-3.5 w-3.5" />{{ revealed[channel.id] ? '隐藏已保存密钥' : '查看已保存密钥' }}</button>
          <p v-if="addressChanged(channel)" class="text-xs leading-5 text-amber-400">地址已变更，请重新填写对应密钥后保存。</p>
        </div>
        <label>模型
          <div class="flex items-center gap-1.5"><input class="input min-w-0 flex-1" data-field="model" :value="channel.model" :list="`models-${channel.id}`" placeholder="输入或获取模型名称" @input="update(channel.id, { model: $event.target.value })" /><button class="icon-btn shrink-0" title="获取此渠道的模型" aria-label="获取此渠道的模型" @click="fetchModels(channel)"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': busy[channel.id] === 'models' }" /></button></div>
          <datalist :id="`models-${channel.id}`"><option v-for="name in modelLists[channel.id] || []" :key="name" :value="name" /></datalist>
        </label>
      </fieldset>
      <div v-if="revealed[channel.id]" class="rounded-lg border border-surface-700 bg-surface-950/50 p-3 space-y-2">
        <div class="flex items-center justify-between gap-2"><span class="text-xs text-surface-400">已保存密钥 · 60 秒后自动隐藏</span><button class="icon-btn shrink-0" aria-label="复制已保存密钥" @click="copyKey(channel.id)"><Copy class="h-4 w-4" /></button></div>
        <input :ref="el => keyInputs[channel.id] = el" class="input w-full font-mono text-xs" aria-label="已保存的 API Key" :value="revealed[channel.id]" readonly autocomplete="off" spellcheck="false" />
      </div>
      <fieldset class="min-w-0 space-y-3" :disabled="!!busy[channel.id]">
        <label class="toggle-label"><input type="checkbox" data-field="supportsTools" :checked="channel.supportsTools" @change="update(channel.id, { supportsTools: $event.target.checked })" />用于 AI 助手（需要工具调用）</label>
        <p v-if="!channel.supportsTools" class="text-xs text-amber-400">此渠道仅用于普通模型请求，不参与 AI 助手的工具调用。</p>
        <details class="rounded-lg bg-surface-950/30 px-3 py-2" :open="channel.streamToolCalls === false || undefined">
          <summary class="cursor-pointer text-xs text-surface-400">高级设置<span v-if="channel.streamToolCalls === false" class="ml-2 text-emerald-400">兼容模式</span></summary>
          <div class="form-grid mt-3">
            <label>首段响应等待（秒）<input class="input" data-field="timeout" type="number" min="1" max="120" :value="channel.firstTokenTimeoutMs / 1000" @input="update(channel.id, { firstTokenTimeoutMs: Number($event.target.value) * 1000 })" /></label>
            <label>工具响应模式<select class="input" data-field="streamToolCalls" :value="channel.streamToolCalls === false ? 'compatible' : 'stream'" :disabled="!channel.supportsTools" @change="update(channel.id, { streamToolCalls: $event.target.value === 'stream' })"><option value="stream">流式模式</option><option value="compatible">兼容模式（完整返回）</option></select></label>
          </div>
          <p class="mt-2 text-xs leading-5 text-surface-500">上游出现工具参数截断时可选兼容模式。工具轮次需等待完整回复后显示；普通聊天仍可流式输出。</p>
        </details>
      </fieldset>
      <div class="flex flex-wrap items-center gap-2 border-t border-surface-800 pt-3">
        <button class="btn-primary" data-action="save" :disabled="!channel.dirty || !!busy[channel.id] || ordering" @click="saveChannel(channel)"><Save class="w-4 h-4" />{{ busy[channel.id] === 'save' ? '保存中…' : '保存此渠道' }}</button>
        <button class="btn-secondary" data-action="test" :disabled="!!busy[channel.id] || ordering" @click="testChannel(channel)"><Activity class="w-4 h-4" />{{ busy[channel.id] === 'test' ? '测试中…' : channel.dirty || !channel.saved ? '保存并测试' : '测试连接' }}</button>
        <button v-if="channel.dirty && channel.saved" class="btn-ghost" data-action="revert" :disabled="!!busy[channel.id]" @click="revert(channel.id)">撤销修改</button>
        <button v-if="conflicts[channel.id]" class="btn-ghost" :disabled="!!busy[channel.id]" @click="reloadChannel(channel)">重新载入此渠道</button>
        <span class="text-xs text-surface-500">{{ channel.supportsTools ? '验证参数及结果回传，最多 3 次小请求。' : '验证聊天连接，发起 1 次小请求。' }}</span>
      </div>
      <p v-if="notices[channel.id]" role="status" class="text-xs break-words" :class="notices[channel.id].ok ? 'text-emerald-400' : 'text-rose-400'">{{ notices[channel.id].text }}</p>
      <div v-if="results[channel.id]" class="rounded-lg border border-surface-800 p-3 space-y-2" role="status">
        <p class="text-xs" :class="results[channel.id].ok ? 'text-emerald-400' : 'text-amber-400'">{{ results[channel.id].ok ? '测试通过' : '测试未全部通过' }} · {{ results[channel.id].latencyMs }} ms · {{ results[channel.id].mode === 'compatible' ? '兼容模式' : '流式模式' }}</p>
        <ul class="space-y-2"><li v-for="check in results[channel.id].checks" :key="check.id" class="flex items-start gap-2 text-xs"><component :is="check.status === 'passed' ? CheckCircle2 : check.status === 'failed' ? AlertCircle : MinusCircle" class="mt-0.5 h-3.5 w-3.5 shrink-0" :class="check.status === 'passed' ? 'text-emerald-400' : check.status === 'failed' ? 'text-amber-400' : 'text-surface-500'" /><span class="min-w-0 break-words text-surface-300">{{ check.label }}：{{ check.message }}</span></li></ul>
        <p v-if="results[channel.id].suggestion" class="text-xs leading-5 text-amber-400">{{ results[channel.id].suggestion }}</p>
      </div>
      <p v-else-if="channel.health?.lastError && !channel.dirty" class="text-xs text-amber-400 break-words">最近故障：{{ channel.health.lastError }}</p>
    </article>
    <ConfirmDialog :show="!!removeTarget" title="删除 AI 渠道" :message="`确认删除「${removeTarget?.name || '新渠道'}」？${removeTarget?.saved ? '删除后立即停止使用此渠道。' : '尚未保存的内容将丢弃。'}`" tone="danger" confirm-text="删除渠道" :busy="!!busy[removeTarget?.id]" @confirm="removeChannel" @cancel="removeTarget = null" />
  </div>
</template>

<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { Activity, AlertCircle, ArrowDown, ArrowUp, CheckCircle2, Copy, Eye, EyeOff, MinusCircle, Plus, RefreshCw, Save, Trash2 } from 'lucide-vue-next';
import { api } from '../../api/client.js';
import ConfirmDialog from '../common/ConfirmDialog.vue';

const props = defineProps({ channels: { type: Array, default: () => [] } });
const emit = defineEmits(['update:channels', 'health-change']);
const busy = ref({}), results = ref({}), notices = ref({}), modelLists = ref({}), conflicts = ref({});
const revealed = ref({}), removeTarget = ref(null), ordering = ref(false), orderMessage = ref('');
const snapshots = new Map(), hideTimers = new Map(), keyInputs = {};
let visible = true, revealEpoch = 0;
const listBusy = computed(() => ordering.value || Object.values(busy.value).some(Boolean));
const draft = (item) => ({ ...item, apiKey: '', saved: true, dirty: false });
const patchRow = (id, patch) => emit('update:channels', props.channels.map(item => item.id === id ? { ...item, ...patch } : item));
watch(() => props.channels, (channels) => {
  for (const item of channels) if (item.saved && !item.dirty) snapshots.set(item.id, draft(item));
  for (const id of snapshots.keys()) if (!channels.some(item => item.id === id)) { snapshots.delete(id); hideKey(id); }
}, { immediate: true });
function update(id, patch) {
  if ('baseUrl' in patch || 'apiKey' in patch) { delete modelLists.value[id]; hideKey(id); }
  delete results.value[id]; delete notices.value[id];
  patchRow(id, { ...patch, dirty: true });
}
async function addChannel() {
  const id = `channel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  emit('update:channels', [...props.channels, { id, name: '', baseUrl: '', apiKey: '', model: '', enabled: true, supportsTools: true, streamToolCalls: true, firstTokenTimeoutMs: 30000, saved: false, dirty: true }]);
  await nextTick();
  document.querySelector(`[data-channel-id="${id}"] [data-field="name"]`)?.focus();
}
function canMove(index, offset) { return !listBusy.value && props.channels[index]?.saved && props.channels[index + offset]?.saved; }
async function move(index, offset) {
  if (!canMove(index, offset)) return;
  ordering.value = true; orderMessage.value = '';
  const previousIds = props.channels.filter(item => item.saved).map(item => item.id);
  const ids = [...previousIds];
  const position = ids.indexOf(props.channels[index].id);
  [ids[position], ids[position + offset]] = [ids[position + offset], ids[position]];
  try {
    await api.reorderAiChannels(ids, previousIds);
    emit('update:channels', [...ids.map(id => props.channels.find(item => item.id === id)), ...props.channels.filter(item => !item.saved)]);
    orderMessage.value = '优先级顺序已保存';
  } catch (error) { orderMessage.value = error.message; }
  finally { ordering.value = false; }
}
function reportError(id, error) {
  notices.value[id] = { ok: false, text: error.message };
  if (error.status === 409 || error.status === 404) conflicts.value[id] = true;
}
async function removeChannel() {
  const channel = removeTarget.value;
  if (!channel || busy.value[channel.id]) return;
  busy.value[channel.id] = 'delete';
  try {
    if (channel.saved) await api.deleteAiChannel(channel.id, channel.revision);
    hideKey(channel.id);
    emit('update:channels', props.channels.filter(item => item.id !== channel.id));
    removeTarget.value = null;
  } catch (error) { reportError(channel.id, error); removeTarget.value = null; }
  finally { delete busy.value[channel.id]; }
}
function statusLabel(channel) {
  if (channel.dirty || !channel.saved) return '待保存';
  if (!channel.enabled) return '已停用';
  return ({ healthy: '连接正常', cooldown: '故障冷却中', degraded: '最近测试或请求失败', probing: '恢复探测中', unknown: '已保存 · 尚未测试' })[channel.health?.status] || '已保存';
}
function addressChanged(channel) { return channel.saved && channel.baseUrl.replace(/\/+$/, '') !== snapshots.get(channel.id)?.baseUrl.replace(/\/+$/, ''); }
function revert(id) {
  hideKey(id); delete results.value[id]; delete notices.value[id]; delete modelLists.value[id];
  if (snapshots.has(id)) patchRow(id, draft(snapshots.get(id)));
}
async function reloadChannel(channel) {
  busy.value[channel.id] = 'reload';
  try {
    const cfg = await api.getAiConfig();
    const latest = cfg.channels.find(item => item.id === channel.id);
    hideKey(channel.id);
    if (latest) { patchRow(channel.id, draft(latest)); snapshots.set(channel.id, draft(latest)); }
    else emit('update:channels', props.channels.filter(item => item.id !== channel.id));
    delete conflicts.value[channel.id]; delete results.value[channel.id]; delete notices.value[channel.id];
  } catch (error) { reportError(channel.id, error); }
  finally { delete busy.value[channel.id]; }
}
async function saveChannel(channel) {
  busy.value[channel.id] = 'save';
  try {
    const { name, baseUrl, apiKey, model, enabled, supportsTools, streamToolCalls, firstTokenTimeoutMs, revision } = channel;
    const result = await api.saveAiChannel(channel.id, { name, baseUrl, apiKey, model, enabled, supportsTools, streamToolCalls, firstTokenTimeoutMs, revision: revision ?? null });
    const saved = draft(result.channel);
    hideKey(channel.id); snapshots.set(channel.id, saved);
    const merged = props.channels.map(item => item.id === channel.id ? saved : item);
    emit('update:channels', result.order
      ? [...result.order.map(id => merged.find(item => item.id === id)).filter(Boolean), ...merged.filter(item => !result.order.includes(item.id))]
      : merged);
    notices.value[channel.id] = { ok: true, text: '此渠道已保存' }; delete conflicts.value[channel.id];
    return saved;
  } catch (error) { reportError(channel.id, error); return null; }
  finally { delete busy.value[channel.id]; }
}
async function fetchModels(channel) {
  busy.value[channel.id] = 'models';
  try {
    const { models } = await api.fetchAiModels({ channelId: channel.saved ? channel.id : undefined, baseUrl: channel.baseUrl, apiKey: channel.apiKey || undefined });
    const current = props.channels.find(item => item.id === channel.id);
    if (current?.baseUrl !== channel.baseUrl || current?.apiKey !== channel.apiKey) return;
    modelLists.value[channel.id] = models;
    notices.value[channel.id] = { ok: true, text: `已获取 ${models.length} 个模型，可在模型输入框中选择。` };
  } catch (error) { reportError(channel.id, error); }
  finally { delete busy.value[channel.id]; }
}
async function testChannel(channel) {
  if (channel.dirty || !channel.saved) { channel = await saveChannel(channel); if (!channel) return; }
  busy.value[channel.id] = 'test'; delete results.value[channel.id]; delete notices.value[channel.id];
  try {
    const result = await api.testAiChannel(channel.id);
    const current = props.channels.find(item => item.id === channel.id);
    if (current?.revision === channel.revision && !current.dirty) results.value[channel.id] = result;
  } catch (error) { reportError(channel.id, error); }
  finally { delete busy.value[channel.id]; emit('health-change'); }
}
function hideKey(id) { clearTimeout(hideTimers.get(id)); hideTimers.delete(id); delete revealed.value[id]; }
function clearKeys() { visible = false; revealEpoch++; for (const id of Object.keys(revealed.value)) hideKey(id); }
onActivated(() => { visible = true; });
onDeactivated(clearKeys);
onBeforeUnmount(clearKeys);
async function toggleKey(channel) {
  if (revealed.value[channel.id]) { hideKey(channel.id); return; }
  const epoch = revealEpoch;
  busy.value[channel.id] = 'reveal';
  try {
    const { apiKey } = await api.revealAiChannelKey(channel.id);
    if (!visible || epoch !== revealEpoch || !props.channels.some(item => item.id === channel.id)) return;
    revealed.value[channel.id] = apiKey;
    hideTimers.set(channel.id, setTimeout(() => hideKey(channel.id), 60000));
  } catch (error) { reportError(channel.id, error); }
  finally { delete busy.value[channel.id]; }
}
async function copyKey(id) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(revealed.value[id]);
    notices.value[id] = { ok: true, text: '密钥已复制' };
  } catch {
    keyInputs[id]?.focus(); keyInputs[id]?.select();
    notices.value[id] = { ok: true, text: '浏览器不支持直接复制，已选中密钥，请手动复制。' };
  }
}
</script>
