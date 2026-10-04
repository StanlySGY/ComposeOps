<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">变更与回滚</h1>
        <p class="page-subtitle">部署前 AI 评审 Compose 变更,出问题后统一回滚配置、数据卷与镜像</p>
      </div>
    </div>
    <div class="tabs-segment" role="tablist" aria-label="变更与回滚视图">
      <button :class="{ active: tab === 'review' }" role="tab" :aria-selected="tab === 'review'" @click="setTab('review')"><FileSearch class="h-4 w-4" />变更评审</button>
      <button :class="{ active: tab === 'rollback' }" role="tab" :aria-selected="tab === 'rollback'" @click="setTab('rollback')"><RotateCcw class="h-4 w-4" />自动回滚</button>
    </div>
    <ChangeReviewView v-if="tab === 'review'" embedded />
    <RollbackView v-else embedded />
  </div>
</template>
<script setup>
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { FileSearch, RotateCcw } from 'lucide-vue-next';
import ChangeReviewView from './ChangeReviewView.vue';
import RollbackView from './RollbackView.vue';

const route = useRoute();
const router = useRouter();
const tab = ref(route.query.tab === 'rollback' ? 'rollback' : 'review');
function setTab(next) {
  tab.value = next;
  const query = { ...route.query };
  if (next === 'rollback') query.tab = 'rollback'; else delete query.tab;
  router.replace({ query });
}
watch(() => route.query.tab, (value) => { tab.value = value === 'rollback' ? 'rollback' : 'review'; });
</script>
