<template>
  <nav class="tabs-segment overflow-x-auto" aria-label="任务中心导航">
    <router-link v-for="item in items" :key="item.to" :to="item.to" :class="{ active: route.path === item.to }" :aria-current="route.path === item.to ? 'page' : undefined">{{ item.label }}</router-link>
  </nav>
</template>
<script setup>
import { useRoute } from 'vue-router';
const route = useRoute();
const items = [{ to: '/ops-center', label: '运行与审批' }, { to: '/tickets', label: '工单' }, { to: '/maintenance-plan', label: '运维计划' }, { to: '/workflows', label: '工作流' }, { to: '/cron', label: '定时任务' }];
</script>
