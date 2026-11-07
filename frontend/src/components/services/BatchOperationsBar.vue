<template>
  <div class="bulk-bar" role="region" aria-label="批量项目操作">
    <div class="flex min-w-0 items-center gap-2"><CheckSquare2 class="h-4 w-4 text-status-info" /><span class="text-sm font-medium">已选择 {{ selectedCount }} 个项目</span><span class="hidden text-muted sm:inline">批量操作将按顺序执行</span><span v-if="hiddenCount" class="text-xs text-status-warn" role="status">其中 {{ hiddenCount }} 个不在当前筛选中</span></div>
    <div class="flex flex-wrap gap-2 sm:ml-auto">
      <button class="btn-primary" :disabled="busy" @click="$emit('run', 'up')"><Play class="h-4 w-4" />启动</button>
      <button class="btn-secondary" :disabled="busy" @click="$emit('run', 'restart')"><RotateCw class="h-4 w-4" />重启</button>
      <button class="btn-secondary" :disabled="busy || !canPull" title="仅下载镜像；完成后需应用配置才能更新容器" @click="$emit('run', 'pull')"><Download class="h-4 w-4" />拉取更新</button>
      <button class="btn-danger" :disabled="busy" @click="$emit('run', 'stop')"><Square class="h-4 w-4" />停止</button>
      <button class="btn-ghost" @click="$emit('clear')">取消选择</button>
    </div>
  </div>
</template>

<script setup>
import { CheckSquare2, Download, Play, RotateCw, Square } from 'lucide-vue-next';

defineProps({ selectedCount: { type: Number, default: 0 }, hiddenCount: { type: Number, default: 0 }, canPull: { type: Boolean, default: true }, busy: Boolean });
defineEmits(['run', 'clear']);
</script>

<style scoped>
.bulk-bar { position: sticky; top: 0; z-index: 20; border-color: var(--color-accent); background: var(--panel-raised); box-shadow: 0 6px 20px #0003; }
.bulk-bar > :first-child { flex-wrap: wrap; }
@media (max-width: 639px) { .bulk-bar { padding: 10px; gap: 10px; } .bulk-bar > :last-child { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; gap: 6px; } .bulk-bar button { padding-inline: 7px; font-size: 12px; } }
</style>
