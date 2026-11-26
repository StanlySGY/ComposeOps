<!-- eslint-disable vue/no-v-html -- 思考正文是纯文本,统一用 textContent 语义渲染。 -->
<template>
  <details v-if="groups.length" class="agent-thinking-block" :class="{ 'is-live': live }" @toggle="onToggle">
    <summary>
      <Brain class="h-3.5 w-3.5" />
      <span>思考过程</span>
      <em v-if="groups.length > 1">{{ groups.length }} 轮</em>
      <span v-if="live" class="agent-thinking-live"><i></i>思考中</span>
    </summary>
    <div ref="bodyEl" class="agent-thinking-body">
      <section v-for="group in groups" :key="group.round" class="agent-thinking-round">
        <header><span>第 {{ group.round }} 轮</span><i v-if="group.round === lastRound && live" class="agent-thinking-dot"></i></header>
        <p v-if="group.content">{{ group.content }}</p>
        <p v-else class="agent-thinking-pending">正在生成推理内容…</p>
      </section>
    </div>
  </details>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { Brain } from 'lucide-vue-next';

/**
 * 思考过程面板(工作台与页面 Agent 抽屉共用)。
 *
 * 设计取舍:思考按"轮次"分组,而不是一段不断被覆盖的纯文本。
 * 之前每个 reasoning/占位事件都整体覆盖同一个字段,执行结束又被置空,
 * 结果就是用户点开只看到一句"正在思考第 1 轮",结束后什么都没有。
 */
const props = defineProps({
  thinking: { type: Array, default: () => [] },
  live: { type: Boolean, default: false },
});

// 空轮次只在执行中显示(作为"正在生成"的占位);执行结束后若模型没给过推理内容,
// 整个面板就不出现 —— 否则非推理模型会永远挂着一个空的"思考过程"。
const groups = computed(() => (Array.isArray(props.thinking) ? props.thinking : [])
  .filter((group) => group && (group.content || props.live)));
const lastRound = computed(() => groups.value[groups.value.length - 1]?.round || 0);
const bodyEl = ref(null);
// 思考是流式追加的:面板展开时跟随到底部,但用户手动回看时不打断。
const stickToBottom = ref(true);

function onToggle(event) {
  if (event.target.open) {
    stickToBottom.value = true;
    void nextTick(scrollBottom);
  }
}

function scrollBottom() {
  const el = bodyEl.value;
  if (el && stickToBottom.value) el.scrollTop = el.scrollHeight;
}

watch(() => groups.value.map((group) => group.content).join('|'), () => { void nextTick(scrollBottom); });
</script>

<style scoped>
.agent-thinking-block { margin-bottom: 9px; border: 1px solid rgba(148, 163, 184, 0.16); border-radius: 10px; background: rgba(var(--ui-panel-rgb), 0.6); }
.agent-thinking-block.is-live { border-color: rgba(8, 145, 178, 0.42); }
.agent-thinking-block > summary { display: flex; align-items: center; gap: 6px; padding: 8px 11px; color: var(--cyan-strong); font-size: 11px; font-weight: 600; cursor: pointer; list-style: none; }
.agent-thinking-block > summary::-webkit-details-marker { display: none; }
.agent-thinking-block > summary em { padding: 1px 6px; color: var(--cyan-faint); border-radius: 999px; background: rgba(8, 145, 178, 0.22); font-size: 9.5px; font-style: normal; }
.agent-thinking-block > summary::after { content: ''; margin-left: auto; color: var(--text-dim); font-size: 11px; transition: transform 0.15s ease; }
.agent-thinking-block[open] > summary::after { transform: rotate(180deg); }
.agent-thinking-live { display: inline-flex; align-items: center; gap: 4px; color: var(--cyan-faint); font-size: 9.5px; font-weight: 500; }
.agent-thinking-live i { width: 5px; height: 5px; border-radius: 999px; background: var(--cyan-main); animation: thinking-pulse 1.1s ease-in-out infinite; }
@keyframes thinking-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1); } }
.agent-thinking-body { max-height: 280px; overflow-y: auto; padding: 2px 11px 10px; overscroll-behavior: contain; }
.agent-thinking-round + .agent-thinking-round { margin-top: 9px; padding-top: 9px; border-top: 1px dashed rgba(148, 163, 184, 0.14); }
.agent-thinking-round header { display: flex; align-items: center; gap: 6px; color: var(--text-faint); font-size: 9.5px; font-weight: 600; letter-spacing: 0.02em; }
.agent-thinking-dot { width: 5px; height: 5px; border-radius: 999px; background: var(--cyan-main); animation: thinking-pulse 1.1s ease-in-out infinite; }
.agent-thinking-round p { margin: 5px 0 0; color: var(--text-soft); font-size: 11.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.agent-thinking-round p.agent-thinking-pending { color: var(--text-dim); font-style: italic; }
</style>
