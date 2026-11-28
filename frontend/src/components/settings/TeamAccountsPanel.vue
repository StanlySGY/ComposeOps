<template>
  <section class="settings-section space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="section-title">成员与项目权限</h2><p class="mt-1 text-sm text-muted">分组用于整理服务；访问权限按节点和项目单独授予。变更权限或密码后，成员需要重新登录。</p></div><button class="btn-primary" @click="edit()">添加成员</button></div>
    <p v-if="error" role="alert" class="alert-error">{{ error }}</p><p v-if="message" role="status" class="alert-success">{{ message }}</p>
    <p v-if="loading" role="status" class="text-muted">正在读取成员…</p>
    <p v-else-if="!accounts.length" class="empty-state">还没有成员。现有管理员仍使用 admin 账号登录。</p>
    <div v-for="account in accounts" :key="account.id" class="panel flex flex-wrap items-center justify-between gap-3 p-4"><div><strong>{{ account.displayName }}</strong><p class="text-sm text-muted">{{ account.username }} · {{ labels[account.role] }} · {{ account.enabled ? '已启用' : '已停用' }} · {{ account.grants.length }} 个项目</p></div><button class="btn-secondary" @click="edit(account)">编辑权限</button></div>
    <BaseModal :show="!!draft" :title="draft?.id ? '编辑成员权限' : '添加成员'" size-class="max-w-2xl" @close="!busy && (draft = null)">
      <form v-if="draft" class="space-y-4 p-4" @submit.prevent="save">
        <label class="block text-sm">账号<input v-model="draft.username" class="input mt-1 w-full" autocomplete="off" required pattern="[a-z][a-z0-9._-]{2,39}" maxlength="40" /></label>
        <label class="block text-sm">显示名称<input v-model="draft.displayName" class="input mt-1 w-full" maxlength="80" /></label>
        <label class="block text-sm">{{ draft.id ? '重置密码（留空保留）' : '初始密码' }}<input v-model="draft.password" class="input mt-1 w-full" type="password" autocomplete="new-password" :required="!draft.id" minlength="10" maxlength="200" /></label>
        <label class="block text-sm">角色<select v-model="draft.role" class="input mt-1 w-full"><option value="viewer">只读成员：状态与日志</option><option value="operator">运维成员：状态、日志与容器启停</option><option value="admin">管理员：全部项目与系统配置</option></select></label>
        <label class="flex items-center gap-2"><input v-model="draft.enabled" type="checkbox" />启用账号</label>
        <fieldset v-if="draft.role !== 'admin'" class="rounded-xl border border-surface-700 p-3"><legend class="px-1 text-sm">授权项目</legend>
          <p v-if="catalogError" class="text-status-warn text-sm">{{ catalogError }}</p>
          <p class="mb-2 text-xs text-muted">新项目默认不授权；离线节点已有授权会保留，可手动移除。</p>
          <div class="max-h-56 space-y-2 overflow-auto"><label v-for="project in options" :key="key(project)" class="flex gap-2 text-sm"><input v-model="selected" type="checkbox" :value="key(project)" /><span class="break-all">{{ project.label }}</span></label></div>
        </fieldset>
        <p v-if="formError" role="alert" class="alert-error">{{ formError }}</p>
        <div class="flex justify-end gap-2"><button type="button" class="btn-secondary" :disabled="busy" @click="draft = null">取消</button><button class="btn-primary" :disabled="busy">{{ busy ? '保存中…' : '保存成员与权限' }}</button></div>
      </form>
    </BaseModal>
  </section>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue';
import BaseModal from '../common/BaseModal.vue';
import { api } from '../../api/client.js';
const labels = { admin: '管理员', operator: '运维成员', viewer: '只读成员' };
const accounts = ref([]), catalog = ref([]), loading = ref(false), busy = ref(false), error = ref(''), message = ref(''), catalogError = ref(''), formError = ref(''), draft = ref(null), selected = ref([]);
const key = project => JSON.stringify([project.hostId, project.projectId || project.id]);
const options = computed(() => {
  const rows = catalog.value.map(project => ({ hostId: project.hostId, projectId: project.id, label: `${project.hostName || project.hostId} / ${project.projectName}` }));
  for (const grant of draft.value?.grants || []) if (!rows.some(row => key(row) === key(grant))) rows.push({ ...grant, label: `${grant.hostId} / ${grant.projectId}（暂不可达或已移除）` });
  return rows;
});
async function load() { loading.value = true; try { accounts.value = (await api.getTeamAccounts()).accounts; error.value = ''; } catch (cause) { error.value = cause.message; } finally { loading.value = false; } }
async function edit(account) {
  formError.value = ''; selected.value = (account?.grants || []).map(key);
  draft.value = account ? { ...account, password: '', grants: [...account.grants] } : { username: '', displayName: '', password: '', role: 'viewer', enabled: true, grants: [] };
  try { const result = await api.getTeamCatalog(); catalog.value = (result.projects || []).filter(p => p.managed); catalogError.value = result.complete ? '' : '部分节点不可达；已有授权仍然保留。'; } catch (cause) { catalogError.value = cause.message; }
}
async function save() {
  busy.value = true; formError.value = '';
  try {
    const grants = selected.value.map(value => { const [hostId, projectId] = JSON.parse(value); return { hostId, projectId }; });
    const { id, revision, username, displayName, password, role, enabled } = draft.value;
    await api.saveTeamAccount({ ...(id ? { id, revision } : {}), username, displayName, ...(password ? { password } : {}), role, enabled, grants });
    draft.value = null; message.value = '成员权限已保存；该成员的旧登录会话已失效。'; await load();
  } catch (cause) { formError.value = cause.message; } finally { busy.value = false; }
}
onMounted(load);
</script>
