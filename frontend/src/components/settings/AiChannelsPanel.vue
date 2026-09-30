<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div><h2 class="section-title">AI 渠道</h2><p class="mt-1 text-xs text-surface-400">从上到下优先使用已启用的渠道，兼容直连接口和 New API。</p></div>
      <button class="btn-secondary" :disabled="channels.length >= 12" @click="addChannel"><Plus class="w-4 h-4" />添加渠道</button>
    </div>
    <label class="toggle-label"><input type="checkbox" :checked="failoverEnabled" @change="$emit('update:failoverEnabled', $event.target.checked)" />故障时自动切换备用渠道</label>
    <p class="text-xs text-surface-500">超时、限流或服务异常时按顺序尝试。已开始输出的回复会明确报错；已完成的运维操作不会重复执行。连续失败的渠道会暂时跳过，冷却后自动探测。</p>
    <p v-if="!channels.length" class="rounded-xl border border-dashed border-surface-700 p-6 text-center text-sm text-surface-400">还没有 AI 渠道。添加一个渠道开始使用，也可以填写现有 New API 的地址和令牌。</p>
    <article v-for="(channel, index) in channels" :key="channel.id" class="card space-y-3 p-4" :data-channel-id="channel.id">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2"><span class="count-badge">{{ index + 1 }}</span><strong class="text-sm text-surface-100 break-all">{{ channel.name || '新渠道' }}</strong><span class="text-xs" :class="channel.health?.status === 'healthy' ? 'text-emerald-400' : 'text-surface-400'">{{ statusLabel(channel) }}</span></div>
        <div class="flex items-center gap-1">
          <label class="toggle-label mr-2"><input type="checkbox" :checked="channel.enabled" @change="update(index, { enabled: $event.target.checked })" />启用</label>
          <button class="icon-btn" title="提高优先级" aria-label="提高优先级" :disabled="index === 0" @click="move(index, -1)"><ArrowUp class="w-4 h-4" /></button>
          <button class="icon-btn" title="降低优先级" aria-label="降低优先级" :disabled="index === channels.length - 1" @click="move(index, 1)"><ArrowDown class="w-4 h-4" /></button>
          <button class="icon-btn" title="移除渠道，保存后生效" aria-label="移除渠道" @click="remove(index)"><Trash2 class="w-4 h-4" /></button>
        </div>
      </div>
      <div class="form-grid">
        <label>渠道名称<input class="input" :value="channel.name" maxlength="80" placeholder="例如：主渠道 / 备用 / New API" @input="update(index, { name: $event.target.value })" /></label>
        <label>接口地址<input class="input" :value="channel.baseUrl" placeholder="https://example.com/v1" @input="update(index, { baseUrl: $event.target.value })" /></label>
        <label>API Key<input class="input" type="password" autocomplete="new-password" :value="channel.apiKey" :placeholder="channel.hasApiKey ? '已配置，留空保留；更改地址需重新填写' : '填写此渠道的密钥或 New API 令牌'" @input="update(index, { apiKey: $event.target.value })" /></label>
        <label>模型
          <div class="flex items-center gap-1.5"><input class="input min-w-0 flex-1" :value="channel.model" :list="`models-${channel.id}`" placeholder="输入或获取模型名称" @input="update(index, { model: $event.target.value })" /><button class="icon-btn shrink-0" title="获取此渠道的模型" aria-label="获取此渠道的模型" :disabled="!!busy[channel.id]" @click="fetchModels(channel)"><RefreshCw class="w-4 h-4" :class="{ 'animate-spin': busy[channel.id] === 'models' }" /></button></div>
          <datalist :id="`models-${channel.id}`"><option v-for="name in modelLists[channel.id] || []" :key="name" :value="name" /></datalist>
        </label>
        <label>首段响应等待（秒）<input class="input" type="number" min="1" max="120" :value="channel.firstTokenTimeoutMs / 1000" @input="update(index, { firstTokenTimeoutMs: Number($event.target.value) * 1000 })" /></label>
        <label class="toggle-label self-center flex-row!"><input type="checkbox" :checked="channel.supportsTools" @change="update(index, { supportsTools: $event.target.checked })" />支持工具调用（AI 助手必需）</label>
      </div>
      <div class="flex flex-wrap items-center gap-3"><button class="btn-secondary" :disabled="channel.dirty || !channel.saved || !!busy[channel.id]" @click="testChannel(channel)"><Activity class="w-4 h-4" />{{ busy[channel.id] === 'test' ? '测试中…' : '测试连接' }}</button><span v-if="channel.dirty || !channel.saved" class="text-xs text-surface-500">保存后可测试；测试会发起少量模型请求。</span><span v-else class="text-xs text-surface-500">{{ channel.supportsTools ? '同时验证工具调用，测试工具不会实际执行。' : '仅验证聊天能力。' }}</span></div>
      <p v-if="results[channel.id]" class="text-xs break-words" :class="results[channel.id].ok ? 'text-emerald-400' : 'text-rose-400'">{{ results[channel.id].text }}</p>
      <p v-else-if="channel.health?.lastError" class="text-xs text-amber-400">最近故障：{{ channel.health.lastError }}<span v-if="channel.health.cooldownUntil > Date.now()"> · 冷却至 {{ new Date(channel.health.cooldownUntil).toLocaleTimeString() }}</span></p>
    </article>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { Activity, ArrowDown, ArrowUp, Plus, RefreshCw, Trash2 } from 'lucide-vue-next';
import { api } from '../../api/client.js';

const props = defineProps({ channels: { type: Array, default: () => [] }, failoverEnabled: { type: Boolean, default: true } });
const emit = defineEmits(['update:channels', 'update:failoverEnabled', 'health-change']);
const busy = ref({});
const results = ref({});
const modelLists = ref({});
function update(index, patch) {
  const channel = props.channels[index];
  if ('baseUrl' in patch || 'apiKey' in patch) delete modelLists.value[channel.id];
  delete results.value[channel.id];
  emit('update:channels', props.channels.map((item, i) => i === index ? { ...item, ...patch, dirty: true } : item));
}
function addChannel() {
  emit('update:channels', [...props.channels, { id: `channel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: '', baseUrl: '', apiKey: '', model: '', enabled: true, supportsTools: true, firstTokenTimeoutMs: 30000, saved: false, dirty: true }]);
}
function move(index, offset) {
  const next = [...props.channels];
  [next[index], next[index + offset]] = [next[index + offset], next[index]];
  emit('update:channels', next);
}
function remove(index) { emit('update:channels', props.channels.filter((_, i) => i !== index)); }
function statusLabel(channel) {
  if (!channel.enabled) return '已停用';
  if (channel.dirty || !channel.saved) return '待保存';
  return ({ healthy: '最近连接正常', cooldown: '故障冷却中', degraded: '最近请求失败', probing: '恢复探测中', unknown: '尚未测试' })[channel.health?.status] || '尚未测试';
}
async function fetchModels(channel) {
  busy.value[channel.id] = 'models';
  try {
    const { models } = await api.fetchAiModels({ channelId: channel.saved ? channel.id : undefined, baseUrl: channel.baseUrl, apiKey: channel.apiKey || undefined });
    const current = props.channels.find((item) => item.id === channel.id);
    if (current?.baseUrl !== channel.baseUrl || current?.apiKey !== channel.apiKey) return;
    modelLists.value[channel.id] = models;
    results.value[channel.id] = { ok: true, text: `已获取 ${models.length} 个模型，可在模型输入框中选择。` };
  } catch (error) { results.value[channel.id] = { ok: false, text: error.message }; }
  finally { delete busy.value[channel.id]; }
}
async function testChannel(channel) {
  busy.value[channel.id] = 'test';
  try {
    const result = await api.testAiChannel(channel.id);
    results.value[channel.id] = { ok: true, text: `连接成功 · ${result.latencyMs} ms${result.supportsTools ? ' · 工具调用通过' : ''}` };
  } catch (error) { results.value[channel.id] = { ok: false, text: error.message }; }
  finally { delete busy.value[channel.id]; emit('health-change'); }
}
</script>
