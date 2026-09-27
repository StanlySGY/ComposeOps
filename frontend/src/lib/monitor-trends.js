import { ref } from 'vue';

/**
 * 监控趋势共享存储:Monitor 实时页累积,其他视图(如 Dashboard)可直接读取。
 * 数据持久化在 localStorage(环形 96 点),模块级单例 ref 保证跨页面共享。
 */
const TRENDS_KEY = 'composeops:monitor-trends';
const MAX_POINTS = 96;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(TRENDS_KEY) || '{}');
    return {
      cpu: Array.isArray(saved.cpu) ? saved.cpu : [],
      mem: Array.isArray(saved.mem) ? saved.mem : [],
      net: Array.isArray(saved.net) ? saved.net : [],
    };
  } catch {
    return { cpu: [], mem: [], net: [] };
  }
}

export const monitorTrends = ref(load());

export function pushMonitorTrend({ cpu, mem, net }) {
  const t = monitorTrends.value;
  if (Number.isFinite(cpu)) t.cpu = [...t.cpu, cpu].slice(-MAX_POINTS);
  if (Number.isFinite(mem)) t.mem = [...t.mem, mem].slice(-MAX_POINTS);
  if (Number.isFinite(net)) t.net = [...t.net, net].slice(-MAX_POINTS);
  persist();
}

export function resetMonitorTrends() {
  monitorTrends.value = { cpu: [], mem: [], net: [] };
  try { localStorage.removeItem(TRENDS_KEY); } catch {
    // 趋势内存状态已经清空,持久化清理失败不影响当前页面。
  }
}

function persist() {
  try {
    const t = monitorTrends.value;
    localStorage.setItem(TRENDS_KEY, JSON.stringify({ cpu: t.cpu, mem: t.mem, net: t.net, ts: Date.now() }));
  } catch {
    // 本地存储不可用时继续以内存趋势运行。
  }
}
