<template>
  <nav v-if="target && target.path !== route.path" class="px-4 pt-4 sm:px-6" aria-label="返回来源页面">
    <button class="btn-ghost" @click="back"><ArrowLeft class="h-4 w-4" />{{ target.label }}</button>
  </nav>
</template>
<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft } from 'lucide-vue-next';
import { returnTarget } from '../../lib/deep-links.js';
const route = useRoute();
const router = useRouter();
const target = computed(() => returnTarget(route.query.from));
function back() {
  const previous = window.history.state?.back;
  if (previous && router.resolve(previous).path === target.value.path) router.back();
  else router.push(target.value.path);
}
</script>
