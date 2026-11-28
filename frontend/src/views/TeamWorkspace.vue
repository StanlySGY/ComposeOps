<template>
  <main class="h-dvh overflow-auto p-4 sm:p-8">
    <div class="mx-auto max-w-6xl space-y-5">
      <header class="flex flex-wrap items-center justify-between gap-3"><div><h1 class="page-title">我的服务</h1><p class="page-subtitle">{{ auth.principal?.displayName }} · {{ auth.principal?.role === 'operator' ? '运维成员' : '只读成员' }} · 仅展示管理员授权的项目</p></div><div class="flex gap-2"><button class="btn-secondary" :disabled="loading" @click="load">刷新状态</button><button class="btn-secondary" @click="passwordOpen = !passwordOpen">修改密码</button><button class="btn-secondary" @click="auth.logout">退出登录</button></div></header>
      <form v-if="passwordOpen" class="panel grid gap-3 p-4 sm:grid-cols-3" @submit.prevent="changePassword"><input v-model="password.currentPassword" type="password" autocomplete="current-password" class="input" placeholder="当前密码" aria-label="当前密码" required /><input v-model="password.nextPassword" type="password" autocomplete="new-password" class="input" placeholder="新密码（至少 10 位）" aria-label="新密码" minlength="10" maxlength="200" required /><button class="btn-primary" :disabled="busy">保存新密码</button></form>
      <p v-if="error" class="alert-error" role="alert">{{ error }}</p><p v-if="message" class="alert-success" role="status">{{ message }}</p>
      <p v-if="loading && !projects.length" class="text-muted" role="status">正在读取授权项目…</p>
      <p v-else-if="!projects.length" class="panel p-8 text-center text-muted">暂无可访问的纳管项目。请联系管理员分配节点和项目权限。</p>
      <p v-for="node in unavailable" :key="node.hostId" class="alert-warning">{{ node.hostId }}：{{ node.message }}</p>
      <section v-for="project in projects" :key="project.id" class="panel overflow-hidden"><header class="border-b border-surface-700 p-4"><h2 class="font-semibold">{{ project.projectName }}</h2><p class="text-sm text-muted">{{ project.hostName }}<span v-if="project.groupName"> · {{ project.groupName }}</span></p></header>
        <div class="space-y-3 p-4 pl-6 sm:pl-9"><article v-for="container in project.containers" :key="container.id" class="flex flex-wrap items-center gap-3 rounded-lg border border-surface-700 p-3"><div class="min-w-0 flex-1"><h3 class="break-all font-medium">{{ container.service || container.name }}</h3><p class="break-all text-xs text-muted">{{ container.image }}</p><p class="mt-1 text-xs" :class="container.state === 'running' ? 'text-status-ok' : 'text-status-warn'">{{ container.status || container.state }}</p></div><div class="flex flex-wrap gap-2"><button class="btn-secondary" @click="showLogs(project, container)">日志</button><template v-if="auth.principal?.role === 'operator'"><button class="btn-secondary" :disabled="busy" @click="confirm = { project, container, action: container.state === 'running' ? 'restart' : 'start' }">{{ container.state === 'running' ? '重启' : '启动' }}</button><button v-if="container.state === 'running'" class="btn-danger" :disabled="busy" @click="confirm = { project, container, action: 'stop' }">停止</button></template></div></article></div>
      </section>
      <MemberAgentPanel :projects="projects" :can-write="auth.principal?.role === 'operator'" />
      <BaseModal :show="!!logTarget" :title="logTarget ? `${logTarget.container.service || logTarget.container.name} 日志` : '日志'" size-class="max-w-4xl" @close="closeLogs"><pre class="max-h-[65vh] overflow-auto whitespace-pre-wrap break-all p-4 text-xs">{{ logs || '读取中…' }}</pre></BaseModal>
      <ConfirmDialog :show="!!confirm" title="确认容器操作" :message="confirm ? `对 ${confirm.project.hostName} / ${confirm.project.projectName} 的 ${confirm.container.service || confirm.container.name} 执行${actionLabel[confirm.action]}？` : ''" :confirm-text="confirm ? actionLabel[confirm.action] : '确认'" :busy="busy" @confirm="perform" @cancel="confirm = null" />
    </div>
  </main>
</template>
<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { api } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';
import MemberAgentPanel from '../components/agent/MemberAgentPanel.vue';
import BaseModal from '../components/common/BaseModal.vue';
import ConfirmDialog from '../components/common/ConfirmDialog.vue';
const auth = useAuthStore(), projects = ref([]), unavailable = ref([]), loading = ref(false), busy = ref(false), error = ref(''), message = ref(''), confirm = ref(null), logs = ref(''), logTarget = ref(null), passwordOpen = ref(false), password = ref({ currentPassword: '', nextPassword: '' });
const actionLabel = { start: '启动', stop: '停止', restart: '重启' };
let controller, logsController, timer, disposed = false;
async function load() {
  controller?.abort(); controller = new AbortController(); loading.value = true;
  try { const result = await api.getTeamProjects(controller.signal); if (!disposed) { projects.value = result.projects; unavailable.value = result.unavailable; error.value = ''; } } catch (cause) { if (!disposed && cause.name !== 'AbortError') error.value = cause.message; } finally { if (!disposed) loading.value = false; }
}
function closeLogs() { logsController?.abort(); logTarget.value = null; }
async function showLogs(project, container) {
  logsController?.abort(); const current = new AbortController(); logsController = current;
  logTarget.value = { project, container }; logs.value = '';
  try { const result = await api.getTeamLogs(project.hostId, project.id, container.id, current.signal); if (logsController === current && !disposed) logs.value = result.logs || '暂无日志'; } catch (cause) { if (cause.name !== 'AbortError' && logsController === current) logs.value = cause.message; }
}
async function perform() {
  if (!confirm.value || busy.value) return;
  const { project, container, action } = confirm.value; busy.value = true;
  try { const result = await api.teamContainerAction(project.hostId, project.id, container.id, action); message.value = result.verification; confirm.value = null; await load(); } catch (cause) { error.value = cause.message; confirm.value = null; } finally { busy.value = false; }
}
async function changePassword() { busy.value = true; try { await api.changePassword(password.value); password.value = { currentPassword: '', nextPassword: '' }; passwordOpen.value = false; message.value = '密码已更新'; } catch (cause) { error.value = cause.message; } finally { busy.value = false; } }
onMounted(() => { void load(); timer = setInterval(() => { if (!document.hidden && !loading.value && !busy.value) void load(); }, 15000); });
onBeforeUnmount(() => { disposed = true; controller?.abort(); logsController?.abort(); clearInterval(timer); });
</script>
