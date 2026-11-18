<template>
  <div class="agent-structured-ui" aria-label="结构化结果">
    <section v-for="(block, index) in blocks" :key="index" class="agent-ui-card">
      <template v-if="block.type === 'notice'">
        <div class="agent-ui-notice" :class="toneClass(block.tone)" role="status">
          <strong v-if="block.title">{{ block.title }}</strong>
          <p>{{ block.text }}</p>
        </div>
      </template>

      <template v-else-if="block.type === 'status'">
        <div class="agent-ui-heading">
          <strong>{{ block.title || '状态' }}</strong>
          <span class="agent-ui-status" :class="statusClass(block.status)">{{ statusLabel(block.status) }}</span>
        </div>
        <p v-if="block.detail" class="agent-ui-detail">{{ block.detail }}</p>
      </template>

      <template v-else-if="block.type === 'metrics'">
        <strong v-if="block.title" class="agent-ui-title">{{ block.title }}</strong>
        <div class="agent-ui-metrics">
          <div v-for="(item, itemIndex) in block.items || []" :key="itemIndex" class="agent-ui-metric">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}<small v-if="item.unit">{{ item.unit }}</small></strong>
            <em v-if="item.detail">{{ item.detail }}</em>
          </div>
        </div>
      </template>

      <template v-else-if="block.type === 'table'">
        <strong v-if="block.title" class="agent-ui-title">{{ block.title }}</strong>
        <div class="agent-ui-table-wrap">
          <table class="agent-ui-table">
            <thead><tr><th v-for="(column, columnIndex) in block.columns || []" :key="columnIndex">{{ column }}</th></tr></thead>
            <tbody>
              <tr v-for="(row, rowIndex) in block.rows || []" :key="rowIndex">
                <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <template v-else-if="block.type === 'steps'">
        <strong v-if="block.title" class="agent-ui-title">{{ block.title }}</strong>
        <ol class="agent-ui-steps">
          <li v-for="(item, itemIndex) in block.items || []" :key="itemIndex" :class="statusClass(item.status)">
            <span class="agent-ui-step-marker">{{ item.status === 'done' ? '✓' : item.status === 'error' ? '!' : itemIndex + 1 }}</span>
            <span class="min-w-0"><strong>{{ item.title }}</strong><small v-if="item.detail">{{ item.detail }}</small></span>
            <span class="agent-ui-step-state">{{ statusLabel(item.status) }}</span>
          </li>
        </ol>
      </template>
    </section>
  </div>
</template>

<script setup>
defineProps({
  blocks: { type: Array, default: () => [] },
});

function statusLabel(status) {
  return ({ healthy: '正常', warning: '注意', error: '异常', unknown: '未知', done: '完成', active: '进行中', pending: '待处理' })[status] || '未知';
}
function statusClass(status) {
  return ({ healthy: 'is-success', done: 'is-success', warning: 'is-warning', active: 'is-active', error: 'is-danger' })[status] || 'is-neutral';
}
function toneClass(tone) {
  return ({ success: 'is-success', warning: 'is-warning', danger: 'is-danger' })[tone] || 'is-neutral';
}
</script>

<style scoped>
.agent-structured-ui { display: grid; gap: 8px; margin: 10px 0; }
.agent-ui-card { min-width: 0; padding: 12px; border: 1px solid var(--border-subtle, rgba(148,163,184,.18)); border-radius: 12px; background: var(--surface-card, rgba(15,23,42,.28)); }
.agent-ui-title { display: block; margin-bottom: 9px; color: var(--text-primary, inherit); font-size: 12px; font-weight: 650; }
.agent-ui-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--text-primary, inherit); font-size: 12px; }
.agent-ui-status, .agent-ui-step-state { flex: none; border-radius: 999px; padding: 3px 8px; font-size: 10px; font-weight: 600; }
.agent-ui-detail { margin-top: 7px; color: var(--text-muted, #94a3b8); font-size: 11px; line-height: 1.55; }
.agent-ui-notice { padding: 9px 10px; border-left: 3px solid currentColor; border-radius: 7px; font-size: 11px; line-height: 1.6; }
.agent-ui-notice strong { display: block; margin-bottom: 2px; font-size: 12px; }
.agent-ui-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 7px; }
.agent-ui-metric { min-width: 0; padding: 9px; border-radius: 9px; background: rgba(148,163,184,.07); }
.agent-ui-metric > span, .agent-ui-metric em { display: block; color: var(--text-muted, #94a3b8); font-size: 10px; font-style: normal; }
.agent-ui-metric > strong { display: block; margin: 3px 0; color: var(--text-primary, inherit); font-size: 18px; font-weight: 700; overflow-wrap: anywhere; }
.agent-ui-metric small { margin-left: 3px; color: var(--text-muted, #94a3b8); font-size: 10px; font-weight: 500; }
.agent-ui-table-wrap { max-width: 100%; overflow-x: auto; }
.agent-ui-table { width: 100%; border-collapse: collapse; font-size: 10px; text-align: left; }
.agent-ui-table th { color: var(--text-muted, #94a3b8); font-weight: 600; }
.agent-ui-table th, .agent-ui-table td { padding: 7px 8px; border-bottom: 1px solid rgba(148,163,184,.12); white-space: nowrap; }
.agent-ui-table td { color: var(--text-primary, inherit); }
.agent-ui-steps { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.agent-ui-steps li { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.agent-ui-step-marker { display: grid; width: 20px; height: 20px; flex: none; place-items: center; border: 1px solid rgba(148,163,184,.25); border-radius: 50%; font-size: 10px; }
.agent-ui-steps li > span:nth-child(2) { display: grid; min-width: 0; flex: 1; gap: 2px; }
.agent-ui-steps strong { font-size: 11px; font-weight: 600; }
.agent-ui-steps small { color: var(--text-muted, #94a3b8); font-size: 10px; line-height: 1.45; }
.is-success { color: #34d399; background: rgba(16,185,129,.09); }
.is-warning { color: #fbbf24; background: rgba(245,158,11,.09); }
.is-danger { color: #fb7185; background: rgba(244,63,94,.09); }
.is-active { color: #60a5fa; background: rgba(59,130,246,.09); }
.is-neutral { color: var(--text-muted, #94a3b8); background: rgba(148,163,184,.07); }
@media (max-width: 480px) {
  .agent-ui-card { padding: 10px; }
  .agent-ui-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
