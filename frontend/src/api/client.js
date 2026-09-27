// 统一 API 客户端,基于 fetch 封装
import { normalizeBackgroundJob, normalizeCostReport, normalizeDockerUsage, normalizeJobsResponse, normalizeMetrics, normalizeMountPlan, normalizeStorageDf } from '../lib/api-normalizers.js';

const BASE = '/api/v1';

/**
 * SWR(Stale-While-Revalidate)内存缓存:
 * - GET 命中有效缓存时立即返回旧数据(0ms 秒开),后台静默拉取最新数据;
 * - 默认 TTL 12s;write 请求(POST/PUT/DELETE/PATCH)成功后自动失效相关缓存。
 */
const swrCache = new Map(); // key -> { data, ts, inflight }
const SWR_TTL = 12000;
const CACHEABLE_PATHS = ['/projects', '/hosts', '/personal/preferences', '/system/capabilities', '/ops/blueprints', '/cron'];
let hostEpoch = 0;

function isGet(opts) {
  return !opts?.method || opts.method === 'GET';
}
function cacheable(path, opts) {
  return isGet(opts) && (CACHEABLE_PATHS.includes(path) || opts.cacheable);
}
function doFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const hasBody = opts.body !== undefined && opts.body !== null && opts.body !== '';
  if (hasBody && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${BASE}${path}`, {
    headers,
    ...opts,
  }).then(async (res) => {
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const body = await res.json();
        msg = body.message || body.error || JSON.stringify(body);
      } catch {
        // 错误响应可能不是 JSON,保留 HTTP 状态文本作为兜底。
      }
      const err = new Error(msg);
      err.status = res.status;
      if (res.status === 401) window.dispatchEvent(new CustomEvent('composeops:unauthorized'));
      throw err;
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const text = await res.text();
      try { return text ? JSON.parse(text) : null; }
      catch { return text; }
    }
    return res.text();
  });
}
function revalidate(key, path, opts) {
  const entry = swrCache.get(key);
  if (!entry || entry.inflight) return;
  entry.inflight = true;
  doFetch(path, opts)
    .then((data) => swrCache.set(key, { data, ts: Date.now(), inflight: false }))
    .catch(() => swrCache.set(key, { ...entry, inflight: false }));
}
/** SSE/流式响应的非 2xx 错误统一解析为 Error。 */
async function streamError(res, fallback) {
  const payload = await res.json().catch(() => ({}));
  return new Error(payload.message || payload.error || fallback);
}
async function request(path, opts = {}) {
  if (!isGet(opts)) {
    const data = await doFetch(path, opts);
    invalidateSwr('/projects');
    invalidateSwr('/hosts');
    invalidateSwr('/personal/');
    invalidateSwr('/ops/');
    invalidateSwr('/cron');
    invalidateSwr('/jobs');
    return data;
  }
  const key = `${hostEpoch}:${path}${opts.cacheKey || ''}`;
  const entry = swrCache.get(key);
  // 命中新鲜缓存:立即返回,后台 revalidate
  if (entry && !opts.force && Date.now() - entry.ts < SWR_TTL) {
    revalidate(key, path, opts);
    return entry.data;
  }
  // 命中过期缓存:先回旧值(秒开),后台刷新
  if (entry && !opts.force) {
    revalidate(key, path, opts);
    return entry.data;
  }
  // 无缓存:真实拉取,可缓存项落缓存
  const data = await doFetch(path, opts);
  if (cacheable(path, opts) && !opts.force) swrCache.set(key, { data, ts: Date.now(), inflight: false });
  return data;
}
/** 使某个路径前缀的 SWR 缓存失效(写操作后调用)。 */
export function invalidateSwr(prefix) {
  for (const key of [...swrCache.keys()]) {
    const separator = key.indexOf(':');
    const cachePath = separator >= 0 ? key.slice(separator + 1) : key;
    if (cachePath.startsWith(prefix)) swrCache.delete(key);
  }
}

/** 切换 Docker 节点后丢弃所有节点相关的 SWR 数据,避免跨宿主复用项目/资源列表。 */
export function bumpHostEpoch() {
  hostEpoch += 1;
  swrCache.clear();
}

export const api = {
  getAuthStatus: () => request('/auth/status'),
  // setupToken:服务端设置 SETUP_TOKEN 环境变量时,首次初始化必须携带该引导令牌
  setup: (password, setupToken = '') => request('/auth/setup', { method: 'POST', body: JSON.stringify({ password, setupToken }) }),
  login: (password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (payload) => request('/auth/password', { method: 'POST', body: JSON.stringify(payload) }),
  getProjects: (force = false) => request('/projects', { force }),
  getMountPlan: async () => normalizeMountPlan(await request('/projects/mount-plan')),
  saveProjectManagement: (projectIds, mountProjectIds = []) => request('/projects/management', { method: 'PUT', body: JSON.stringify({ projectIds, mountProjectIds }) }),
  saveProjectMounts: (projectIds) => request('/projects/mounts', { method: 'PUT', body: JSON.stringify({ projectIds }) }),
  getProject: (id) => request(`/projects/${id}`),
  getProjectActivity: (id) => request(`/projects/${id}/activity`),
  listJobs: async (limit = 20) => normalizeJobsResponse(await request(`/jobs?limit=${limit}`, { cacheable: true })),
  getJob: async (id) => normalizeBackgroundJob(await request(`/jobs/${id}`)),
  streamJobUpdates: (jobId, onFrame, signal) => {
    return fetch(`${BASE}/jobs/${jobId}/stream`, { signal }).then(async (res) => {
      if (!res.ok || !res.body) throw await streamError(res, '任务流请求失败');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          try {
            const frame = JSON.parse(line.slice(5).trim());
            if (frame?.job) frame.job = normalizeBackgroundJob(frame.job);
            onFrame(frame);
          } catch {
            // 单个坏帧不应阻断后续任务事件。
          }
        }
      }
    });
  },
  createProjectBatchJob: async (projectIds, action) => normalizeBackgroundJob(await request('/jobs', { method: 'POST', body: JSON.stringify({ projectIds, action }) })),
  saveProjectPreference: (id, payload) => request(`/projects/${id}/preferences`, { method: 'PATCH', body: JSON.stringify(payload) }),
  getComposeFile: (projectId, fileIndex = 0, force = false) => request(`/projects/${projectId}/compose?fileIndex=${fileIndex}`, { force }),
  saveComposeFile: (projectId, fileIndex, content) =>
    request(`/projects/${projectId}/compose`, { method: 'PUT', body: JSON.stringify({ fileIndex, content }) }),
  getProjectEnv: (projectId, file = '', force = false) => request(`/projects/${projectId}/env?${new URLSearchParams({ ...(file ? { file } : {}), ...(force ? { force: '1' } : {}) })}`),
  getProjectEnvFiles: (projectId) => request(`/projects/${projectId}/env/files`),
  saveProjectEnv: (projectId, payload) => request(`/projects/${projectId}/env`, { method: 'PUT', body: JSON.stringify(payload) }),
  streamApplyEnv: (projectId, onFrame, signal) => streamComposeControl(projectId, null, onFrame, `/projects/${projectId}/env/apply`, { restart: true }, signal),
  getBackups: (projectId) => request(`/projects/${projectId}/backups`),
  getBackup: (projectId, backupId) => request(`/projects/${projectId}/backups/${backupId}`),
  restoreBackup: (projectId, backupId) => request(`/projects/${projectId}/backups/${backupId}/restore`, { method: 'POST' }),
  // docker hosts
  getHosts: (force = false) => request('/hosts', { force }),
  saveHost: (payload) => request('/hosts', { method: 'POST', body: JSON.stringify(payload) }),
  deleteHost: (id) => request(`/hosts/${id}`, { method: 'DELETE' }),
  pingHost: (id, probe) => request(`/hosts/${id}/ping`, { method: 'POST', body: JSON.stringify(probe ? { probe } : {}) }),
  setActiveHost: (hostId) => request('/hosts/active', { method: 'PUT', body: JSON.stringify({ hostId }) }),
  getActiveHost: () => request('/hosts/active'),
  // image update radar
  getProjectUpdates: (projectId, force = false) => request(`/projects/${projectId}/updates?force=${force ? '1' : '0'}`),
  getProjectWebUi: (projectId) => request(`/projects/${projectId}/webui`),
  listDbDumpTargets: (projectId) => request(`/projects/${projectId}/db-dump`),
  listCronJobs: () => request('/cron'),
  createCronJob: (payload) => request('/cron', { method: 'POST', body: JSON.stringify(payload) }),
  updateCronJob: (id, payload) => request(`/cron/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteCronJob: (id) => request(`/cron/${id}`, { method: 'DELETE' }),
  runCronJob: (id) => request(`/cron/${id}/run`, { method: 'POST' }),
  getCronHistory: (limit = 50) => request(`/cron/history?limit=${limit}`),
  // gitops
  getGitOpsRepos: () => request('/gitops'),
  getGitOpsDrift: () => request('/gitops/drift'),
  addGitOpsRepo: (payload) => request('/gitops', { method: 'POST', body: JSON.stringify(payload) }),
  updateGitOpsRepo: (id, payload) => request(`/gitops/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteGitOpsRepo: (id) => request(`/gitops/${id}`, { method: 'DELETE' }),
  syncGitOpsRepo: (id) => request(`/gitops/${id}/sync`, { method: 'POST' }),
  getGitOpsHistory: (id, limit = 50) => request(`/gitops/${id}/history?limit=${limit}`),
  rollbackGitOpsRepo: (id, commitHash) => request(`/gitops/${id}/rollback`, { method: 'POST', body: JSON.stringify({ commitHash }) }),
  // db dump
  streamDbDump: (projectId, containerId, dbName = '') =>
    fetch(`${BASE}/projects/${projectId}/db-dump`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containerId, dbName }),
    }),
  streamUpgrade: (projectId, onFrame, signal) => streamComposeControl(projectId, null, onFrame, `/projects/${projectId}/upgrade`, {}, signal),
  streamRollback: (projectId, onFrame, signal) => streamComposeControl(projectId, null, onFrame, `/projects/${projectId}/rollback`, {}, signal),
  checkAllUpdates: () => request('/ops/updates/check-all', { method: 'POST' }),
  // docker storage
  getStorageDf: async () => normalizeStorageDf(await request('/ops/storage/df')),
  pruneStorage: (mode, confirm) => request('/ops/storage/prune', { method: 'POST', body: JSON.stringify({ mode, confirm }) }),
  getStorageResources: (force = false) => request('/ops/storage/resources', { force }),
  getProjectVolumes: (projectId) => request(`/ops/storage/volume-volumes?projectId=${encodeURIComponent(projectId)}`),
  getVolumeBackups: (projectId = '') => request(`/ops/storage/volume-backups${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  createVolumeBackup: (projectId, volume) => request('/ops/storage/volume-backups', { method: 'POST', body: JSON.stringify({ projectId, volume }) }),
  restoreVolumeBackup: (id) => request(`/ops/storage/volume-backups/${id}/restore`, { method: 'POST' }),
  deleteVolumeBackup: (id) => request(`/ops/storage/volume-backups/${id}`, { method: 'DELETE' }),
  volumeBackupDownloadUrl: (id) => `/api/v1/ops/storage/volume-backups/${id}/download`,
  removeStorageResource: (kind, id) => request(`/ops/storage/resources/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // app blueprints
  getBlueprints: () => request('/ops/blueprints'),
  streamBlueprintDeploy: (blueprintId, values, onFrame) => streamComposeControl(null, null, onFrame, '/ops/blueprints/deploy', { blueprintId, values }),
  // alert events
  getNotificationEvents: () => request('/ops/notifications/events'),
  saveNotificationEvents: (events) => request('/ops/notifications/events', { method: 'PUT', body: JSON.stringify({ events }) }),
  getAlertEvents: (limit = 50) => request(`/ops/alert-events?limit=${limit}`),
  updateAlertEvent: (id, patch) => request(`/ops/alert-events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  pruneAlertEvents: (days = 7) => request('/ops/alert-events/prune', { method: 'POST', body: JSON.stringify({ days }) }),
  // AI 巡检
  getInspectionOverview: (limit = 20) => request(`/ops/inspection/overview?limit=${limit}`),
  getInspectionReport: (id) => request(`/ops/inspection/reports/${id}`),
  runInspection: () => request('/ops/inspection/run', { method: 'POST', body: JSON.stringify({}) }),
  saveInspectionSchedule: (payload) => request('/ops/inspection/schedule', { method: 'PUT', body: JSON.stringify(payload) }),
  pruneInspections: (days = 180) => request('/ops/inspection/prune', { method: 'POST', body: JSON.stringify({ days }) }),
  // ai
  getAiConfig: () => request('/ai/config'),
  saveAiConfig: (payload) => request('/ai/config', { method: 'POST', body: JSON.stringify(payload) }),
  fetchAiModels: (payload = {}) => request('/ai/fetch-models', { method: 'POST', body: JSON.stringify(payload) }),
  getProjectLogs: (projectId, containerId, tail = 200) => request('/ai/logs', { method: 'POST', body: JSON.stringify({ projectId, containerId, tail }) }),
  getAiHistory: (sessionId, limit = 200, beforeId = null) => request(`/ai/history?${new URLSearchParams({ ...(sessionId ? { sessionId } : {}), ...(beforeId ? { beforeId } : {}), limit })}`),
  getAiSessions: (limit = 30, kind = '') => request(`/ai/sessions?limit=${limit}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`),
  createAgentSession: () => request('/ai/agent/sessions', { method: 'POST' }),
  renameAgentSession: (sessionId, title) => request(`/ai/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  getAiMemories: (limit = 20, query = '') => request(`/ai/agent/memories?limit=${limit}${query ? `&query=${encodeURIComponent(query)}` : ''}`),
  compactAgentSession: (sessionId, keepRecent = 6) => request('/ai/agent/compact', { method: 'POST', body: JSON.stringify({ sessionId, keepRecent }) }),
  getAgentCompaction: (sessionId) => request(`/ai/agent/sessions/${encodeURIComponent(sessionId)}/compaction`),
  clearAiHistory: (sessionId) => request(`/ai/history${sessionId ? `?sessionId=${sessionId}` : ''}`, { method: 'DELETE' }),
  clearAiSessions: (sessionIds) => request('/ai/history/batch-delete', { method: 'POST', body: JSON.stringify({ sessionIds }) }),
  truncateAiHistory: (sessionId, fromMessageId) => request('/ai/history/truncate', { method: 'POST', body: JSON.stringify({ sessionId, fromMessageId }) }),
  // ai agent:执行已收敛为 Tool Loop 流式通道;会话/记忆/审计见上方与下方的端点
  agentExecuteStream: (payload, onEvent, signal) => streamSse('/ai/agent/execute-stream', payload, onEvent, signal),
  agentApprove: (payload) => request('/ai/agent/approve', { method: 'POST', body: JSON.stringify(payload) }),
  agentFeedback: (payload) => request('/ai/agent/feedback', { method: 'POST', body: JSON.stringify(payload) }),
  getAgentExecutions: (planId = '') => request(`/ai/agent/executions${planId ? `?planId=${encodeURIComponent(planId)}` : ''}`),
  // compose 语义校验 / 变更预览
  validateCompose: (projectId, fileIndex, content) => request(`/projects/${projectId}/compose/validate`, { method: 'POST', body: JSON.stringify({ fileIndex, content }) }),
  previewCompose: async (projectId, content) => {
    const result = await request(`/projects/${projectId}/compose/preview`, { method: 'POST', body: JSON.stringify({ content }) });
    return result?.preview || null;
  },
  // system
  getMetrics: async () => normalizeMetrics(await request('/system/metrics')),
  getCapabilities: () => request('/system/capabilities'),
  getPreferences: () => request('/personal/preferences'),
  savePreferences: (payload) => request('/personal/preferences', { method: 'PUT', body: JSON.stringify(payload) }),
  getNotifications: () => request('/personal/notifications'),
  saveNotifications: (payload) => request('/personal/notifications', { method: 'PUT', body: JSON.stringify(payload) }),
  testNotifications: (payload) => request('/personal/notifications/test', { method: 'POST', body: JSON.stringify(payload) }),
  getOperations: () => request('/personal/operations', { cacheable: true }),
  getDockerUsage: async () => normalizeDockerUsage(await request('/personal/maintenance/usage')),
  getCostAnalysisReport: async () => normalizeCostReport(await request('/cost-analysis/report')),
  getCostSuggestions: () => request('/cost-analysis/suggestions'),
  pruneDocker: (payload) => request('/personal/maintenance/prune', { method: 'POST', body: JSON.stringify(payload) }),
  getUpdateSettings: () => request('/personal/updates'),
  saveUpdateSettings: (payload) => request('/personal/updates', { method: 'PUT', body: JSON.stringify(payload) }),
  checkUpdates: () => request('/personal/updates/check', { method: 'POST' }),
  exportUrl: `${BASE}/personal/export`,
  importData: (payload) => request('/personal/import', { method: 'POST', body: JSON.stringify(payload) }),
  // marketplace
  getMarketplaceStats: () => request('/marketplace/stats'),
  discoverAiTemplate: (query) => request('/marketplace/templates/ai-discover', { method: 'POST', body: JSON.stringify({ query }) }),
  searchMarketplaceTemplates: (params) => request(`/marketplace/templates/search?${params.toString()}`),
  toggleMarketplaceFavorite: (templateId, isFavorited) => request(`/marketplace/favorites/${templateId}`, { method: isFavorited ? 'DELETE' : 'POST' }),
  createMarketplaceTemplate: (payload) => request('/marketplace/templates/custom', { method: 'POST', body: JSON.stringify(payload) }),
  updateMarketplaceTemplate: (id, payload) => request(`/marketplace/templates/custom/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteMarketplaceTemplate: (id) => request(`/marketplace/templates/custom/${id}`, { method: 'DELETE' }),
  // CMDB 统一资产中心
  getCmdbAssets: (params = {}) => request(`/cmdb/assets?${new URLSearchParams(params)}`, { cacheable: true }),
  getCmdbAsset: (id) => request(`/cmdb/assets/${encodeURIComponent(id)}`),
  deleteCmdbAsset: (id) => request(`/cmdb/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  syncCmdbAssets: () => request('/cmdb/assets/sync', { method: 'POST' }),
  getCmdbTopology: () => request('/cmdb/topology', { cacheable: true }),
  addCmdbRelation: (payload) => request('/cmdb/relations', { method: 'POST', body: JSON.stringify(payload) }),
  deleteCmdbRelation: (id) => request(`/cmdb/relations/${id}`, { method: 'DELETE' }),
  // 统一事件中心
  getEvents: (params = {}) => request(`/events/events?${new URLSearchParams(params)}`, { cacheable: true }),
  getEventStats: () => request('/events/events/stats', { cacheable: true }),
  updateEvent: (id, patch) => request(`/events/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  pruneEvents: (days = 30) => request('/events/events/prune', { method: 'POST', body: JSON.stringify({ days }) }),
  // 工作流中心
  getWorkflowDefinitions: () => request('/workflows/definitions', { cacheable: true }),
  getWorkflowDefinition: (id) => request(`/workflows/definitions/${id}`),
  createWorkflowDefinition: (payload) => request('/workflows/definitions', { method: 'POST', body: JSON.stringify(payload) }),
  updateWorkflowDefinition: (id, payload) => request(`/workflows/definitions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteWorkflowDefinition: (id) => request(`/workflows/definitions/${id}`, { method: 'DELETE' }),
  runWorkflow: (id, context = {}) => request(`/workflows/definitions/${id}/run`, { method: 'POST', body: JSON.stringify({ context }) }),
  getWorkflowInstances: (params = {}) => request(`/workflows/instances?${new URLSearchParams(params)}`, { cacheable: true }),
  getWorkflowInstance: (id) => request(`/workflows/instances/${id}`),
  approveWorkflowInstance: (id, payload) => request(`/workflows/instances/${id}/approve`, { method: 'POST', body: JSON.stringify(payload) }),
  cancelWorkflowInstance: (id) => request(`/workflows/instances/${id}/cancel`, { method: 'POST' }),
};

/**
 * 调用 compose 控制端点(SSE 流式)。逐行解析 data: {...} 帧。
 * @param {object} body
 * @param {(frame:{type,data:string})=>void} onFrame
 * @returns {Promise<void>} resolve on stream end
 */
export async function streamComposeControl(projectId, action, onFrame, path = null, body = null, signal = undefined) {
  const endpoint = path || `/projects/${projectId}/actions`;
  const res = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : JSON.stringify({ action }),
    signal,
  });
  if (!res.ok || !res.body) throw await streamError(res, '控制请求失败');
  invalidateSwr('/projects');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        onFrame(JSON.parse(line.slice(5).trim()));
      } catch {
        // 跳过无法解析的控制流帧,让连接继续接收后续事件。
      }
    }
  }
}

/**
 * AI 对话 / 诊断 SSE 流式
 */
export async function streamSse(path, body, onFrame, signal) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw await streamError(res, 'AI 请求失败');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        onFrame(JSON.parse(line.slice(5).trim()));
      } catch {
        // 跳过无法解析的 AI 流帧,让连接继续接收后续事件。
      }
    }
  }
}

/** 项目容器实时资源指标 SSE 流(GET)。 */
export function streamProjectStats(projectId, onFrame, signal, interval = 2500) {
  return fetch(`${BASE}/projects/${projectId}/stats/stream?interval=${interval}`, { signal }).then(async (res) => {
    if (!res.ok || !res.body) throw await streamError(res, '指标流请求失败');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        try {
          onFrame(JSON.parse(line.slice(5).trim()));
        } catch {
          // 跳过无法解析的指标流帧,避免单帧污染终止整条流。
        }
      }
    }
  });
}

/** 构造 WebSocket 绝对地址 */
export function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

// Metrics API
export const metricsApi = {
  getContainerMetrics: (containerId, metric = 'cpu', period = '5m') => 
    request(`/metrics/container/${containerId}?metric=${metric}&period=${period}`),
  getAlerts: (containerFilter = null) => 
    request(`/metrics/alerts${containerFilter ? `?container=${containerFilter}` : ''}`),
  createAlert: (config) => 
    request('/metrics/alerts', { method: 'POST', body: JSON.stringify(config) }),
  deleteAlert: (ruleId) => 
    request(`/metrics/alerts/${ruleId}`, { method: 'DELETE' }),
  
  // Phase 1: 新增的指标 API
  getHistoricalMetrics: ({ containerId, metricType, startTime, endTime, aggregation = 'auto' }) => {
    const params = new URLSearchParams();
    if (containerId) params.append('containerId', containerId);
    if (metricType) params.append('metricType', metricType);
    if (startTime) params.append('startTime', startTime);
    if (endTime) params.append('endTime', endTime);
    if (aggregation) params.append('aggregation', aggregation);
    return request(`/metrics/historical?${params.toString()}`);
  },
  
  getMetricsStats: (containerId, metricType, hours = 24) => 
    request(`/metrics/stats/${containerId}/${metricType}?hours=${hours}`),
  
  detectAnomalies: ({ containerId, metricType, hours = 24, startTime, endTime, algorithms = ['z_score', 'moving_average', 'trend'] }) =>
    request('/metrics/anomalies', { 
      method: 'POST', 
      body: JSON.stringify({ containerId, metricType, hours, startTime, endTime, algorithms })
    }),
  
  evaluateAlerts: (containerId) => 
    request(`/metrics/evaluate-alerts/${containerId}`),
  
  applyRetentionPolicy: () => 
    request('/metrics/retention-policy', { method: 'POST' }),
};
