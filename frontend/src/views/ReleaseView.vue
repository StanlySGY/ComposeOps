<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">变更与回滚</h1>
        <p class="page-subtitle">部署前检查 Compose 变更,出问题后统一回滚配置、数据卷与镜像</p>
      </div>
    </div>
    <div class="tabs-segment" role="tablist" aria-label="变更与回滚视图" @keydown="handleTabKeydown">
      <button id="release-tab-review" data-tab="review" :class="{ active: tab === 'review' }" :disabled="busy" role="tab" aria-controls="release-panel" :aria-selected="tab === 'review'" :tabindex="tab === 'review' ? 0 : -1" @click="setTab('review')"><FileSearch class="h-4 w-4" />变更评审</button>
      <button id="release-tab-rollback" data-tab="rollback" :class="{ active: tab === 'rollback' }" :disabled="busy" role="tab" aria-controls="release-panel" :aria-selected="tab === 'rollback'" :tabindex="tab === 'rollback' ? 0 : -1" @click="setTab('rollback')"><RotateCcw class="h-4 w-4" />自动回滚</button>
    </div>
    <section id="release-panel" role="tabpanel" :aria-labelledby="`release-tab-${tab}`" tabindex="0">
      <KeepAlive>
        <component :is="tab === 'review' ? ChangeReviewView : RollbackView" embedded @busy="busy = $event" />
      </KeepAlive>
    </section>
  </div>
</template>
<script setup>
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { FileSearch, RotateCcw } from 'lucide-vue-next';
import ChangeReviewView from './ChangeReviewView.vue';
import RollbackView from './RollbackView.vue';
import { handleTablistKeydown } from '../lib/tablist-keyboard.js';

const route = useRoute();
const router = useRouter();
const busy = ref(false);
const tab = ref(route.query.tab === 'rollback' ? 'rollback' : 'review');
function handleTabKeydown(event) { handleTablistKeydown(event, setTab); }
function setTab(next) {
  if (busy.value || next === tab.value) return;
  tab.value = next;
  const query = { ...route.query };
  if (next === 'rollback') query.tab = 'rollback'; else delete query.tab;
  router.push({ query });
}
watch(() => route.query.tab, (value) => {
  const next = value === 'rollback' ? 'rollback' : 'review';
  if (busy.value && next !== tab.value) {
    void router.replace({ query: { ...route.query, tab: tab.value } });
    return;
  }
  tab.value = next;
});
</script>
