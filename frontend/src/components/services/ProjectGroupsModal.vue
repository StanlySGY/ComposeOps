<template>
  <BaseModal :show="show" title="项目分组" size-class="max-w-2xl" body-class="p-4 space-y-4 max-h-[75vh] overflow-y-auto" :close-disabled="busy" @close="$emit('close')">
    <p class="text-xs text-muted">分组在所有节点共用，归组只整理项目，不改变纳管权限或运行容器。</p>
    <p v-if="error || store.error" class="alert-error" role="alert">{{ error || store.error }}<button class="text-link ml-2" @click="store.load">重新读取</button></p>
    <div class="space-y-2"><div v-for="group in store.groups" :key="group.id" class="group-edit-row">
      <input v-model="names[group.id]" class="input" maxlength="40" :aria-label="`分组 ${group.name} 的名称`" :disabled="busy" />
      <button class="btn-secondary btn-sm" :disabled="busy || !names[group.id]?.trim()" @click="save(group)">保存名称</button>
      <button class="btn-ghost btn-sm" :disabled="busy" :aria-pressed="group.pinned" @click="pin(group)">{{ group.pinned ? '取消置顶' : '置顶' }}</button>
      <button class="btn-ghost btn-sm" :disabled="busy" @click="deleting = group">删除</button>
    </div></div>
    <div v-if="deleting" class="alert-warning"><p>删除「{{ deleting.name }}」后，项目移回未分组，纳管权限保持不变。</p><button class="btn-secondary btn-sm mt-2" :disabled="busy" @click="remove">确认删除分组</button><button class="btn-ghost btn-sm" :disabled="busy" @click="deleting = null">取消</button></div>
    <section class="space-y-3"><h3 class="section-title">批量归组</h3>
      <ProjectGroupPicker v-model="target" :disabled="busy || !!store.error" label="批量目标分组" />
      <div class="group-project-list"><label v-for="project in projects" :key="project.id" class="group-project-choice"><input v-model="selected" type="checkbox" :value="project.id" :disabled="busy" /><span>{{ project.projectName }}<small>{{ project.groupName || '未分组' }} · {{ project.managed ? '已纳管' : '未纳管' }}</small></span></label></div>
      <button class="btn-primary" :disabled="busy || !selected.length || !!store.error" @click="assign">将 {{ selected.length }} 个项目移入{{ target ? '所选分组' : '未分组' }}</button>
    </section>
  </BaseModal>
</template>
<script setup>
import { ref, watch } from 'vue';
import BaseModal from '../common/BaseModal.vue';
import ProjectGroupPicker from './ProjectGroupPicker.vue';
import { useProjectGroupsStore } from '../../stores/project-groups.js';
import { api } from '../../api/client.js';
const props = defineProps({ show: Boolean, projects: { type: Array, default: () => [] }, selectedIds: { type: Array, default: () => [] }, hostId: { type: String, required: true } });
const emit = defineEmits(['close', 'changed']);
const store = useProjectGroupsStore(), names = ref({}), busy = ref(false), error = ref(''), target = ref(''), selected = ref([]), deleting = ref(null);
watch(() => props.show, async show => { if (show) { error.value = ''; deleting.value = null; selected.value = [...props.selectedIds]; await store.load(); names.value = Object.fromEntries(store.groups.map(g => [g.id, g.name])); } });
watch(() => props.hostId, () => { selected.value = []; emit('close'); });
watch(() => store.groups, groups => { names.value = Object.fromEntries(groups.map(g => [g.id, g.name])); });
async function action(fn) { if (busy.value) return; busy.value = true; error.value = ''; try { await fn(); emit('changed'); } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
function save(group) { return action(() => store.save({ id: group.id, name: names.value[group.id] })); }
function pin(group) { return action(() => store.save({ id: group.id, pinned: !group.pinned })); }
function remove() { return action(async () => { await store.remove(deleting.value.id); deleting.value = null; }); }
function assign() { const hostId = props.hostId; return action(async () => { await api.assignProjectGroups(hostId, selected.value.map(projectId => ({ projectId, groupId: target.value || null }))); store.changed(); emit('close'); }); }
</script>
<style scoped>
.group-edit-row{display:flex;gap:6px;flex-wrap:wrap}.group-edit-row input{flex:1;min-width:150px}.group-project-list{display:grid;gap:8px}.group-project-choice{display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--line-subtle)}.group-project-choice span{overflow-wrap:anywhere;min-width:0}.group-project-choice small{display:block;color:var(--text-soft);font-size:12px}
</style>
