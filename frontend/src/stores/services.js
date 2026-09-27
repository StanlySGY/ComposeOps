import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api/client.js';

export const useServicesStore = defineStore('services', () => {
  const projects = ref([]);
  const loading = ref(false);
  const error = ref('');
  const lastLoadedAt = ref(0);
  const wsConnected = ref(false);
  let timer;
  let wsHook = null;
  let refreshPromise = null;
  let containerEventDebounce = null;

  /**
   * SWR 语义刷新:
   * - 已有数据时静默拉新(不置 loading,避免切页回来白屏/高度跳动);
   * - 首次加载(无数据)才显示 loading。
   */
  async function refresh(force = false) {
    if (refreshPromise && !force) return refreshPromise;
    const hasData = projects.value.length > 0;
    if (!hasData) loading.value = true;
    error.value = '';
    const requestPromise = (async () => {
      try {
        const data = await api.getProjects(force);
        if (Array.isArray(data?.projects)) projects.value = data.projects;
        lastLoadedAt.value = Date.now();
      } catch (e) {
        error.value = e.message;
      } finally { loading.value = false; }
    })();
    refreshPromise = requestPromise;
    try { await requestPromise; } finally { if (refreshPromise === requestPromise) refreshPromise = null; }
  }

  /**
   * 处理 WebSocket 容器事件,更新对应项目的容器状态
   */
  function handleContainerEvent(event) {
    if (event.type === 'snapshot') {
      const snapshot = event.projects || event.data?.projects;
      if (Array.isArray(snapshot) && (snapshot.length > 0 || projects.value.length === 0)) {
        projects.value = snapshot;
        lastLoadedAt.value = Date.now();
      }
      return;
    }
    
    if (event.type === 'container_event') {
      const { projectId } = event;
      const project = projects.value.find((p) => p.id === projectId);
      if (!project) return;

      // 容器事件常成簇到达(启停/健康翻转),逐事件全量刷新会形成请求风暴;
      // 800ms 去抖合并为一次强制扫描,期间沿用现有数据,避免渲染卡顿。
      clearTimeout(containerEventDebounce);
      containerEventDebounce = setTimeout(() => { containerEventDebounce = null; void refresh(true); }, 800);
    }
  }

  /**
   * 启动 WebSocket 实时订阅(优先);失败时降级到轮询
   */
  function startWebSocket(hook) {
    if (wsHook || !hook || typeof hook.connect !== 'function') return; // 已连接
    wsHook = hook;
    if (typeof hook.setErrorHandler === 'function') hook.setErrorHandler(() => {
      wsConnected.value = false;
      // WebSocket 失败时降级到轮询
      if (!timer) startAutoRefresh(5000);
    });
    wsHook.connect();
  }

  function stopWebSocket() {
    if (wsHook) {
      try { wsHook.close(); } catch {
        // Socket 已关闭时 close 失败不应阻断轮询降级。
      }
      wsHook = null;
    }
    if (containerEventDebounce) { clearTimeout(containerEventDebounce); containerEventDebounce = null; }
    wsConnected.value = false;
  }

  function startAutoRefresh(intervalMs = 5000) {
    if (timer) return;
    void refresh(false);
    timer = setInterval(() => void refresh(false), intervalMs);
  }
  
  function stopAutoRefresh() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { 
    projects, 
    loading, 
    error, 
    lastLoadedAt, 
    wsConnected,
    handleContainerEvent,
    refresh, 
    startAutoRefresh, 
    stopAutoRefresh,
    startWebSocket,
    stopWebSocket,
  };
});
