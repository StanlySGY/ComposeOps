import { userError } from '../lib/user-error.js';
import { notifyDataChanged, DATA_CHANGED_EVENT } from '../lib/data-changes.js';
// 统一 API 客户端,基于 fetch 封装
import { normalizeBackgroundJob, normalizeCostReport, normalizeDockerUsage, normalizeJobsResponse, normalizeMetrics, normalizeMountPlan, normalizeStorageDf } from '../lib/api-normalizers.js';

const BASE = '/api/v1';

/**
 * SWR(Stale-While-Revalidate)内存缓存:
 * - GET 命中有效缓存时立即返回旧数据(0ms 秒开),后台静默拉取最新数据;
 * - 每次读取都在后台拉新;write 请求成功后自动失效相关缓存。
 */
const swrCache = new Map(); // key -> { data, hasData, inflight, promise }
const CACHEABLE_PATHS = ['/projects', '/hosts', '/personal/preferences', '/system/capabilities', '/ops/blueprints', '/cron'];
let hostEpoch = 0;

function isGet(opts) {
  return !opts?.method || opts.method.toUpperCase() === 'GET';
}
function cacheable(path, opts) {
  return isGet(opts) && (CACHEABLE_PATHS.includes(path) || opts.cacheable);
}
function waitForReadRecovery(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('请求已取消', 'AbortError'));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 250);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function doFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const hasBody = opts.body !== undefined && opts.body !== null && opts.body !== '';
  if (hasBody && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  const init = {
    ...Object.fromEntries(Object.entries(opts).filter(([key]) => !['readOnly', 'notify', 'force', 'cacheable', 'cacheKey'].includes(key))),
    headers,
  };
  const epoch = hostEpoch;
  // One bounded recovery for transport failures only. Never replay a write or a
  // request whose node/abort context changed while the browser was reconnecting.
  for (let attempt = 0; ; attempt++) {
    try {
      if (opts.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      const res = await fetch(`${BASE}${path}`, init);
      if (!res.ok) {
        let msg = res.statusText;
        let code;
        try {
          const body = await res.json();
          msg = body.message || body.error || JSON.stringify(body);
          code = body.code || body.error;
        } catch {
          // 错误响应可能不是 JSON,保留 HTTP 状态文本作为兜底。
        }
        const err = userError(msg, { status: res.status, code });
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
      return await res.text();
    } catch (cause) {
      const transient = cause?.name === 'TypeError' && /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(cause.message);
      if (attempt || !isGet(opts) || !transient || opts.signal?.aborted || epoch !== hostEpoch) throw userError(cause);
      await waitForReadRecovery(opts.signal);
      if (epoch !== hostEpoch) throw new DOMException('节点已切换', 'AbortError');
    }
  }
}
function revalidate(key, path, opts) {
  const entry = swrCache.get(key);
  if (!entry || entry.inflight) return;
  entry.inflight = true;
  doFetch(path, opts)
    .then((data) => {
      // 写操作/强刷/切节点会替换或删除 entry,迟到响应不能复活已失效的数据。
      if (swrCache.get(key) === entry) { entry.data = data; entry.inflight = false; }
    })
    .catch(() => { if (swrCache.get(key) === entry) entry.inflight = false; });
}
/** SSE/流式响应的非 2xx 错误统一解析为 Error。 */
async function streamError(res, fallback) {
  const payload = await res.json().catch(() => ({}));
  return userError(payload.message || payload.error || fallback, { status: res.status, code: payload.code || payload.error });
}
async function request(path, opts = {}) {
  if (!isGet(opts)) {
    const data = await doFetch(path, opts);
    // 写入可能同时影响列表、事件和操作记录,统一失效避免新增资源遗漏。
    if (!opts.readOnly) {
      invalidateSwr('/');
      // 保留部署预览/校验等只读推演端点的刷新隔离，同时允许调用方显式关闭通知。
      const suppressedPrefixes = ['/auth', '/ai/agent/sessions', '/ai/agent/approval', '/ai/agent/feedback', '/ai/agent/compact'];
      const suppressedSegments = ['/ping', '/check', '/preview', '/deploy-preview', '/validate', '/anomalies', '/test'];
      const suppressNotify = opts.notify === false || suppressedPrefixes.some(prefix => path.startsWith(prefix)) || suppressedSegments.some(segment => path.includes(segment));
      if (!suppressNotify) notifyDataChanged({ source: 'api', path });
    }
    return data;
  }
  const key = `${hostEpoch}:${path}${opts.cacheKey || ''}`;
  const entry = swrCache.get(key);
  if (entry?.hasData && !opts.force) {
    revalidate(key, path, opts);
    return entry.data;
  }
  if (entry?.promise && !opts.force) return entry.promise;
  if (!cacheable(path, opts)) return doFetch(path, opts);
  // 先登记请求身份,失效操作也能清除尚未返回的首轮请求。强刷同时替换旧缓存。
  const pending = { hasData: false, inflight: true };
  swrCache.set(key, pending);
  pending.promise = doFetch(path, opts).then((data) => {
    if (swrCache.get(key) === pending) {
      pending.data = data;
      pending.hasData = true;
      pending.inflight = false;
      pending.promise = null;
    }
    return data;
  }).catch((error) => {
    if (swrCache.get(key) === pending) swrCache.delete(key);
    throw error;
  });
  return pending.promise;
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
  getSreResource: (path, signal) => request('/sre/' + path, { signal }),
  getSreOperations: (signal) => request('/sre/operations', { signal }),
  sreOperation: (path, data = {}, method = 'POST') => request('/sre/' + path, { method, body: JSON.stringify(data) }),
  getRecoveryCandidates: (params, signal) => request('/sre/recovery/candidates?' + new URLSearchParams(params), { signal }),
  archiveSreProfile: (id) => request('/sre/profiles/' + encodeURIComponent(id), { method: 'DELETE' }),
  closeIncident: (id, reason) => request('/incidents/' + encodeURIComponent(id) + '/close', { method: 'POST', body: JSON.stringify({ reason }) }),
  getSreProfiles: (signal) => request('/sre/profiles', { signal }),
  getSreTargets: (signal) => request('/sre/targets', { signal }),
  saveSreProfile: (profile) => request('/sre/profiles' + (profile.id ? '/' + encodeURIComponent(profile.id) : ''), { method: profile.id ? 'PUT' : 'POST', body: JSON.stringify(profile) }),
  pauseSreProfile: (id) => request('/sre/profiles/' + encodeURIComponent(id) + '/pause', { method: 'POST' }),
  saveSreAutonomy: (id, policy) => request('/sre/profiles/' + encodeURIComponent(id) + '/autonomy', { method: 'PUT', body: JSON.stringify(policy) }),
  getIncidents: (params = {}, signal) => request('/incidents?' + new URLSearchParams(params), { signal }),
  getIncident: (id, signal) => request('/incidents/' + encodeURIComponent(id), { signal }),
  getIncidentCorrelation: (id, signal) => request('/incidents/' + encodeURIComponent(id) + '/correlation', { signal }),
  diagnoseIncident: (id) => request('/incidents/' + encodeURIComponent(id) + '/diagnose', { method: 'POST', body: '{}' }),
  proposeIncidentRestart: (id) => request('/incidents/' + encodeURIComponent(id) + '/propose-restart', { method: 'POST', body: '{}' }),
  recordCostSnapshot: () => request('/cost-analysis/snapshot', { method: 'POST' }),
  getAiRetention: () => request('/personal/maintenance/ai-retention'),
  saveAiRetention: (days) => request('/personal/maintenance/ai-retention', { method: 'PUT', body: JSON.stringify({ days }) }),
  pruneAiRetention: (days) => request('/personal/maintenance/ai-retention/prune', { method: 'POST', body: JSON.stringify({ days }) }),
  previewRetentionPolicy: () => request('/metrics/retention-policy'),
  listInspectionReports: (limit = 100) => request(`/ops/inspection/reports?limit=${limit}`),
  setHostGroup: (id, group) => request(`/hosts/${encodeURIComponent(id)}/group`, { method: 'PATCH', body: JSON.stringify({ group }) }),
  getAuthStatus: (signal) => request('/auth/status', { signal }),
  // setupToken:服务端设置 SETUP_TOKEN 环境变量时,首次初始化必须携带该引导令牌
  setup: (password, setupToken = '') => request('/auth/setup', { notify: false, method: 'POST', body: JSON.stringify({ password, setupToken }) }),
  login: (password) => request('/auth/login', { notify: false, method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/auth/logout', { notify: false, method: 'POST' }),
  changePassword: (payload) => request('/auth/password', { notify: false, method: 'POST', body: JSON.stringify(payload) }),
  getProjects: (force = false) => request('/projects', { force }),
  getHostDirectories: (params, signal) => request('/projects/directories?' + new URLSearchParams(params), { signal }),
  followDeploymentJob: (jobId, onFrame, signal) => followDeploymentJob(jobId, onFrame, signal),
  getComposeProjectCreateOptions: (signal) => request('/projects/create-options', { signal }),
  streamCustomComposeProjectDeploy: (payload, onFrame, signal) =>
    streamComposeControl(null, null, onFrame, '/projects/create', payload, signal),
  getStandaloneContainers: () => request('/projects/standalone-containers'),
  runStandaloneContainerAction: (id, action, expectedHostId) => request(`/projects/standalone-containers/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action, expectedHostId }) }),
  runComposeServiceAction: (projectId, service, action) => request(`/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(service)}/actions`, { method: 'POST', body: JSON.stringify({ action }) }),
  getMountPlan: async () => normalizeMountPlan(await request('/projects/mount-plan')),
  saveProjectManagement: (projectIds, mountProjectIds = [], options = {}) => request('/projects/management', { method: 'PUT', body: JSON.stringify({ projectIds, mountProjectIds, ...options }) }),
  getProjectGroups: () => request('/projects/groups'),
  createProjectGroup: data => request('/projects/groups', { method: 'POST', body: JSON.stringify(data) }),
  updateProjectGroup: (id, data) => request(`/projects/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProjectGroup: id => request(`/projects/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assignProjectGroups: (expectedHostId, assignments) => request('/projects/group-assignments', { method: 'PUT', body: JSON.stringify({ expectedHostId, assignments }) }),
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
  reviewDeployment: (projectId) => request(`/projects/${projectId}/deployment-review`, { readOnly: true, method: 'POST' }),
  getComposeFile: (projectId, fileIndex = 0, force = false) => request(`/projects/${projectId}/compose?fileIndex=${fileIndex}`, { force }),
  saveComposeFile: (projectId, fileIndex, content, expectedContent) =>
    request(`/projects/${projectId}/compose`, { method: 'PUT', body: JSON.stringify({ fileIndex, content, expectedContent }) }),
  getProjectEnv: (projectId, file = '', force = false) => request(`/projects/${projectId}/env?${new URLSearchParams({ ...(file ? { file } : {}), ...(force ? { force: '1' } : {}) })}`),
  getProjectEnvFiles: (projectId) => request(`/projects/${projectId}/env/files`),
  saveProjectEnv: (projectId, payload) => request(`/projects/${projectId}/env`, { method: 'PUT', body: JSON.stringify(payload) }),
  getBackups: (projectId) => request(`/projects/${projectId}/backups`),
  getBackup: (projectId, backupId) => request(`/projects/${projectId}/backups/${backupId}`),
  restoreBackup: (projectId, backupId) => request(`/projects/${projectId}/backups/${backupId}/restore`, { method: 'POST' }),
  getProjectEnvBackups: (projectId, file = '.env') => request('/projects/' + projectId + '/env/backups?' + new URLSearchParams({ file })),
  restoreProjectEnvBackup: (projectId, file, backup, expectedVersion) => request('/projects/' + projectId + '/env/backups/restore', { method: 'POST', body: JSON.stringify({ file, backup, expectedVersion }) }),
  // docker hosts
  getHosts: (force = false) => request('/hosts', { force }),
  saveHost: (payload) => request('/hosts', { method: 'POST', body: JSON.stringify(payload) }),
  deleteHost: (id) => request(`/hosts/${id}`, { method: 'DELETE' }),
  pingHost: (id, probe) => request(`/hosts/${id}/ping`, { readOnly: true, method: 'POST', body: JSON.stringify(probe ? { probe } : {}) }),
  setActiveHost: (hostId) => request('/hosts/active', { method: 'PUT', body: JSON.stringify({ hostId }) }),
  prepareFullRestore: (payload) => request('/maintenance/restore-plans', { method: 'POST', readOnly: true, body: JSON.stringify(payload) }),
  executeFullRestore: (payload) => request('/maintenance/restore', { method: 'POST', body: JSON.stringify(payload) }),
  getMaintenance: () => request('/maintenance/', { force: true }),
  saveImageCheckSettings: (payload) => request('/maintenance/image-check/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  testImageCheckProxy: (payload) => request('/maintenance/image-check/test', { method: 'POST', body: JSON.stringify(payload) }),
  saveMaintenanceSettings: (backupPath) => request('/maintenance/settings', { method: 'PUT', body: JSON.stringify({ backupPath }) }),
  prepareMaintenance: (payload) => request('/maintenance/plans', { method: 'POST', body: JSON.stringify(payload) }),
  executeMaintenance: (payload) => request('/maintenance/execute', { method: 'POST', body: JSON.stringify(payload) }),
  recoverMaintenanceTask: (id) => request(`/maintenance/tasks/${encodeURIComponent(id)}/recover`, { method: 'POST', body: JSON.stringify({ confirmed: true }) }),
  getSyncTargets: () => request('/maintenance/targets', { force: true }),
  saveSyncTarget: (payload) => request('/maintenance/targets', { method: 'POST', body: JSON.stringify(payload) }),
  setSyncAutomatic: (id, auto) => request(`/maintenance/targets/${encodeURIComponent(id)}/auto`, { method: 'PUT', body: JSON.stringify({ auto }) }),
  startBackupSync: (payload) => request('/maintenance/sync', { method: 'POST', body: JSON.stringify(payload) }),
  authorize115: (targetId) => request('/maintenance/115/authorize', { method: 'POST', body: JSON.stringify({ targetId }) }),
  pollAuthorize115: (id) => request(`/maintenance/115/authorize/${encodeURIComponent(id)}/poll`, { method: 'POST' }),
  getFullBackupPlan: (id) => request(`/ops/storage/full-backup-plan?projectId=${encodeURIComponent(id)}`, { force: true }),
  // image update radar
  getProjectUpdates: (projectId, force = false, options = {}) => request(`/projects/${projectId}/updates?force=${force ? '1' : '0'}`, { signal: options.signal }),
  getProjectWebUiSettings: (id) => request(`/projects/${id}/webui-settings`, { force: true }),
  saveProjectWebUiSettings: (id, data) => request(`/projects/${id}/webui-settings`, { method: 'PUT', body: JSON.stringify(data) }),
  getProjectWebUi: (projectId) => request(`/projects/${projectId}/webui`),
  listDbDumpTargets: (projectId) => request(`/projects/${projectId}/db-dump`),
  listCronJobs: (force = false) => request('/cron', { force }),
  previewCronSchedule: (cron) => request(`/cron/preview?${new URLSearchParams({ cron })}`),
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
  streamUpgrade: (projectId, services, onFrame, signal) => streamComposeControl(projectId, null, onFrame, `/projects/${projectId}/upgrade`, { services }, signal),
  streamRollback: (projectId, onFrame, signal) => streamComposeControl(projectId, null, onFrame, `/projects/${projectId}/rollback`, {}, signal),
  checkAllUpdates: (options = {}) => request('/ops/updates/check-all', { method: 'POST', readOnly: true, signal: options.signal }),
  // docker storage
  getStorageDf: async () => normalizeStorageDf(await request('/ops/storage/df')),
  pruneStorage: (mode, confirm) => request('/ops/storage/prune', { method: 'POST', body: JSON.stringify({ mode, confirm }) }),
  getStorageResources: (force = false) => request('/ops/storage/resources', { force }),
  getProjectVolumes: (projectId) => request(`/ops/storage/volume-volumes?projectId=${encodeURIComponent(projectId)}`),
  getVolumeBackups: (projectId = '') => request(`/ops/storage/volume-backups${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  createVolumeBackup: (projectId, volume) => request('/ops/storage/volume-backups', { method: 'POST', body: JSON.stringify({ projectId, volume }) }),
  restoreVolumeBackup: (id) => request(`/ops/storage/volume-backups/${id}/restore`, { method: 'POST' }),
  verifyVolumeBackup: (id) => request(`/ops/storage/volume-backups/${id}/verify`, { method: 'POST' }),
  deleteVolumeBackup: (id) => request(`/ops/storage/volume-backups/${id}`, { method: 'DELETE' }),
  volumeBackupDownloadUrl: (id) => `/api/v1/ops/storage/volume-backups/${id}/download`,
  removeStorageResource: (kind, id, hostId) => request(`/ops/storage/resources/${kind}/${encodeURIComponent(id)}${hostId ? `?expectedHostId=${encodeURIComponent(hostId)}` : ''}`, { method: 'DELETE' }),
  // app blueprints
  getBlueprints: () => request('/ops/blueprints'),
  streamBlueprintDeploy: (blueprintId, values, onFrame, signal, expectedHostId) => streamComposeControl(null, null, onFrame, '/ops/blueprints/deploy', { blueprintId, values, expectedHostId }, signal),
  // alert events
  getNotificationEvents: () => request('/ops/notifications/events'),
  saveNotificationEvents: (events) => request('/ops/notifications/events', { method: 'PUT', body: JSON.stringify({ events }) }),
  getAlertEvents: (limit = 50) => request(`/ops/alert-events?limit=${limit}`),
  updateAlertEvent: (id, patch) => request(`/ops/alert-events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  pruneAlertEvents: (days = 7) => request('/ops/alert-events/prune', { method: 'POST', body: JSON.stringify({ days }) }),
  // 守护模式:告警事件 AI 自动诊断
  getGuardian: () => request('/ops/guardian'),
  setGuardian: (enabled) => request('/ops/guardian', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  diagnoseAlertEvent: (id) => request(`/ops/alert-events/${id}/diagnose`, { method: 'POST' }),
  // AI 巡检
  getInspectionOverview: (limit = 20) => request(`/ops/inspection/overview?limit=${limit}`),
  getInspectionReport: (id) => request(`/ops/inspection/reports/${id}`),
  runInspection: () => request('/ops/inspection/run', { method: 'POST', body: JSON.stringify({}) }),
  saveInspectionSchedule: (payload) => request('/ops/inspection/schedule', { method: 'PUT', body: JSON.stringify(payload) }),
  pruneInspections: (days = 180) => request('/ops/inspection/prune', { method: 'POST', body: JSON.stringify({ days }) }),
  // ai
  getAiConfig: () => request('/ai/config'),
  saveAiConfig: (payload) => request('/ai/config', { method: 'POST', body: JSON.stringify(payload) }),
  fetchAiModels: (payload = {}) => request('/ai/fetch-models', { readOnly: true, method: 'POST', body: JSON.stringify(payload) }),
  saveAiChannel: (id, payload) => request(`/ai/channels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteAiChannel: (id, revision) => request(`/ai/channels/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ revision }) }),
  reorderAiChannels: (ids, previousIds) => request('/ai/channels/order', { method: 'POST', body: JSON.stringify({ ids, previousIds }) }),
  revealAiChannelKey: (id) => request(`/ai/channels/${encodeURIComponent(id)}/reveal-key`, { readOnly: true, method: 'POST', cache: 'no-store' }),
  testAiChannel: (id) => request(`/ai/channels/${encodeURIComponent(id)}/test`, { notify: false, method: 'POST' }),
  getProjectLogs: (projectId, containerId, tail = 200) => request('/ai/logs', { readOnly: true, method: 'POST', body: JSON.stringify({ projectId, containerId, tail }) }),
  getAiHistory: (sessionId, limit = 200, beforeId = null) => request(`/ai/history?${new URLSearchParams({ ...(sessionId ? { sessionId } : {}), ...(beforeId ? { beforeId } : {}), limit })}`),
  getAiSessions: (limit = 30, kind = '') => request(`/ai/sessions?limit=${limit}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`),
  createAgentSession: () => request('/ai/agent/sessions', { notify: false, method: 'POST' }),
  renameAgentSession: (sessionId, title) => request(`/ai/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  getAiMemories: (limit = 20, query = '') => request(`/ai/agent/memories?limit=${limit}${query ? `&query=${encodeURIComponent(query)}` : ''}`),
  compactAgentSession: (sessionId, keepRecent = 6) => request('/ai/agent/compact', { notify: false, method: 'POST', body: JSON.stringify({ sessionId, keepRecent }) }),
  getAgentUsage: (days = 30) => request(`/ai/agent/usage?days=${encodeURIComponent(days)}`),
  clearAiHistory: (sessionId) => request(`/ai/history${sessionId ? `?sessionId=${sessionId}` : ''}`, { method: 'DELETE' }),
  clearAiSessions: (sessionIds) => request('/ai/history/batch-delete', { method: 'POST', body: JSON.stringify({ sessionIds }) }),
  truncateAiHistory: (sessionId, fromMessageId) => request('/ai/history/truncate', { method: 'POST', body: JSON.stringify({ sessionId, fromMessageId }) }),
  // ai agent:执行已收敛为 Tool Loop 流式通道;会话/记忆/审计见上方与下方的端点
  agentExecuteStream: (payload, onEvent, signal) => streamSse('/ai/agent/execute-stream', { ...payload, protocol: 'ag-ui' }, onEvent, signal, 'ag-ui'),
  getAgentRoles: () => request('/ai/agent/roles'),
  getAgentTasks: (limit = 50, filters = {}) => request('/ai/agent/tasks?' + new URLSearchParams({ limit: String(limit), ...(filters.status ? { status: filters.status } : {}), ...(filters.sessionId ? { sessionId: String(filters.sessionId) } : {}) })),
  getAgentTask: (id, waitMs = 0) => request('/ai/agent/tasks/' + encodeURIComponent(id) + '?waitMs=' + encodeURIComponent(waitMs)),
  stopAgentTask: (id) => request('/ai/agent/tasks/' + encodeURIComponent(id) + '/stop', { method: 'POST' }),
  agentApprove: (payload) => request('/ai/agent/approve', { notify: false, method: 'POST', body: JSON.stringify(payload) }),
  agentFeedback: (payload) => request('/ai/agent/feedback', { notify: false, method: 'POST', body: JSON.stringify(payload) }),
  setAgentApprovalMode: (payload) => request('/ai/agent/approval-mode', { notify: false, method: 'POST', body: JSON.stringify(payload) }),
  getAgentExecutions: (planId = '', limit = 100) => request(`/ai/agent/executions?${new URLSearchParams({ ...(planId ? { planId: String(planId) } : {}), limit: String(limit) })}`),
  getAgentPolicyGroups: () => request('/ai/agent/policy-groups'),
  createAgentPolicyGroup: (payload) => request('/ai/agent/policy-groups', { method: 'POST', body: JSON.stringify(payload) }),
  updateAgentPolicyGroup: (id, payload) => request(`/ai/agent/policy-groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteAgentPolicyGroup: (id) => request(`/ai/agent/policy-groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getAgentPolicyRules: (groupId = '') => request(`/ai/agent/policy-rules${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ''}`),
  createAgentPolicyRule: (payload) => request('/ai/agent/policy-rules', { method: 'POST', body: JSON.stringify(payload) }),
  updateAgentPolicyRule: (id, payload) => request(`/ai/agent/policy-rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteAgentPolicyRule: (id) => request(`/ai/agent/policy-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getAgentAuditEvents: (limit = 100, filters = {}) => request(`/ai/agent/audit-events?${new URLSearchParams({ limit: String(limit), ...(filters.planId ? { planId: filters.planId } : {}), ...(filters.executionId ? { executionId: filters.executionId } : {}) })}`),
  // compose 语义校验 / 变更预览
  validateCompose: (projectId, fileIndex, content) => request(`/projects/${projectId}/compose/validate`, { readOnly: true, method: 'POST', body: JSON.stringify({ fileIndex, content }) }),
  previewCompose: async (projectId, content, fileIndex = 0) => {
    const result = await request(`/projects/${projectId}/compose/preview`, { readOnly: true, method: 'POST', body: JSON.stringify({ content, fileIndex }) });
    return result?.preview || null;
  },
  // system
  getMetrics: async (hostId = '') => normalizeMetrics(await request(`/system/metrics${hostId ? `?hostId=${encodeURIComponent(hostId)}` : ''}`)),
  getInfrastructure: (hostId, signal) => request(`/system/infrastructure?${new URLSearchParams({ hostId })}`, { signal }),
  getInfrastructureHistory: (params, signal) => request(`/system/infrastructure/history?${new URLSearchParams(params)}`, { signal }),
  getInfrastructureStorage: (hostId, signal) => request(`/system/infrastructure/storage?${new URLSearchParams({ hostId })}`, { signal }),
  getCapabilities: () => request('/system/capabilities'),
  getPreferences: () => request('/personal/preferences'),
  savePreferences: (payload) => request('/personal/preferences', { method: 'PUT', body: JSON.stringify(payload) }),
  getNotifications: () => request('/personal/notifications'),
  saveNotifications: (payload) => request('/personal/notifications', { method: 'PUT', body: JSON.stringify(payload) }),
  testNotifications: (payload) => request('/personal/notifications/test', { notify: false, method: 'POST', body: JSON.stringify(payload) }),
  getOperations: () => request('/personal/operations', { cacheable: true }),
  getDockerUsage: async (hostId = '') => normalizeDockerUsage(await request(`/personal/maintenance/usage${hostId ? `?hostId=${encodeURIComponent(hostId)}` : ''}`)),
  getCostAnalysisReport: async () => normalizeCostReport(await request('/cost-analysis/report')),
  getCostTrends: () => request('/cost-analysis/trends?days=7'),
  getCostSuggestions: () => request('/cost-analysis/suggestions'),
  getUpdateSettings: () => request('/personal/updates'),
  saveUpdateSettings: (payload) => request('/personal/updates', { method: 'PUT', body: JSON.stringify(payload) }),
  checkUpdates: () => request('/personal/updates/check', { method: 'POST' }),
  // MCP 服务管理
  getMcpConfig: () => request('/system/mcp'),
  saveMcpConfig: (payload) => request('/system/mcp', { method: 'POST', body: JSON.stringify(payload) }),
  revealMcpToken: () => request('/system/mcp/reveal-token', { readOnly: true, method: 'POST' }),
  // 部署预言:up 前静态推演(会重建什么/端口冲突/卷风险)
  previewDeploy: (projectId, ai = false) => request('/ops/deploy-preview', { readOnly: true, method: 'POST', body: JSON.stringify({ projectId, ai }) }),
  exportUrl: `${BASE}/personal/export`,
  importData: (payload) => request('/personal/import', { method: 'POST', body: JSON.stringify(payload) }),
  // marketplace
  getMarketplaceStats: () => request('/marketplace/stats'),
  discoverAiTemplate: (query, signal) => request('/marketplace/templates/ai-discover', { readOnly: true, method: 'POST', body: JSON.stringify({ query }), signal }),
  searchMarketplaceTemplates: (params) => request(`/marketplace/templates/search?${params.toString()}`),
  toggleMarketplaceFavorite: (templateId, isFavorited) => request(`/marketplace/favorites/${templateId}`, { method: isFavorited ? 'DELETE' : 'POST' }),
  createMarketplaceTemplate: (payload) => request('/marketplace/templates/custom', { method: 'POST', body: JSON.stringify(payload) }),
  updateMarketplaceTemplate: (id, payload) => request(`/marketplace/templates/custom/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteMarketplaceTemplate: (id) => request(`/marketplace/templates/custom/${id}`, { method: 'DELETE' }),
  // CMDB 统一资产中心
  getCmdbAssets: (params = {}) => request(`/cmdb/assets?${new URLSearchParams(params)}`, { cacheable: true }),
  deleteCmdbAsset: (id) => request(`/cmdb/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  syncCmdbAssets: () => request('/cmdb/assets/sync', { method: 'POST' }),
  getCmdbTopology: () => request('/cmdb/topology', { cacheable: true }),
  addCmdbRelation: (payload) => request('/cmdb/relations', { method: 'POST', body: JSON.stringify(payload) }),
  deleteCmdbRelation: (id) => request(`/cmdb/relations/${id}`, { method: 'DELETE' }),
  // 统一事件中心
  getEvents: (params = {}, force = false) => request(`/events/events?${new URLSearchParams(params)}`, { cacheable: true, force }),
  getEventStats: (force = false) => request('/events/events/stats', { cacheable: true, force }),
  updateEvent: (id, patch) => request(`/events/events/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  pruneEvents: (days = 30) => request('/events/events/prune', { method: 'POST', body: JSON.stringify({ days }) }),
  // 工作流中心
  getWorkflowDefinitions: (force = false) => request('/workflows/definitions', { cacheable: true, force }),
  createWorkflowDefinition: (payload) => request('/workflows/definitions', { method: 'POST', body: JSON.stringify(payload) }),
  updateWorkflowDefinition: (id, payload) => request(`/workflows/definitions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteWorkflowDefinition: (id) => request(`/workflows/definitions/${id}`, { method: 'DELETE' }),
  runWorkflow: (id, context = {}) => request(`/workflows/definitions/${id}/run`, { method: 'POST', body: JSON.stringify({ context }) }),
  getWorkflowInstances: (params = {}, force = false) => request(`/workflows/instances?${new URLSearchParams(params)}`, { cacheable: true, force }),
  getWorkflowInstance: (id) => request(`/workflows/instances/${id}`),
  approveWorkflowInstance: (id, payload) => request(`/workflows/instances/${id}/approve`, { method: 'POST', body: JSON.stringify(payload) }),
  cancelWorkflowInstance: (id) => request(`/workflows/instances/${id}/cancel`, { method: 'POST' }),
  // 独立于 Agent Session 的长期运维任务、授权快照、派工、报告与 Effect 台账
  getOpsTickets: (params = {}) => request('/ops-tickets?' + new URLSearchParams(params)),
  getOpsTicket: (id) => request('/ops-tickets/' + encodeURIComponent(id)),
  createOpsTicket: (payload) => request('/ops-tickets', { method: 'POST', body: JSON.stringify(payload) }),
  updateOpsTicket: (id, payload) => request('/ops-tickets/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(payload) }),
  issueOpsMandate: (id, payload) => request('/ops-tickets/' + encodeURIComponent(id) + '/mandates', { method: 'POST', body: JSON.stringify(payload) }),
  revokeOpsMandate: (id, mandateId, reason) => request('/ops-tickets/' + encodeURIComponent(id) + '/mandates/' + encodeURIComponent(mandateId) + '/revoke', { method: 'POST', body: JSON.stringify({ reason }) }),
  createOpsAssignment: (id, payload) => request('/ops-tickets/' + encodeURIComponent(id) + '/assignments', { method: 'POST', body: JSON.stringify(payload) }),
  updateOpsAssignment: (id, assignmentId, payload) => request('/ops-tickets/' + encodeURIComponent(id) + '/assignments/' + encodeURIComponent(assignmentId), { method: 'PATCH', body: JSON.stringify(payload) }),
  reconcileOpsAssignment: (id, assignmentId, payload) => request('/ops-tickets/' + encodeURIComponent(id) + '/assignments/' + encodeURIComponent(assignmentId) + '/reconcile', { method: 'POST', body: JSON.stringify(payload) }),
  createOpsReport: (id, payload) => request('/ops-tickets/' + encodeURIComponent(id) + '/reports', { method: 'POST', body: JSON.stringify(payload) }),
  decideOpsReport: (id, reportId, payload) => request('/ops-tickets/' + encodeURIComponent(id) + '/reports/' + encodeURIComponent(reportId) + '/decision', { method: 'POST', body: JSON.stringify(payload) }),
  createOpsEffect: (id, payload) => request('/ops-tickets/' + encodeURIComponent(id) + '/effects', { method: 'POST', body: JSON.stringify(payload) }),
  getOpsEffectWorkerStatus: () => request('/ops-tickets/worker/status'),
  approveOpsEffect: (id, effectId) => request('/ops-tickets/' + encodeURIComponent(id) + '/effects/' + encodeURIComponent(effectId) + '/approve', { method: 'POST' }),
  cancelOpsEffect: (id, effectId, reason = '') => request('/ops-tickets/' + encodeURIComponent(id) + '/effects/' + encodeURIComponent(effectId) + '/cancel', { method: 'POST', body: JSON.stringify({ reason }) }),
  reconcileOpsEffect: (id, effectId, payload) => request('/ops-tickets/' + encodeURIComponent(id) + '/effects/' + encodeURIComponent(effectId) + '/reconcile', { method: 'POST', body: JSON.stringify(payload) }),
  // 容器状态历史(uptime-kuma 式服务端持久化):分析型视图,读取频率低但必须实时,
  // 因此不走 SWR 缓存 —— 下拉刷新要看到新数据,不能先回缓存再后台重验。
  getStateHistory: (params = {}) => request(`/state/history?${new URLSearchParams(params)}`),
  getStateUptime: (params = {}) => request(`/state/uptime?${new URLSearchParams(params)}`),
  getStateExits: (params = {}) => request(`/state/exits?${new URLSearchParams(params)}`),
  pruneStateHistory: (days = 90) => request('/state/prune', { method: 'POST', body: JSON.stringify({ days }) }),
};

/** 断线后只查询既有任务，绝不重新 POST 部署请求。 */
export async function followDeploymentJob(jobId, onFrame, signal) {
  while (!signal?.aborted) {
    const job = normalizeBackgroundJob(await request('/jobs/' + encodeURIComponent(jobId), { signal }));
    onFrame({ type: 'output', data: job.items[0]?.output || '' });
    if (job.result?.phase) onFrame({ type: 'phase', data: job.result });
    if (!['queued', 'running'].includes(job.status)) {
      onFrame({ type: 'result', data: job.result });
      onFrame({ type: 'exit', data: { code: job.status === 'success' ? 0 : 1 } });
      return job;
    }
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1200);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  throw new DOMException('Aborted', 'AbortError');
}

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
  const maxFrameChars = 2 * 1024 * 1024;
  let ended = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { ended = true; break; }
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop();
      for (const part of parts) {
        if (part.length > maxFrameChars) throw new Error('单条控制消息超过处理上限，已中断接收；请核对实际执行状态');
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        let frame;
        try {
          frame = JSON.parse(line.slice(5).trim());
        } catch {
          // 跳过无法解析的控制流帧,让连接继续接收后续事件。
          continue;
        }
        onFrame(frame);
      }
      if (buf.length > maxFrameChars) throw new Error('控制消息持续未结束，已中断接收；请核对实际执行状态');
    }
  } finally {
    // Polling during a long command can cache containers that are being replaced.
    // Clear them again on completion or interruption before callers refresh.
    invalidateSwr('/');
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * AI 对话 / 诊断 SSE 流式
 */
const NATIVE_AGENT_EVENT_TYPES = new Set([
  'token', 'session_meta', 'done', 'error', 'interrupted', 'confirmation_required', 'approval_mode',
  'tool_requested', 'tool_executing', 'tool_result', 'tool_error', 'tool_rejected',
  'context_resolved', 'context_ambiguous', 'context_data', 'action_completed',
  'channel_selected', 'channel_failed', 'channel_unavailable', 'task_notice', 'compaction',
  'max_loops_reached', 'ui_present', 'thinking', 'reasoning', 'trace',
]);

export function normalizeAgUiEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'TEXT_MESSAGE_CONTENT') return { type: 'token', content: String(event.delta || '') };
  if (event.type === 'RUN_FINISHED') return null;
  if (event.type === 'RUN_ERROR') return { type: 'error', content: String(event.message || 'Agent 执行失败') };
  if (event.type === 'CUSTOM') {
    if (String(event.name || '').startsWith('composeops.') && event.value && typeof event.value === 'object') return event.value;
  }
  if (event.type === 'ACTIVITY_DELTA') return { type: 'trace', phase: String(event.activityType || 'agent'), content: String(event.delta || '') };
  // Compatibility with servers and offline transports that still emit the
  // original ComposeOps SSE event envelope while the request prefers AG-UI.
  // Only allow the public event vocabulary; arbitrary extension payloads stay ignored.
  if (NATIVE_AGENT_EVENT_TYPES.has(event.type)) return event;
  return null;
}

export async function streamSse(path, body, onFrame, signal, protocol = 'native') {
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
  const dispatchFrame = (frame) => {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (protocol === 'ag-ui') {
      const normalized = normalizeAgUiEvent(event);
      if (normalized) onFrame(normalized);
      return;
    }
    onFrame(event);
  };
  const drainFrames = (final = false) => {
    buf = buf.replace(/\r\n/g, '\n');
    let boundary = buf.indexOf('\n\n');
    while (boundary >= 0) {
      dispatchFrame(buf.slice(0, boundary));
      buf = buf.slice(boundary + 2);
      boundary = buf.indexOf('\n\n');
    }
    if (final && buf.trim()) dispatchFrame(buf);
    if (final) buf = '';
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buf += decoder.decode();
      drainFrames(true);
      break;
    }
    buf += decoder.decode(value, { stream: true });
    drainFrames();
  }
}

export { streamProjectStats } from './project-stats-stream.js';

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
  
  
  detectAnomalies: ({ containerId, metricType, hours = 24, startTime, endTime, algorithms = ['z_score', 'moving_average', 'trend'] }) =>
    request('/metrics/anomalies', { readOnly: true,
      method: 'POST', 
      body: JSON.stringify({ containerId, metricType, hours, startTime, endTime, algorithms })
    }),
  
  evaluateAlerts: (containerId) => 
    request(`/metrics/evaluate-alerts/${containerId}`),
  
  applyRetentionPolicy: () => 
    request('/metrics/retention-policy', { method: 'POST' }),
};

if (typeof window !== 'undefined') window.addEventListener(DATA_CHANGED_EVENT, () => invalidateSwr('/'));
