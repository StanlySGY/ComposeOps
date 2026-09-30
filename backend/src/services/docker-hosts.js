import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { getSetting, setSetting } from '../lib/db.js';
import localDocker from './docker.js';

const SETTINGS_KEY = 'docker.hosts';
const ACTIVE_KEY = 'docker.active_host';
const DEFAULT_HOSTS = [{
  id: 'local',
  name: 'Local Daemon',
  type: 'local',
  host: '',
  port: null,
  username: '',
  tls: {},
  status: 'online',
  latencyMs: 0,
  version: '',
  containerCount: 0,
  builtin: true,
  updatedAt: null,
}];

const MASK = '••••••••••••';
const clientCache = new Map(); // hostId -> { docker, created }
const activeHostListeners = new Set();

/** 活动节点或其连接配置变化时,让长连接立即迁移。 */
export function onActiveHostChange(listener) {
  activeHostListeners.add(listener);
  return () => activeHostListeners.delete(listener);
}

function notifyActiveHostChange() {
  for (const listener of activeHostListeners) {
    try { listener(); } catch (error) { console.error('[docker-hosts] 节点切换回调失败:', error.message); }
  }
}

function readHosts() {
  try {
    const raw = getSetting(SETTINGS_KEY, null);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHosts(hosts) {
  setSetting(SETTINGS_KEY, JSON.stringify(hosts));
}

export function listHosts() {
  const hosts = [...DEFAULT_HOSTS, ...readHosts().map((item) => sanitizeHost(item))];
  const activeId = getActiveHostId();
  return hosts.map((host) => ({ ...host, active: host.id === activeId }));
}

export function listHostsInternal() {
  return [...DEFAULT_HOSTS, ...readHosts()];
}

function sanitizeHost(host) {
  const copy = { ...host, tls: { ...(host.tls || {}) } };
  if (copy.password) {
    copy.hasPassword = true;
    copy.password = MASK;
  }
  if (copy.privateKey) {
    copy.hasPrivateKey = true;
    copy.privateKey = MASK;
  }
  if (copy.tls?.ca) copy.tls.ca = MASK;
  if (copy.tls?.cert) copy.tls.cert = MASK;
  if (copy.tls?.key) copy.tls.key = MASK;
  return copy;
}

export function getHost(id) {
  if (id === 'local') return DEFAULT_HOSTS[0];
  return readHosts().find((host) => host.id === id) || null;
}

export function getActiveHostId() {
  return getSetting(ACTIVE_KEY, 'local') || 'local';
}

export function getActiveHost() {
  return getHost(getActiveHostId()) || getHost('local');
}

export function setActiveHost(id) {
  if (id !== 'local' && !readHosts().some((host) => host.id === id)) {
    throw Object.assign(new Error('Docker 节点不存在'), { statusCode: 404 });
  }
  const previous = getActiveHostId();
  setSetting(ACTIVE_KEY, id);
  if (previous !== id) notifyActiveHostChange();
  return { ok: true, activeHostId: id };
}

/** 校验并保存节点(新建或更新)。密码/私钥字段传 MASK 时保留旧值。 */
export function upsertHost(input = {}) {
  const { id, name, type, host, port, username } = input;
  if (!name || !String(name).trim()) throw Object.assign(new Error('节点名称不能为空'), { statusCode: 400 });
  const normalizedType = type === 'ssh' ? 'ssh' : type === 'tcp' ? 'tcp' : 'local';
  if (normalizedType !== 'local') {
    if (!host || !String(host).trim()) throw Object.assign(new Error('远程节点必须填写主机地址'), { statusCode: 400 });
  }
  const hosts = readHosts();
  let existing = id ? hosts.find((item) => item.id === id) : null;
  const entry = {
    id: existing?.id || input.id || randomUUID().slice(0, 12),
    name: String(name).trim(),
    type: normalizedType,
    host: normalizedType === 'local' ? '' : String(host).trim(),
    port: port ? Number(port) : (normalizedType === 'ssh' ? 22 : 2375),
    username: String(username || 'root').trim(),
    password: keepSecret(existing, input.password),
    privateKey: keepPrivateKey(existing, input.privateKey),
    tls: normalizeTls(existing, input.tls),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (existing) Object.assign(existing, entry);
  else hosts.push(entry);
  writeHosts(hosts);
  invalidateClient(entry.id);
  if (getActiveHostId() === entry.id) notifyActiveHostChange();
  return sanitizeHost(entry);
}

function keepSecret(existing, value) {
  if (value === undefined) return existing?.password || '';
  if (typeof value === 'string' && value.startsWith('••••')) return existing?.password || '';
  return String(value || '');
}

function keepPrivateKey(existing, value) {
  if (value === undefined) return existing?.privateKey || '';
  if (typeof value === 'string' && value.startsWith('••••')) return existing?.privateKey || '';
  return String(value || '');
}

function normalizeTls(existing, tls = {}) {
  const prev = existing?.tls || {};
  const next = { ca: '', cert: '', key: '' };
  for (const field of ['ca', 'cert', 'key']) {
    const value = tls[field];
    if (value === undefined || (typeof value === 'string' && value.startsWith('••••'))) next[field] = prev[field] || '';
    else next[field] = String(value || '');
  }
  return next;
}

export function deleteHost(id) {
  if (id === 'local') throw Object.assign(new Error('本地节点不可删除'), { statusCode: 400 });
  const hosts = readHosts();
  const index = hosts.findIndex((host) => host.id === id);
  if (index < 0) throw Object.assign(new Error('Docker 节点不存在'), { statusCode: 404 });
  hosts.splice(index, 1);
  writeHosts(hosts);
  invalidateClient(id);
  if (getActiveHostId() === id) setActiveHost('local');
  return { ok: true };
}

/** 根据节点创建 dockerode 客户端(local 复用单例)。 */
export function createDockerClient(host) {
  if (!host) return localDocker;
  if (host.type === 'local' || host.id === 'local') return localDocker;
  if (host.type === 'ssh') {
    const sshOptions = {};
    if (host.privateKey) {
      sshOptions.privateKey = host.privateKey;
      if (host.password) sshOptions.passphrase = host.password;
    } else if (host.password) {
      sshOptions.password = host.password;
    }
    return new Docker({
      protocol: 'ssh',
      host: host.host,
      port: host.port || 22,
      username: host.username || 'root',
      sshOptions,
      readyTimeout: 10000,
    });
  }
  // tcp / https
  const tls = host.tls || {};
  const hasTls = !!(tls.ca || tls.cert || tls.key);
  return new Docker({
    host: host.host,
    port: host.port || 2375,
    protocol: hasTls ? 'https' : 'http',
    ...(hasTls ? { ca: tls.ca, cert: tls.cert, key: tls.key } : {}),
  });
}

/** 当前活动节点对应的 dockerode 实例(远程节点带 30s 缓存)。 */
export function getActivityDocker() {
  const host = getActiveHost();
  if (host.type === 'local') return localDocker;
  const cached = clientCache.get(host.id);
  if (cached && Date.now() - cached.created < 30_000) return cached.docker;
  const docker = createDockerClient(host);
  clientCache.set(host.id, { docker, created: Date.now() });
  return docker;
}

export function getDockerForHost(id) {
  return createDockerClient(getHost(id) || getActiveHost());
}

function invalidateClient(id) {
  clientCache.delete(id);
}

/** 供 compose CLI 子进程注入的节点环境变量。 */
export function composeEnv(host = getActiveHost()) {
  if (host.type === 'local') return {};
  if (host.type === 'ssh') {
    throw Object.assign(
      new Error('SSH Docker 节点不能通过面板本地 Compose CLI 执行,请使用远端 SSH runner'),
      { statusCode: 409, code: 'REMOTE_COMPOSE_RUNNER_REQUIRED' },
    );
  }
  if (host.type === 'tcp') {
    const tls = host.tls || {};
    const detail = tls.ca || tls.cert || tls.key
      ? 'TLS 证书未以临时文件安全传递给 Compose CLI'
      : 'TCP 节点仅提供 Docker API,面板进程没有远端 Compose 文件工作区';
    throw Object.assign(
      new Error(`${detail},请使用 SSH 节点或在本地挂载 Compose 项目目录`),
      { statusCode: 409, code: 'REMOTE_COMPOSE_RUNNER_REQUIRED' },
    );
  }
  return {};
}

/** 构造一个用于探测的临时节点(不落库)。 */
export function probeHost(input = {}) {
  const type = input.type === 'ssh' ? 'ssh' : 'tcp';
  const entry = {
    id: '_probe',
    name: String(input.name || 'probe'),
    type,
    host: String(input.host || '').trim(),
    port: input.port ? Number(input.port) : (type === 'ssh' ? 22 : 2375),
    username: String(input.username || 'root').trim(),
    password: String(input.password || ''),
    privateKey: String(input.privateKey || ''),
    tls: { ca: String(input.tls?.ca || ''), cert: String(input.tls?.cert || ''), key: String(input.tls?.key || '') },
  };
  if (type !== 'local' && !entry.host) throw Object.assign(new Error('远程节点必须填写主机地址'), { statusCode: 400 });
  return entry;
}

/** 连通性检测:ping + 版本 + 容器数 + 延迟。probe 传入时探测未保存的临时节点。 */
export async function pingHost(id, probe = null) {
  const host = probe ? probeHost(probe) : getHost(id);
  if (!host) throw Object.assign(new Error('Docker 节点不存在'), { statusCode: 404 });
  const started = Date.now();
  try {
    const docker = createDockerClient(host);
    await docker.ping();
    const version = await docker.version().catch(() => null);
    const containers = await docker.listContainers({ all: true }).catch(() => []);
    const latencyMs = Date.now() - started;
    host.status = 'online';
    host.latencyMs = latencyMs;
    host.version = version?.Version || '';
    host.containerCount = Array.isArray(containers) ? containers.length : 0;
    host.runningCount = Array.isArray(containers) ? containers.filter((item) => item.State === 'running').length : 0;
    host.lastPingAt = new Date().toISOString();
    if (host.id !== 'local') writeHosts(readHosts());
    return {
      ok: true,
      status: 'online',
      latencyMs,
      version: host.version,
      containerCount: host.containerCount,
      runningCount: host.runningCount,
      host: sanitizeHost(host),
    };
  } catch (error) {
    host.status = 'offline';
    host.error = error.message;
    host.latencyMs = Date.now() - started;
    return {
      ok: false,
      status: 'offline',
      latencyMs: host.latencyMs,
      containerCount: 0,
      runningCount: 0,
      message: error.message,
      host: sanitizeHost(host),
    };
  }
}

export function getActiveHostType() {
  return getActiveHost().type;
}
