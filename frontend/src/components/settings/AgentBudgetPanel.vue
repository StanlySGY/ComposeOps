<template><section class="settings-section space-y-3"><h2 class="section-title">Agent 任务预算</h2><p class="text-sm text-muted">应用于新任务；恢复任务继续累计。上游未报告用量或请求失败时按输入字节和输出上限保守记账，金额不作推算。达到预算后停止后续调用和操作。</p><p v-if="error" class="alert-error" role="alert">{{ error }}</p><form v-if="limits" class="space-y-3" @submit.prevent="save"><div class="grid gap-3 sm:grid-cols-2"><label v-for="field in fields" :key="field.key" class="text-sm">{{ field.label }}<input v-model.number="limits[field.key]" type="number" class="input mt-1 w-full" :aria-label="field.label" :min="field.min" :max="field.max" required /></label></div><button class="btn-primary" :disabled="busy">保存任务预算</button><span class="ml-3 text-sm text-muted" role="status">{{ message }}</span></form></section></template>
<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../../api/client.js';
const limits = ref(null), error = ref(''), busy = ref(false), message = ref('');
const fields = [{ key: 'total', label: '单任务累计 token 预算', min: 10000, max: 2000000 }, { key: 'inputBytes', label: '单次上下文上限（字节）', min: 8000, max: 256000 }, { key: 'output', label: '单次输出 token 上限', min: 256, max: 16384 }, { key: 'rounds', label: '最多请求次数（含备用渠道）', min: 1, max: 40 }, { key: 'toolChars', label: '单条工具结果字符上限', min: 1000, max: 24000 }];
async function save() { busy.value = true; error.value = ''; try { limits.value = (await api.saveAgentBudget(limits.value)).limits; message.value = '已保存，新任务生效'; } catch (e) { error.value = e.message; } finally { busy.value = false; } }
onMounted(async () => { try { limits.value = (await api.getAgentBudget()).limits; } catch (e) { error.value = e.message; } });
</script>
