<template>
  <div class="group-picker">
    <select class="input" :value="creating ? '__new' : modelValue || ''" :disabled="disabled || saving" :aria-label="label" @change="select($event.target.value)">
      <option value="">未分组</option><option v-for="group in store.groups" :key="group.id" :value="group.id">{{ group.name }}</option><option value="__new">＋ 新建分组</option>
    </select>
    <div v-if="creating" class="group-picker-create"><input v-model="name" class="input" maxlength="40" :placeholder="suggestion || '例如：我的业务'" aria-label="新分组名称" :disabled="saving" @keydown.enter.prevent="create" /><button type="button" class="btn-secondary btn-sm" :disabled="saving || !name.trim()" @click="create">创建</button><button type="button" class="btn-ghost btn-sm" :disabled="saving" @click="creating = false">取消</button></div>
    <p v-if="error" class="text-status-error text-xs" role="alert">{{ error }}</p>
  </div>
</template>
<script setup>
import { ref } from 'vue';
import { useProjectGroupsStore } from '../../stores/project-groups.js';
const props = defineProps({ modelValue: { type: String, default: '' }, disabled: Boolean, suggestion: { type: String, default: '' }, label: { type: String, default: '项目分组' } });
const emit = defineEmits(['update:modelValue']);
const store = useProjectGroupsStore(), creating = ref(false), name = ref(''), error = ref(''), saving = ref(false);
function select(value) { error.value = ''; if (value === '__new') { creating.value = true; name.value = props.suggestion; } else { creating.value = false; emit('update:modelValue', value); } }
async function create() { if (saving.value || !name.value.trim()) return; saving.value = true; error.value = ''; try { const group = await store.save({ name: name.value.trim() }); emit('update:modelValue', group.id); creating.value = false; } catch (cause) { error.value = cause.message; } finally { saving.value = false; } }
</script>
<style scoped>
.group-picker{display:grid;gap:8px;min-width:0}.group-picker-create{display:flex;gap:6px;flex-wrap:wrap}.group-picker-create input{flex:1;min-width:120px}
</style>
