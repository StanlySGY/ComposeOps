<template>
  <div class="bulk-bar">
    <div class="flex min-w-0 items-center gap-2"><CheckSquare2 class="h-4 w-4 text-status-info" /><span class="text-sm font-medium">已选择 {{ selectedCount }} 个项目</span><span class="hidden text-muted sm:inline">批量操作将按顺序执行</span></div>
    <div class="flex flex-wrap gap-2 sm:ml-auto">
      <button class="btn-primary" :disabled="busy" @click="$emit('run', 'up')"><Play class="h-4 w-4" />启动</button>
      <button class="btn-secondary" :disabled="busy" @click="$emit('run', 'restart')"><RotateCw class="h-4 w-4" />重启</button>
      <button class="btn-secondary" :disabled="busy" title="拉取镜像更新，完成后可重启项目应用" @click="$emit('run', 'pull')"><Download class="h-4 w-4" />拉取更新</button>
      <button class="btn-danger" :disabled="busy" @click="$emit('run', 'stop')"><Square class="h-4 w-4" />停止</button>
      <button class="btn-ghost" @click="$emit('clear')">取消选择</button>
    </div>
  </div>
</template>

<script setup>
import { CheckSquare2, Download, Play, RotateCw, Square } from 'lucide-vue-next';

defineProps({ selectedCount: { type: Number, default: 0 }, busy: Boolean });
defineEmits(['run', 'clear']);
</script>
