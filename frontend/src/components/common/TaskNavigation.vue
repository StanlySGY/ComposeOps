<template>
  <nav ref="navigation" class="tabs-segment overflow-x-auto" aria-label="任务中心导航">
    <router-link v-for="item in items" :key="item.to" :to="item.to" :class="{ active: route.path === item.to }" :aria-current="route.path === item.to ? 'page' : undefined">{{ item.label }}</router-link>
  </nav>
</template>
<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
const route = useRoute();
const navigation = ref(null);
const items = [{ to: '/ops-center', label: '运行与审批' }, { to: '/tickets', label: '工单' }, { to: '/maintenance-plan', label: '运维计划' }, { to: '/workflows', label: '工作流' }, { to: '/cron', label: '定时任务' }];
function revealCurrent() {
  const nav = navigation.value;
  const active = nav?.querySelector('[aria-current="page"]');
  if (!nav || !active) return;
  const bounds = nav.getBoundingClientRect();
  const current = active.getBoundingClientRect();
  // Move only the horizontal strip; scrolling the page here would disturb restored route position.
  if (current.left < bounds.left) nav.scrollLeft -= bounds.left - current.left + 6;
  else if (current.right > bounds.right) nav.scrollLeft += current.right - bounds.right + 6;
}
watch(() => route.path, async () => { await nextTick(); revealCurrent(); });
let observer;
onMounted(() => { revealCurrent(); if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(revealCurrent); observer.observe(navigation.value); } });
onBeforeUnmount(() => observer?.disconnect());
</script>
