<template>
  <RouterLink v-if="!disabled" :to="to"><slot /></RouterLink>
  <span v-else role="link" aria-disabled="true" :title="reason" class="capability-link-disabled"><slot /></span>
</template>

<script setup>
import { RouterLink } from 'vue-router';
defineProps({ to: { type: [String, Object], required: true }, disabled: Boolean, reason: { type: String, default: '当前不可用' } });
</script>

<style scoped>
.capability-link-disabled { opacity: .45; cursor: not-allowed; }
</style>
