<template>
  <section class="session-browser" aria-label="会话记录" :aria-busy="loading">
    <header class="session-browser-head">
      <div><h2>会话记录</h2><p>{{ sessions.length ? `最近 ${sessions.length} 个会话` : '继续之前的工作' }}</p></div>
      <div class="session-browser-tools">
        <button class="icon-btn" aria-label="刷新会话列表" :disabled="loading || busy" @click="$emit('refresh')"><RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" /></button>
        <button class="icon-btn" aria-label="新建会话" :disabled="busy" @click="$emit('new')"><Plus class="h-4 w-4" /></button>
        <slot name="close" />
      </div>
    </header>
    <div class="session-browser-search"><label class="search-field"><Search class="h-3.5 w-3.5" /><input :value="query" aria-label="搜索已加载会话" placeholder="搜索标题或会话 ID" @input="$emit('update:query', $event.target.value)" /></label></div>
    <div v-if="error" class="session-browser-error" role="alert"><p>{{ error }}<span v-if="sessions.length">，保留上次列表。</span></p><button :disabled="loading || busy" class="text-link" @click="$emit('refresh')">重试会话列表</button></div>
    <div v-if="sessions.length" class="session-browser-selection"><label><input type="checkbox" :disabled="busy" :checked="allSelected" :indeterminate="someSelected" @change="$emit('toggle-all')" />全选当前列表</label><button v-if="selected.length" :disabled="busy" @click="$emit('delete-selected')">删除 {{ selected.length }} 个</button></div>
    <div class="session-browser-list">
      <p v-if="loading && !sessions.length" class="session-browser-empty" role="status">正在读取会话…</p>
      <p v-else-if="!error && !sessions.length" class="session-browser-empty">发送第一条消息后，会话会自动保存。</p>
      <div v-else-if="!error && !filtered.length" class="session-browser-empty"><p>没有匹配的会话</p><button class="text-link" @click="$emit('update:query', '')">清除搜索</button></div>
      <div v-for="session in filtered" :key="session.sessionId" class="session-browser-row" :class="{ active: session.sessionId === activeId, selected: selected.includes(session.sessionId) }">
        <template v-if="renamingId === session.sessionId">
          <form class="session-rename-form" @submit.prevent="$emit('save-rename', session)">
            <label><span>会话标题</span><input ref="renameInputs" :value="renameTitle" :disabled="renameBusy" maxlength="80" aria-label="会话标题" @input="$emit('update:renameTitle', $event.target.value)" @keydown.esc.stop.prevent="!renameBusy && $emit('cancel-rename')" /></label>
            <p v-if="renameError" role="alert">{{ renameError }}</p>
            <div><button type="button" :disabled="renameBusy" @click="$emit('cancel-rename')">取消</button><button type="submit" :disabled="renameBusy || !renameTitle.trim()">{{ renameBusy ? '保存中…' : '保存标题' }}</button></div>
          </form>
        </template>
        <template v-else>
          <input class="session-browser-check" type="checkbox" :disabled="busy" :checked="selected.includes(session.sessionId)" :aria-label="`选择会话 ${session.title || session.sessionId}`" @change="$emit('toggle', session.sessionId)" />
          <button class="session-browser-open" :disabled="busy" :aria-current="session.sessionId === activeId ? 'true' : undefined" :title="session.title || `会话 #${session.sessionId}`" @click="$emit('select', session.sessionId)"><span class="session-browser-title">{{ session.title || '未命名会话' }}</span><span class="session-browser-meta">{{ formatDate(session.createdAt) }}<i>·</i>{{ session.messageCount }} 条消息</span></button>
          <div class="session-browser-row-actions"><button :disabled="busy" :aria-label="`重命名会话 ${session.title || session.sessionId}`" @click="$emit('rename', session)"><Pencil class="h-3.5 w-3.5" /></button><button :disabled="busy" :aria-label="`删除会话 ${session.title || session.sessionId}`" @click="$emit('delete', session.sessionId)"><Trash2 class="h-3.5 w-3.5" /></button></div>
        </template>
      </div>
    </div>
    <p v-if="sessions.length >= 50" class="session-browser-limit">仅搜索最近加载的 50 个会话；可从执行历史直达更早会话。</p>
  </section>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-vue-next';
const props = defineProps({
  sessions: { type: Array, default: () => [] }, activeId: { type: Number, default: null },
  query: { type: String, default: '' }, selected: { type: Array, default: () => [] },
  loading: Boolean, error: { type: String, default: '' }, busy: Boolean,
  renamingId: { type: Number, default: null }, renameTitle: { type: String, default: '' },
  renameBusy: Boolean, renameError: { type: String, default: '' },
});
defineEmits(['refresh','new','select','toggle','toggle-all','rename','save-rename','cancel-rename','delete','delete-selected','update:query','update:renameTitle']);
const filtered = computed(() => {
  const query = props.query.trim().toLowerCase();
  return props.sessions.filter(session => !query || String(session.title || '').toLowerCase().includes(query) || String(session.sessionId).includes(query));
});
const allSelected = computed(() => filtered.value.length > 0 && filtered.value.every(session => props.selected.includes(session.sessionId)));
const someSelected = computed(() => filtered.value.some(session => props.selected.includes(session.sessionId)) && !allSelected.value);
const renameInputs = ref([]);
watch(() => props.renamingId, async id => {
  if (!id) return;
  await nextTick();
  const input = renameInputs.value.find(element => element.getClientRects().length > 0);
  input?.focus(); input?.select();
});
function formatDate(value) {
  if (!value) return '';
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}
</script>

<style scoped>
.session-browser { display:flex; flex-direction:column; min-height:0; height:100%; color:var(--color-surface-300); }
.session-browser-head { display:flex; justify-content:space-between; align-items:center; gap:.5rem; padding:1rem .85rem .75rem; }
.session-browser-head h2 { font-size:.82rem; font-weight:650; color:var(--color-surface-100); }
.session-browser-head p { margin-top:.2rem; font-size:.65rem; color:var(--color-surface-400); }
.session-browser-tools { display:flex; gap:.25rem; }
.session-browser-tools .icon-btn { width:1.8rem; height:1.8rem; }
.session-browser-search { padding:0 .65rem .75rem; }
.session-browser-search .search-field { min-height:2rem; font-size:.73rem; }
.session-browser-error { padding:.7rem .85rem; color:var(--color-status-error); font-size:.73rem; line-height:1.6; }
.session-browser-selection { display:flex; justify-content:space-between; align-items:center; gap:.5rem; margin:0 .7rem; padding:.5rem 0; border-block:1px solid var(--color-surface-800); font-size:.65rem; }
.session-browser-selection label { display:flex; align-items:center; gap:.4rem; }
.session-browser-selection button { color:var(--color-status-error); }
.session-browser-list { min-height:0; flex:1; overflow-y:auto; padding:.5rem; }
.session-browser-row { position:relative; display:flex; align-items:center; gap:.3rem; margin-bottom:.2rem; padding:.25rem .4rem; border:1px solid transparent; border-radius:.65rem; transition:background 150ms ease,border-color 150ms ease; }
.session-browser-row:hover { background:rgb(255 255 255 / .025); }
.session-browser-row.active { background:rgb(16 185 129 / .065); border-color:rgb(16 185 129 / .18); }
.session-browser-row.active::before { content:''; position:absolute; left:-.5rem; width:2px; height:1.5rem; border-radius:2px; background:var(--color-status-ok); }
.session-browser-row.selected { border-color:rgb(56 189 248 / .25); }
.session-browser-check { flex-shrink:0; width:.85rem; height:.85rem; accent-color:var(--color-status-ok); }
.session-browser-open { flex:1; min-width:0; padding:.55rem .15rem; text-align:left; }
.session-browser-title { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:var(--color-surface-100); font-size:.75rem; font-weight:550; }
.session-browser-meta { display:flex; align-items:center; flex-wrap:wrap; gap:.25rem; margin-top:.3rem; color:var(--color-surface-400); font-size:.61rem; }
.session-browser-meta i { font-style:normal; }
.session-browser-row-actions { display:flex; flex-shrink:0; }
.session-browser-row-actions button { display:grid; width:1.6rem; height:1.8rem; place-items:center; border-radius:.35rem; color:var(--color-surface-400); }
.session-browser-row-actions button:hover { color:var(--color-surface-100); background:rgb(255 255 255 / .06); }
.session-browser-row-actions button:last-child:hover { color:var(--color-status-error); }
.session-browser-empty { padding:1.5rem .5rem; font-size:.75rem; line-height:1.7; color:var(--color-surface-400); text-align:center; }
.session-browser-limit { padding:.6rem .85rem; border-top:1px solid var(--color-surface-800); font-size:.65rem; line-height:1.6; color:var(--color-surface-400); }
.session-rename-form { width:100%; min-width:0; padding:.4rem 0; font-size:.73rem; }
.session-rename-form label { display:flex; flex-direction:column; gap:.4rem; }
.session-rename-form input { min-width:0; width:100%; padding:.5rem; border:1px solid var(--color-surface-600); border-radius:.4rem; background:var(--color-surface-950); color:var(--color-surface-100); }
.session-rename-form p { padding:.4rem 0; color:var(--color-status-error); }
.session-rename-form > div { display:flex; justify-content:flex-end; gap:.75rem; margin-top:.5rem; }
.session-rename-form button { padding:.3rem .2rem; }
.session-rename-form button[type=submit] { color:var(--color-status-ok); }
button:disabled { opacity:.45; cursor:not-allowed; }
@media (hover:hover) { .session-browser-row-actions { opacity:.35; } .session-browser-row:hover .session-browser-row-actions,.session-browser-row:focus-within .session-browser-row-actions { opacity:1; } }
@media (prefers-reduced-motion:reduce) { .session-browser-row { transition:none; } }
</style>
