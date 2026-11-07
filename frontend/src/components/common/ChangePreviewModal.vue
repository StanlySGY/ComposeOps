<template>
  <BaseModal :show="show" :title="title" size-class="max-w-[calc(100vw-2rem)] sm:max-w-2xl" body-class="p-3 space-y-3 max-h-[70vh] overflow-auto" @close="emit('cancel')">
    <template v-if="preview">
      <div v-if="list('added').length" class="rounded-lg border border-status-ok/40 bg-status-ok/15 p-2.5">
        <div class="text-xs font-semibold text-status-ok">新增服务 {{ list('added').length }}</div>
        <div class="mt-1 flex flex-wrap gap-1.5"><span v-for="item in list('added')" :key="item.service" class="count-badge text-status-ok">{{ item.service }}</span></div>
      </div>
      <div v-if="list('changed').length" class="rounded-lg border border-status-warn/40 bg-status-warn/15 p-2.5">
        <div class="text-xs font-semibold text-status-warn">配置变更,容器将被重建 {{ list('changed').length }}</div>
        <div class="mt-1 space-y-1">
          <p v-for="item in list('changed')" :key="item.service" class="text-xs text-surface-300">{{ item.service }} <span class="text-surface-400">· {{ (item.reasons || []).join(', ') }}<template v-if="item.container"> · {{ item.container }}</template></span></p>
        </div>
      </div>
      <div v-if="list('restarted').length" class="rounded-lg border border-sky-900/40 bg-sky-950/20 p-2.5">
        <div class="text-xs font-semibold text-sky-300">运行中容器将重启 {{ list('restarted').length }}</div>
        <div class="mt-1 flex flex-wrap gap-1.5"><span v-for="item in list('restarted')" :key="item.service" class="count-badge text-sky-300">{{ item.service }}</span></div>
      </div>
      <div v-if="list('removed').length" class="rounded-lg border border-status-error/40 bg-status-error/15 p-2.5">
        <div class="text-xs font-semibold text-status-error">将被移除的服务 {{ list('removed').length }}</div>
        <div class="mt-1 space-y-1"><p v-for="item in list('removed')" :key="item.service" class="text-xs text-surface-300">{{ item.service }} <span class="text-surface-400">· {{ item.container }}<template v-if="item.state"> ({{ item.state }})</template></span></p></div>
      </div>
      <p v-if="!list('added').length && !list('changed').length && !list('restarted').length && !list('removed').length" class="text-xs text-surface-400">未检测到会影响现有容器的变更,可直接执行。</p>
    </template>
    <p v-else-if="fallbackMessage" class="text-xs text-surface-400">{{ fallbackMessage }}</p>
    <template #footer>
      <button class="btn-ghost" @click="emit('cancel')">取消</button>
      <button class="btn-primary" @click="emit('confirm')">{{ confirmText }}</button>
    </template>
  </BaseModal>
</template>

<script setup>
import BaseModal from './BaseModal.vue';

/**
 * 容器变更预览:Compose 保存、Env 应用、镜像升级等写操作前展示将影响的服务/容器。
 * preview 形如 { added: [], changed: [{service, reasons, container}], restarted: [], removed: [{service, container, state}] },字段均可缺省。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  preview: { type: Object, default: null },
  title: { type: String, default: '保存前变更预览' },
  confirmText: { type: String, default: '确认执行' },
  // 变更预览不可用时的兜底说明(空则隐藏)
  fallbackMessage: { type: String, default: '' },
});
const emit = defineEmits(['confirm', 'cancel']);

function list(name) { return Array.isArray(props.preview?.[name]) ? props.preview[name] : []; }
</script>
