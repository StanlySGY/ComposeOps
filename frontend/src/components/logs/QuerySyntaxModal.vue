<template>
  <BaseModal :show="open" title="日志查询语法" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl flex max-h-[85vh] flex-col" body-class="min-h-0 flex-1 overflow-y-auto p-4" @close="close">
    <template #header-actions>
      <Braces class="w-4 h-4 text-accent" />
    </template>
    <p class="text-sm text-surface-300">搜索框支持字段谓词、短语、正则与布尔组合。空格即“与”,`|` 即“或”;写错时只提示,不会清空已有日志。</p>
    <div class="mt-3 table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>写法</th><th>含义</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.token">
            <td><code class="query-token">{{ row.token }}</code></td>
            <td class="text-surface-300">{{ row.note }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="mt-4 border-t border-surface-800 pt-3">
      <p class="section-eyebrow">组合示例</p>
      <ul class="mt-2 space-y-1.5">
        <li v-for="example in examples" :key="example.query" class="flex flex-wrap items-baseline gap-2 text-sm">
          <code class="query-token">{{ example.query }}</code>
          <span class="text-muted">{{ example.note }}</span>
        </li>
      </ul>
    </div>
    <template #footer>
      <button class="btn-secondary" @click="close">关闭</button>
    </template>
  </BaseModal>
</template>

<script setup>
import { Braces } from 'lucide-vue-next';
import BaseModal from '../common/BaseModal.vue';
import { QUERY_SYNTAX } from '../../lib/log-query.js';

defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);
function close() { emit('close'); }

const rows = QUERY_SYNTAX;
const examples = [
  { query: 'level:error container:api', note: 'api 容器的错误日志' },
  { query: 'stream:stderr !health', note: '标准错误里排除健康检查' },
  { query: 'after:09:30 before:10:00', note: '只看 09:30–10:00 这段' },
  { query: '"connection reset" | /ETIMEDOUT/i', note: '短语或正则,任一命中' },
];
</script>
