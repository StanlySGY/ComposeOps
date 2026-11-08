import { previewSchedule, validateCron, nextRunTime } from '../../backend/src/lib/cron-expression.js';
import { parseDocument } from 'yaml';
import { at, projects, metrics, inspection, operations, alerts, storage, costReport, resources, marketplaceTemplates, channels, preferences, backups, logs, compose } from './fixtures.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const unsupported = () => json({ message: '此操作未在离线预览中模拟，请在自己的部署中使用。没有执行任何真实操作。' }, 501);
const aiConfig = () => ({ channels, failoverEnabled: true, apiKey: '••••demo', model: channels[0]?.model || '', baseUrl: channels[0]?.baseUrl || '', systemPrompt: '离线示例：按实际应用的审批流程演示排障。' });
const eventRecords = [{ id: 1, eventType: 'alert', source: 'alert-monitor', title: alerts[0].title, detail: alerts[0].detail, severity: 'warning', status: 'open', assetName: 'knowledge-base', createdAt: at, payload: { projectId: 'knowledge-base', to: '/logs?projectId=knowledge-base&containerId=demo-wiki-api&from=events' } }];
const cronJobs = [];
const cronTypes = {
  'db-backup': { label: '数据库自动备份', description: '对纳管项目中的数据库执行备份' },
  'prune-safe': { label: 'Docker 安全清理', description: '清理悬空镜像、退出容器与未使用构建缓存' },
  'prune-all': { label: 'Docker 自动深度清理', description: '清理悬空镜像、退出容器与全部未使用构建缓存，不删除数据卷' },
  'images-check': { label: '镜像更新检查', description: '只读检查镜像更新，不拉取或重建容器' },
  'pull-images': { label: '定时拉取镜像', description: '对可编辑项目拉取镜像' },
  'volume-backup': { label: '数据卷备份', description: '备份纳管项目的命名卷' },
  inspection: { label: 'AI 巡检', description: '只读巡检并保存报告' },
};
const enrichCronJob = job => ({ ...job, nextRunAt: job.enabled ? nextRunTime(job.cron)?.getTime() : null, typeLabel: cronTypes[job.type]?.label });
const sessions = [];
const histories = new Map();
const jobs = new Map();
const pending = new Map();
let serial = 1;
const previewHost = { id: 'local', name: '本机 · 示例', type: 'local', active: true, status: 'online', host: 'homelab-demo', port: 2375, group: 'production' };
const sockets = new Set();
function repair() {
  const project = projects[0];
  project.containers[0].state = 'running'; project.containers[0].health = 'healthy'; project.containers[0].status = 'Up (healthy)'; project.status = 'running';
  compose.set(project.id, compose.get(project.id).replace('DB_HOST: db-old', 'DB_HOST: postgres'));
  broadcast();
}
function broadcast() { for (const socket of sockets) if (socket.url.includes('/ws/containers')) socket.message({ type: 'snapshot', projects }); }
function eventStream(frames) { return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } }); }
function agentStream(body, signal) {
  const executionId = 'preview-' + serial++;
  const history = histories.get(body.sessionId) || [];
  const user = { id: serial++, role: 'user', content: body.message, created_at: at };
  history.push(user); histories.set(body.sessionId, history);
  let close;
  const stream = new ReadableStream({
    start(controller) {
      let finished = false;
      const emit = frame => { if (!finished) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(frame) + '\n\n')); };
      close = () => { if (!finished) { finished = true; pending.delete(executionId); controller.close(); } };
      const intro = '这是离线预设排障演示，不会调用模型或连接服务器。\n\n示例日志显示 `getaddrinfo ENOTFOUND db-old`。Compose 中数据库服务名为 `postgres`，建议将 `DB_HOST` 修正为 `postgres` 并重建 wiki-api。请确认下面的模拟操作。';
      emit({ type: 'session_meta', userMessageId: user.id });
      emit({ type: 'tool_executing', tool: 'container.logs', paramsText: '{"containerId":"demo-wiki-api"}' });
      emit({ type: 'tool_result', tool: 'container.logs', success: true, summary: '示例日志：ENOTFOUND db-old', durationMs: 12 });
      emit({ type: 'token', content: intro });
      emit({ type: 'confirmation_required', executionId, toolCallId: 'demo-repair', tool: 'compose.up', risk: 'critical', description: '模拟修正 knowledge-base 的 DB_HOST 并重建 wiki-api。仅更新演示数据。', params: { projectId: 'knowledge-base', services: ['wiki-api'] } });
      pending.set(executionId, approved => {
        if (approved) { repair(); emit({ type: 'action_completed', kind: 'mutation', tool: 'compose.up', projectId: projects[0].id, hostId: 'local' }); }
        const ending = approved ? '\n\n模拟修复完成：wiki-api 已恢复运行，数据库连接检查通过。' : '\n\n已拒绝模拟操作，配置与服务状态保持原样。';
        emit({ type: 'token', content: ending });
        emit({ type: 'done', status: approved ? 'completed' : 'cancelled' });
        history.push({ id: serial++, role: 'assistant', content: intro + ending, created_at: at });
        close();
      });
      signal?.addEventListener('abort', close, { once: true });
      if (signal?.aborted) close();
    },
    cancel() { pending.delete(executionId); signal?.removeEventListener('abort', close); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

export async function previewFetch(input, options = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
  // No native-fetch fallback: unexpected hosts, paths and methods stay offline.
  if (url.origin !== location.origin) return unsupported();
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const method = (options.method || input?.method || 'GET').toUpperCase();
  let body = {};
  try { body = JSON.parse(options.body || '{}'); } catch { return json({ message: '示例请求格式无效' }, 400); }
  const pid = path.split('/')[2];
  const project = projects.find(item => item.id === pid);
  const reads = {
    '/health': { status: 'ok', docker: 'ok', preview: true },
    '/auth/status': { authenticated: true, setupRequired: false },
    '/projects': { projects },
    '/hosts': { hosts: [previewHost] },
    '/hosts/active': { activeHostId: 'local' },
    '/system/metrics': metrics,
    '/system/capabilities': { shellEnabled: false, compose: true, platform: 'linux', version: '1.5.0', preview: true },
    '/personal/preferences': preferences,
    '/personal/notifications': { enabled: false, channels: [] },
    '/personal/updates': { enabled: false, lastResults: [], lastCheck: at },
    '/personal/operations': { operations },
    '/personal/maintenance/usage': storage,
    '/ops/notifications/events': { events: ['exit', 'oom', 'unhealthy'] },
    '/ops/blueprints': { blueprints: [] },
    '/ops/guardian': { enabled: false },
    '/ops/inspection/overview': inspection,
    '/ops/inspection/reports': { reports: inspection.reports || [] },
    '/metrics/retention-policy': { preview: { deleted30d: 0, compactedRows: 0, rawDays: 7, totalDays: 30 } },
    '/ops/alert-events': { events: alerts },
    '/ops/storage/df': storage,
    '/ops/storage/resources': { ...resources, checkedAt: Date.now() },
    '/ops/storage/volume-backups': { backups },
    '/ops/storage/volume-volumes': { volumes: [{ name: 'cache_data', driver: 'local' }] },
    '/ai/config': aiConfig(),
    '/ai/sessions': { sessions },
    '/ai/history': { history: histories.get(Number(url.searchParams.get('sessionId'))) || [], hasMore: false },
    '/ai/agent/memories': { memories: [] },
    '/ai/agent/executions': { plans: [], executions: [] },
    '/ai/agent/usage': { days: 30, totals: { calls: 0, sessions: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, models: [], daily: [] },
    '/ai/agent/audit-events': { events: [] },
    // The offline preview never starts real Agent background work; expose a truthful empty task center.
    '/ai/agent/tasks': { tasks: [] },
    '/ai/agent/feedback': { feedback: [] },
    '/jobs': { jobs: [...jobs.values()] },
    '/ops-tickets': { tickets: [], stats: { open: 0, blocked: 0, review: 0, terminal: 0 } },
    '/ops-tickets/worker/status': { running: false, mode: 'disabled' },
    '/cron': { jobs: cronJobs.map(enrichCronJob), types: cronTypes }, '/cron/history': { history: [] },
    '/gitops': { repos: [] }, '/gitops/drift': { repos: [], summary: {} },
    '/metrics/alerts': { alerts: [] }, '/metrics/historical': { data: [], metrics: [] },
    '/system/mcp': { enabled: false, mode: 'readonly', tokenConfigured: false, tools: [], endpoints: {} },
    '/projects/mount-plan': { projects, summary: { total: 4, managed: 3, operable: 3, unmanaged: 1 }, mounts: [], pendingProjects: [], unsupportedProjects: [], parentSuggestions: [] },
    '/events/events': { events: eventRecords.filter(event => ['eventType', 'status', 'severity'].every(key => !url.searchParams.get(key) || event[key] === url.searchParams.get(key))) },
    '/events/events/stats': { stats: { total: eventRecords.length, open: eventRecords.filter(event => event.status === 'open').length, byType: { alert: eventRecords.length }, bySeverity: { warning: eventRecords.length }, byStatus: Object.fromEntries(['open', 'acknowledged', 'resolved', 'closed'].map(status => [status, eventRecords.filter(event => event.status === status).length])) } },
    '/workflows/definitions': { definitions: [] }, '/workflows/instances': { instances: [] },
    '/cmdb/assets': { assets: [], total: 0 }, '/cmdb/topology': { nodes: [], edges: [] },
    '/cost-analysis/report': costReport, '/cost-analysis/trends': costReport.trends,
    '/cost-analysis/suggestions': { suggestions: [] },
    '/marketplace/stats': { totalBuiltin: 3, totalCommunity: 0, totalCustom: 1, totalFavorites: marketplaceTemplates.filter(t => t.favorited).length, categories: ['Web', 'Database', 'DevOps', 'Custom'], communityAvailable: false },
  };
  if (path.startsWith('/events/events/') && method === 'PATCH') {
    const event = eventRecords.find(item => String(item.id) === path.split('/').pop());
    if (!event) return json({ message: '示例事件不存在' }, 404);
    if (['open', 'acknowledged', 'resolved', 'closed'].includes(body.status)) event.status = body.status;
    return json({ event });
  }
  if (path === '/cron/preview' && method === 'GET') {
    try { return json(previewSchedule(url.searchParams.get('cron'))); }
    catch (error) { return json({ message: error.message }, 400); }
  }
  if (path === '/cron' && method === 'POST') {
    try { validateCron(body.cron); } catch (error) { return json({ message: error.message }, 400); }
    if (!body.name?.trim() || !cronTypes[body.type]) return json({ message: '请填写名称并选择任务类型' }, 400);
    const job = { name: body.name.trim().slice(0, 60), cron: body.cron.trim(), type: body.type, enabled: body.enabled !== false, id: 'demo-cron-' + serial++, createdAt: Date.now() };
    cronJobs.push(job); return json(enrichCronJob(job));
  }
  if (path.startsWith('/cron/') && ['PUT', 'DELETE'].includes(method)) {
    const job = cronJobs.find(item => item.id === pid);
    if (!job) return json({ message: '示例任务不存在' }, 404);
    if (method === 'PUT') {
      try { if (body.cron !== undefined) validateCron(body.cron); }
      catch (error) { return json({ message: error.message }, 400); }
      if (body.type !== undefined && !cronTypes[body.type]) return json({ message: '未知任务类型' }, 400);
      if (body.name !== undefined) job.name = String(body.name).trim().slice(0, 60) || job.name;
      if (body.cron !== undefined) job.cron = String(body.cron).trim();
      if (body.type !== undefined) job.type = body.type;
      if (body.enabled !== undefined) job.enabled = Boolean(body.enabled);
      return json(enrichCronJob(job));
    }
    cronJobs.splice(cronJobs.indexOf(job), 1);
    return json({ ok: true });
  }
  if (path === '/marketplace/templates/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const source = url.searchParams.get('source');
    const category = url.searchParams.get('category');
    return json({ results: marketplaceTemplates.filter(t => (!q || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q)) && (!source || source === 'all' || (source === 'builtin' ? !/^(custom|community)-/.test(t.id) : t.id.startsWith(source + '-'))) && (!category || category === 'all' || t.category === category) && (url.searchParams.get('onlyFavorites') !== 'true' || t.favorited)) });
  }
  if (path.startsWith('/marketplace/favorites/') && ['POST', 'DELETE'].includes(method)) {
    const template = marketplaceTemplates.find(t => t.id === path.split('/').pop());
    if (!template) return json({ message: '示例模板不存在' }, 404);
    template.favorited = method === 'POST';
    return json({ ok: true });
  }
  if (method === 'GET') {
    if (path in reads) return json(clone(reads[path]));
    if (path.startsWith('/jobs/') && jobs.has(pid)) return json(jobs.get(pid));
    if (project) {
      if (path === '/projects/' + pid) return json(project);
      if (path.endsWith('/compose')) return json({ hostId: 'local', content: compose.get(pid), filePath: project.composeFiles[0], path: project.composeFiles[0], fileIndex: 0 });
      if (path.endsWith('/backups')) return json({ backups: [] });
      if (path.endsWith('/activity')) return json({ activity: [], operations: [], backups: [] });
      if (path.endsWith('/updates')) return json({ results: [], updates: [], images: [], hasUpdate: false });
      if (path.endsWith('/webui')) return json({ links: [], urls: [] });
      if (path.endsWith('/env/files')) return json({ files: [{ name: '.env', path: project.workingDir + '/.env' }] });
      if (path.endsWith('/env')) return json({ content: 'TZ=Asia/Shanghai\n', exists: true, file: '.env', path: project.workingDir + '/.env', variables: [] });
      if (path.endsWith('/db-dump')) return json({ targets: [] });
      if (path.endsWith('/stats/stream')) return eventStream([{ type: 'stats', containers: metrics.containers.filter(c => c.projectId === pid) }]);
    }
    if (path.endsWith('/compaction')) return json({ compactedBeforeId: 0, summary: '' });
  }
  if (path === '/cost-analysis/snapshot' && method === 'POST') { const snapshot = { ...costReport.summary, timestamp: Date.now() }; costReport.trends.push(snapshot); return json(snapshot); }
  if (path.startsWith('/ops/storage/resources/') && method === 'DELETE') {
    if (url.searchParams.get('expectedHostId') !== resources.hostId) return json({ error: 'resource_host_changed', message: '示例节点已切换，请刷新后重试' }, 409);
    const [, , , , kind, rawId] = path.split('/');
    const key = { image: 'images', volume: 'volumes', network: 'networks' }[kind];
    const id = decodeURIComponent(rawId || '');
    const row = resources[key]?.find(item => (kind === 'volume' ? item.name : item.id) === id);
    if (!row) return json({ message: '示例资源不存在' }, 404);
    if (row.inUse || row.builtin || (kind === 'volume' && !row.orphan) || (kind === 'network' && !row.unused)) return json({ message: '资源仍被引用，拒绝删除' }, 409);
    resources[key] = resources[key].filter(item => item !== row);
    return json({ ok: true, removed: true, kind, id });
  }
  if (path === '/ai/agent/execute-stream' && method === 'POST') return agentStream(body, options.signal);
  if (path === '/ai/agent/approve' && method === 'POST') {
    const respond = pending.get(body.executionId);
    if (!respond) return json({ message: '该演示审批已结束，请重新发起。' }, 409);
    respond(body.approved === true); return json({ ok: true });
  }
  if (path === '/ai/agent/sessions' && method === 'POST') {
    const sessionId = serial++; sessions.unshift({ sessionId, title: '新的演示会话', kind: 'agent', createdAt: at, updatedAt: at });
    return json({ sessionId });
  }
  if (path === '/ai/logs' && method === 'POST') return json({ logs, count: 3 });
  if (path === '/ai/agent/approval-mode' && method === 'POST') return json({ mode: body.mode });
  if (path === '/ai/history' && method === 'DELETE') { histories.delete(Number(url.searchParams.get('sessionId'))); return json({ ok: true }); }
  if (path === '/ai/agent/feedback' && method === 'POST') return json({ ok: true });
  if (path.startsWith('/ai/channels/')) {
    const id = path.split('/')[3];
    const channel = channels.find(c => c.id === id);
    if (method === 'PUT') {
      // Keys are always fictional. Entered URLs remain inert strings in page memory.
      const value = { ...body, id, apiKey: '••••demo', hasApiKey: true, revision: 'demo-' + serial++ };
      if (channel) Object.assign(channel, value); else channels.push(value);
      return json({ channel: value, order: channels.map(c => c.id) });
    }
    if (channel && path.endsWith('/reveal-key')) return json({ apiKey: 'demo-key-not-a-real-credential' });
    if (channel && method === 'DELETE') { channels.splice(channels.indexOf(channel), 1); return json(aiConfig()); }
  }
  if (path === '/hosts/local/ping' && method === 'POST') {
    const containers = projects.flatMap(project => project.containers);
    Object.assign(previewHost, { latencyMs: 1, containerCount: containers.length, runningCount: containers.filter(c => c.state === 'running').length });
    return json({ ok: true, latencyMs: 1, host: previewHost });
  }
  if (path === '/hosts/local/group' && method === 'PATCH') {
    previewHost.group = body.group;
    return json({ id: 'local', group: body.group });
  }
  if (path === '/hosts/active' && method === 'PUT' && body.hostId === 'local') return json({ ok: true, activeHostId: 'local' });
  if (path === '/ai/channels/order' && method === 'POST') { const ordered = body.ids.map(id => channels.find(c => c.id === id)).filter(Boolean); channels.splice(0, channels.length, ...ordered); return json({ ok: true }); }
  if (path === '/ai/fetch-models' && method === 'POST') return json({ models: ['demo-tool-model', 'demo-backup-model'] });
  if (path === '/ai/config' && method === 'POST') return json(aiConfig());
  if (path === '/jobs' && method === 'POST') {
    const id = 'demo-job-' + serial++;
    const selected = projects.filter(p => body.projectIds?.includes(p.id));
    if (!['up', 'stop', 'restart'].includes(body.action)) return unsupported();
    for (const p of selected) { p.status = body.action === 'stop' ? 'stopped' : 'running'; for (const c of p.containers) { c.state = body.action === 'stop' ? 'exited' : 'running'; c.health = body.action === 'stop' ? '' : 'healthy'; } }
    const job = { id, action: body.action, status: 'success', total: selected.length, completed: selected.length, items: selected.map(p => ({ projectId: p.id, projectName: p.projectName, status: 'success', output: '模拟操作完成，未连接 Docker。', exitCode: 0 })) };
    jobs.set(id, job); broadcast(); return json(job);
  }
  if (project && path.endsWith('/compose/validate') && method === 'POST') {
    const document = parseDocument(body.content || '');
    return json({ valid: !document.errors.length, issues: [...document.errors.map(error => ({ level: 'error', message: error.message })), { level: 'warn', message: '离线预览仅检查 YAML 语法，未运行 docker compose config。' }] });
  }
  if (project && path.endsWith('/compose') && method === 'PUT') { compose.set(pid, body.content); return json({ ok: true, content: body.content }); }
  if (project && path.endsWith('/compose/preview')) return json({ preview: { added: [], removed: [], changed: [], restarted: [], portConflicts: [], unchanged: project.containers.map(c => ({ service: c.service })), warnings: ['仅保存演示内存，刷新后重置'] } });
  if (project && path.endsWith('/preferences')) { Object.assign(project, body); return json(project); }
  if (path === '/personal/preferences' && method === 'PUT') { Object.assign(preferences, body); return json(preferences); }
  if (path.includes('/volume-backups/') && path.endsWith('/verify') && method === 'POST') { Object.assign(backups[0], { verifyStatus: 'verified', verifyAt: at.slice(0, -1), verifyFiles: 128 }); return json({ ok: true, status: 'verified', files: 128, durationMs: 100, message: '离线模拟校验完成', backup: backups[0] }); }
  window.__previewUnsupported?.push(method + ' ' + path);
  return unsupported();
}

class PreviewSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) {
    super(); this.url = String(url); this.readyState = 0; sockets.add(this);
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1; const event = new Event('open'); this.onopen?.(event); this.dispatchEvent(event);
      if (this.url.includes('/ws/containers')) this.message({ type: 'snapshot', projects });
      if (this.url.includes('/ws/logs')) for (const line of logs.trim().split('\n')) this.message({ type: line.includes('ERROR') ? 'stderr' : 'stdout', data: line });
      if (this.url.includes('/ws/aggregated-logs')) for (const line of logs.trim().split('\n')) this.message({ type: 'line', data: { type: 'stdout', container: 'wiki-api', data: line } });
    });
  }
  message(value) { if (this.readyState !== 1) return; const event = new MessageEvent('message', { data: JSON.stringify(clone(value)) }); this.onmessage?.(event); this.dispatchEvent(event); }
  send(payload) {
    // Mirror the read-only log heartbeat without opening a network transport.
    if (/\/ws\/(logs|aggregated-logs)/.test(this.url) && payload === '{"type":"ping"}') this.message({ type: 'pong' });
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; sockets.delete(this); const event = new Event('close'); this.onclose?.(event); this.dispatchEvent(event); }
}
export function installPreviewTransport() {
  window.__previewUnsupported = [];
  window.fetch = previewFetch;
  window.WebSocket = PreviewSocket;
  window.EventSource = class { constructor() { throw new Error('离线预览不连接事件服务器'); } };
  try { localStorage.setItem('composeops:onboarding-dismissed', '1'); } catch { /* private mode */ }
  // Keep direct export/download links from navigating to non-existent backend routes.
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (link && new URL(link.href, location.href).pathname.startsWith('/api/')) {
      event.preventDefault(); window.dispatchEvent(new CustomEvent('composeops:runtime-error', { detail: { message: '离线预览不提供真实数据导出，请在自己的部署中使用。' } }));
    }
  }, true);
}
