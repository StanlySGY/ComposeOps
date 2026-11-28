<template><section class="settings-section space-y-3"><h2 class="section-title">数据库容量与事件归档</h2><p v-if="error" class="alert-error" role="alert">{{ error }}</p><template v-if="data"><div class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><div v-for="item in stats" :key="item.label"><p class="text-muted">{{ item.label }}</p><strong>{{ (item.value / 1024 ** 2).toFixed(1) }} MiB</strong></div></div><p v-for="warning in data.warnings" :key="warning" class="alert-warning">{{ warning }}</p><p class="text-sm text-muted">{{ data.note }}</p><p class="text-xs text-muted">容量增长与磁盘阈值告警可在「应用可靠性 → 平台健康」查看。</p><div class="flex flex-wrap gap-2"><button class="btn-secondary" :disabled="busy" @click="load">刷新容量</button><button class="btn-secondary" :disabled="busy || !data.archiveConfigured" @click="toggle">{{ data.archiveEnabled ? '暂停自动归档' : '启用每 6 小时加密归档' }}</button><button class="btn-secondary" :disabled="busy || !data.archiveEnabled" @click="archive">归档一批已过期事件</button></div><p v-if="!data.archiveConfigured" class="text-xs text-muted">部署时配置独立归档目录后可启用。归档需要外置数据库密钥；不会删除正在执行、待恢复或待核对任务的证据。</p><p v-if="data.lastArchive" class="text-xs text-muted">最近归档 {{ data.lastArchive.archived }} 条，已解密核对 · {{ new Date(data.lastArchive.at).toLocaleString() }}</p></template></section></template>
<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api/client.js';
const data = ref(null), busy = ref(false), error = ref('');
const stats = computed(() => [{ label: '数据库文件', value: data.value.databaseBytes }, { label: 'WAL', value: data.value.walBytes }, { label: '可复用空页', value: data.value.reusableBytes }, { label: '磁盘可用', value: data.value.freeBytes }]);
async function work(fn) { busy.value = true; error.value = ''; try { data.value = await fn(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
const load = () => work(() => api.getDataLifecycle());
const toggle = () => work(() => api.saveDataLifecycle(!data.value.archiveEnabled));
const archive = () => work(() => api.archiveRunEvents());
onMounted(load);
</script>
