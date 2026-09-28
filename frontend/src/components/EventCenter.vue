<template>
  <div class="relative">
    <button class="icon-btn relative" title="事件中心" aria-label="打开事件中心" @click="toggle">
      <Bell class="h-4 w-4" />
      <span v-if="unreadCount" class="event-count">{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
    </button>
    <div v-if="open" class="fixed inset-0 z-50" @click="open = false"></div>
    <section v-if="open" class="event-panel z-50">
      <header class="flex items-center justify-between border-b border-surface-800 px-4 py-3">
        <div><h2 class="text-sm font-semibold text-surface-100">事件中心</h2><p class="mt-0.5 text-muted">需要关注的运行状态与系统操作</p></div>
        <label class="toggle-label gap-1.5! text-[11px]" :title="guardian.aiConfigured ? '开启后,新告警会自动触发 AI 诊断(守护模式)' : '守护模式需要先在设置中配置 AI API Key'"><input type="checkbox" class="w-8! h-[18px]!" :checked="guardian.enabled" :disabled="!guardian.aiConfigured" @change="toggleGuardian" />AI 值守</label>
        <label class="toggle-label gap-1.5! text-[11px]" title="页面在后台时,新告警弹出系统通知"><input type="checkbox" class="w-8! h-[18px]!" :checked="desktopNotify" @change="toggleDesktopNotify" />通知</label><button class="icon-btn" title="刷新" aria-label="刷新事件" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /></button>
      </header>
      <div class="max-h-[min(68vh,32rem)] overflow-y-auto p-2">
        <div v-for="event in events" :key="event.key" class="event-item" :class="{ 'event-read': event.read }">
          <router-link :to="event.to" class="flex min-w-0 flex-1 items-center gap-2" @click="open = false">
            <span class="event-icon shrink-0" :class="event.tone"><component :is="event.icon" class="h-4 w-4" /></span>
            <span class="min-w-0 flex-1">
              <strong class="flex items-center gap-1.5">{{ event.title }}<span v-if="event.priority === 'danger'" class="event-priority">紧急</span></strong>
              <small>{{ event.detail }}</small>
            </span>
          </router-link>
          <div class="flex shrink-0 items-center gap-1">
            <button v-if="event.persisted" class="icon-btn h-6! w-6!" :title="event.diagnosis ? '查看 AI 诊断' : 'AI 诊断此告警(守护模式)'" :disabled="diagnosingId === event.id" @click="diagnose(event)"><Sparkles class="h-3 w-3" :class="{ 'animate-spin text-accent': diagnosingId === event.id, 'text-violet-400': event.diagnosis && diagnosingId !== event.id }" /></button>
            <button v-if="event.logs" class="icon-btn h-6! w-6!" :title="expandedLogEventId === event.id ? '折叠日志' : '展开日志'" @click="toggleLogs(event)"><ChevronRight class="h-3 w-3" :class="{ 'rotate-90': expandedLogEventId === event.id }" /></button>
            <button v-if="event.persisted && !event.read" class="icon-btn h-6! w-6!" title="标记已读" @click="markRead(event)"><Check class="h-3 w-3" /></button>
            <button v-if="event.persisted" class="icon-btn h-6! w-6!" title="静默此告警" @click="muteEvent(event)"><VolumeX class="h-3 w-3" /></button>
          </div>
          <div v-if="event.logs && expandedLogEventId === event.id" class="w-full basis-full"><pre class="event-logs">{{ event.logs }}</pre></div>
          <div v-if="expandedDiagnosisId === event.id" class="w-full basis-full rounded-lg border border-violet-500/30 bg-violet-950/20 p-2.5">
            <p class="mb-1 flex items-center gap-1 text-[11px] font-medium text-violet-300"><Sparkles class="h-3 w-3" />AI 诊断(守护模式)</p>
            <pre class="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-surface-200">{{ event.diagnosis || '正在诊断...' }}</pre>
          </div>
        </div>
        <EmptyState icon="CircleCheckBig" icon-class="text-emerald-400" compact title="当前没有待处理事件" description="异常与告警事件会出现在这里" />
      </div>
      <footer class="flex items-center justify-between border-t border-surface-800 px-4 py-2.5 text-muted">
        <span>{{ unreadCount }} 未读 · {{ eventCount }} 个需要关注</span>
        <div class="flex items-center gap-2">
          <button class="text-muted hover:text-surface-200 text-xs" @click="pruneAll">清空 7 天前</button>
          <router-link to="/events?tab=operations" class="text-accent hover:text-blue-300" @click="open = false">操作与任务</router-link>
        </div>
      </footer>
    </section>
    <ConfirmDialog :show="pruneDialog" title="清理历史告警" message="确认清空 7 天前的告警事件?此操作不可恢复。" tone="warning" confirm-text="清空历史" @confirm="confirmPrune" @cancel="pruneDialog = false" />
  </div>
</template>

<script setup>
import { computed, markRaw, onMounted, onUnmounted, ref } from 'vue';
import { useEscapeKey } from '../composables/useEscapeKey.js';
import { useWebSocket } from '../composables/useWebSocket.js';
import { useToastStore } from '../stores/toast.js';
import { AlertTriangle, Bell, Check, ChevronRight, CircleX, RefreshCw, RefreshCwOff, Sparkles, VolumeX } from 'lucide-vue-next';
import { api, wsUrl } from '../api/client.js';
import EmptyState from './common/EmptyState.vue';
import ConfirmDialog from './common/ConfirmDialog.vue';

const open = ref(false);
const loading = ref(false);
const toast = useToastStore();
const projects = ref([]);
const operations = ref([]);
const updates = ref({ lastResults: [] });
const jobs = ref([]);
const desktopNotify = ref(localStorage.getItem('composeops:desktop-notify') === '1');

async function toggleDesktopNotify() {
  if (desktopNotify.value) {
    desktopNotify.value = false;
    localStorage.setItem('composeops:desktop-notify', '0');
    return;
  }
  if (!('Notification' in window)) {
    useToastStore().error('当前浏览器不支持桌面通知');
    return;
  }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    useToastStore().error('浏览器通知权限被拒绝,请在浏览器设置中允许');
    return;
  }
  desktopNotify.value = true;
  localStorage.setItem('composeops:desktop-notify', '1');
}

function notifyDesktop(item) {
  if (!desktopNotify.value || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // 页面在前台时不需要系统通知
  try {
    const notify = new Notification(`ComposeOps · ${item.title || '告警'}`, {
      body: item.detail || '',
      tag: `composeops-${item.id || Date.now()}`,
    });
    notify.onclick = () => { window.focus(); notify.close(); };
  } catch {
    // 浏览器可能拒绝 Notification 构造,不影响事件中心本身。
  }
}
const alertEvents = ref([]);
const expandedLogEventId = ref(null);
const expandedDiagnosisId = ref(null);
const diagnosingId = ref('');
const guardian = ref({ enabled: false, aiConfigured: false });
const pruneDialog = ref(false);
let timer;

async function loadGuardian() {
  try { guardian.value = await api.getGuardian(); } catch { /* 状态获取失败按默认关闭 */ }
}
async function toggleGuardian() {
  try {
    guardian.value = await api.setGuardian(!guardian.value.enabled);
    toast.success(guardian.value.enabled ? '守护模式已开启:新告警将自动触发 AI 诊断' : '守护模式已关闭');
  } catch (e) {
    toast.error(e.message);
  }
}
async function diagnose(eventItem) {
  if (diagnosingId.value) return;
  // 已有诊断结果时只做展开/收起,不重复请求
  if (eventItem.diagnosis && expandedDiagnosisId.value !== eventItem.id) { expandedDiagnosisId.value = eventItem.id; return; }
  if (expandedDiagnosisId.value === eventItem.id) { expandedDiagnosisId.value = null; return; }
  diagnosingId.value = eventItem.id;
  expandedDiagnosisId.value = eventItem.id;
  try {
    const result = await api.diagnoseAlertEvent(eventItem.id);
    const idx = alertEvents.value.findIndex((item) => item.id === eventItem.id);
    if (idx >= 0) alertEvents.value[idx] = { ...alertEvents.value[idx], diagnosis: result.diagnosis };
  } catch (e) {
    toast.error(`AI 诊断失败:${e.message}`);
    expandedDiagnosisId.value = null;
  } finally {
    diagnosingId.value = '';
  }
}

/** 事件推送为后台常驻流,断开后持续重连(退避到 30s),不打扰前台交互。 */
const eventStream = useWebSocket(() => wsUrl('/ws/events'), {
  maxReconnectAttempts: 10,
  maxReconnectDelay: 30000,
  onMessage: (event) => {
    try {
      const frame = JSON.parse(event.data);
      if (frame.type === 'event' && frame.data) {
        alertEvents.value = [frame.data, ...alertEvents.value.filter((item) => item.id !== frame.data.id)].slice(0, 60);
        notifyDesktop(frame.data);
      }
    } catch {
      // 忽略格式异常的推送帧,下一帧仍可继续更新事件中心。
    }
  },
  // 重连成功后补拉一次,填补断线期间漏掉的事件
  onOpen: ({ resumed }) => { if (resumed) void load(); },
});

const derivedEvents = computed(() => {
  const result = [];
  const since = Date.now() - 24 * 60 * 60 * 1000;
  for (const job of jobs.value.filter((item) => ['queued', 'running'].includes(item.status) || (['failed', 'interrupted'].includes(item.status) && new Date(`${item.createdAt}Z`).getTime() >= since)).slice(0, 4)) {
    const abnormal = ['failed', 'interrupted'].includes(job.status);
    result.push({
      key: `job-${job.id}`,
      title: job.status === 'failed' ? '批量任务执行失败' : job.status === 'interrupted' ? '批量任务意外中断' : '批量任务执行中',
      detail: `${job.action} · ${job.completed}/${job.total} 个项目`,
      to: `/operations?tab=jobs&job=${job.id}`,
      icon: markRaw(abnormal ? CircleX : RefreshCw),
      tone: abnormal ? 'danger' : 'info',
    });
  }
  for (const project of projects.value) {
    const unhealthy = project.containers.filter((container) => container.health === 'unhealthy').length;
    const stopped = project.containers.filter((container) => container.state !== 'running').length;
    if (project.status !== 'running' || unhealthy) {
      result.push({
        key: `project-${project.id}`,
        title: project.projectName,
        detail: unhealthy ? `${unhealthy} 个容器健康检查失败` : stopped ? `${stopped} 个容器未运行` : '项目状态异常',
        to: `/services?focus=${project.id}`,
        icon: markRaw(AlertTriangle),
        tone: project.status === 'stopped' ? 'danger' : 'warning',
      });
    }
  }
  for (const item of operations.value.filter((operation) => operation.status !== 'success' && new Date(`${operation.createdAt}Z`).getTime() >= since).slice(0, 5)) {
    result.push({
      key: `operation-${item.id}`,
      title: item.projectName || '系统操作失败',
      detail: item.detail || item.action,
      to: '/operations?status=failed',
      icon: markRaw(CircleX),
      tone: 'danger',
    });
  }
  const pendingImages = (updates.value.lastResults || []).filter((item) => item.status === 'updated' && projects.value.some((project) =>
    project.containers.some((container) => container.image === item.image && container.imageId !== item.after)
  ));
  if (pendingImages.length) {
    result.push({
      key: 'image-updates',
      title: `${pendingImages.length} 个镜像待应用`,
      detail: '相关项目需要重新创建容器后生效',
      to: '/settings?tab=maintenance',
      icon: markRaw(RefreshCwOff),
      tone: 'info',
    });
  }
  return result;
});

const persistedEvents = computed(() => alertEvents.value
  .filter((event) => !event.muted)
  .map((event) => ({
    key: `alert-${event.id}`,
    id: event.id,
    title: event.title,
    detail: event.detail,
    to: event.target || '/events',
    icon: markRaw(event.priority === 'danger' ? CircleX : AlertTriangle),
    tone: event.priority === 'danger' ? 'danger' : 'warning',
    priority: event.priority,
    read: !!event.read,
    createdAt: event.created_at,
    logs: event.logs || '',
    diagnosis: event.diagnosis || '',
    persisted: true,
  })));

const events = computed(() => {
  // 持久化告警优先;派生事件只保留未重复的(按 key 去重,补足未入库但在 UI 可见的)
  const seen = new Set();
  const result = [];
  for (const event of persistedEvents.value) {
    if (!event.read || event.priority === 'danger') {
      seen.add(event.key);
      result.push(event);
    }
  }
  for (const event of derivedEvents.value) {
    if (!seen.has(event.key)) {
      seen.add(event.key);
      result.push(event);
    }
  }
  return result.slice(0, 20);
});
const eventCount = computed(() => events.value.length);
const unreadCount = computed(() => persistedEvents.value.filter((event) => !event.read).length);

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const [projectData, operationData, updateData, jobData, alertData] = await Promise.all([
      api.getProjects(), api.getOperations(), api.getUpdateSettings(), api.listJobs(20), api.getAlertEvents(50),
    ]);
    projects.value = projectData.projects || [];
    operations.value = operationData.operations || [];
    updates.value = updateData || { lastResults: [] };
    jobs.value = jobData.jobs || [];
    alertEvents.value = alertData.events || [];
  } catch {
    // 事件中心允许显示已有缓存,加载失败由下一次刷新或重连补偿。
  }
  finally { loading.value = false; }
  loadGuardian();
}
function connectEventStream() {
  eventStream.connect();
}
async function markRead(eventItem) {
  if (!eventItem.id) return;
  const updated = await api.updateAlertEvent(eventItem.id, { read: true }).catch(() => null);
  if (updated?.event) {
    const idx = alertEvents.value.findIndex((item) => item.id === eventItem.id);
    if (idx >= 0) alertEvents.value[idx] = updated.event;
  }
}
async function muteEvent(eventItem) {
  if (!eventItem.id) return;
  const updated = await api.updateAlertEvent(eventItem.id, { muted: true }).catch(() => null);
  if (updated?.event) {
    alertEvents.value = alertEvents.value.filter((item) => item.id !== eventItem.id);
  }
}
async function pruneAll() {
  pruneDialog.value = true;
}
async function confirmPrune() {
  pruneDialog.value = false;
  await api.pruneAlertEvents(7).catch(() => {});
  await load();
}
function toggleLogs(eventItem) {
  expandedLogEventId.value = expandedLogEventId.value === eventItem.id ? null : eventItem.id;
}
function toggle() { open.value = !open.value; if (open.value) { load(); connectEventStream(); } else eventStream.close(); }
useEscapeKey({ active: open, onClose: () => { open.value = false; }, layer: 'event' });

onMounted(() => { load(); timer = setInterval(load, 60000); });
onUnmounted(() => { clearInterval(timer); eventStream.close(); });
</script>
