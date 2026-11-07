import * as YAML from 'yaml';
import { isDeepStrictEqual } from 'node:util';

/**
 * Compose 语义校验(仅静态分析,不依赖宿主机文件系统):
 * - depends_on 引用的服务必须存在
 * - links 引用必须存在
 * - 容器/卷名唯一性
 * - 端口映射冲突(同一项目内 hostPort:containerPort 重复)
 * - 镜像字段缺失检查
 * 返回 [{ level: 'error'|'warn', message, service?, line? }]
 */
export function validateComposeSemantics(content) {
  const issues = [];
  if (typeof content !== 'string' || !content.trim()) return issues;
  let doc;
  try {
    doc = YAML.parse(content);
  } catch (error) {
    issues.push({ level: 'error', message: `YAML 解析失败:${error.message}` });
    return issues;
  }
  if (!doc || typeof doc !== 'object') {
    issues.push({ level: 'error', message: 'Compose 顶层必须是映射(services / volumes / networks)' });
    return issues;
  }
  const services = doc.services && typeof doc.services === 'object' ? doc.services : {};
  const serviceNames = new Set(Object.keys(services));

  const hostPorts = new Map(); // "host:container" -> serviceName
  for (const [name, service] of Object.entries(services)) {
    if (!service || typeof service !== 'object') {
      issues.push({ level: 'error', message: `服务 ${name} 不是合法的映射`, service: name });
      continue;
    }
    if (!service.image && !service.build) {
      issues.push({ level: 'warn', message: `服务 ${name} 未声明 image 或 build`, service: name });
    }
    if (service.image && typeof service.image !== 'string') {
      issues.push({ level: 'warn', message: `服务 ${name} 的 image 不是字符串`, service: name });
    }
    for (const dep of normalizeList(service.depends_on)) {
      if (!serviceNames.has(dep)) {
        issues.push({ level: 'error', message: `服务 ${name} 的 depends_on 引用了不存在的服务 ${dep}`, service: name });
      }
    }
    for (const link of normalizeList(service.links)) {
      const target = String(link).split(':')[0];
      if (!serviceNames.has(target)) {
        issues.push({ level: 'error', message: `服务 ${name} 的 links 引用了不存在的服务 ${target}`, service: name });
      }
    }
    const ports = normalizeList(service.ports);
    for (const raw of ports) {
      const entry = String(raw);
      if (/^\d+:\d+$/.test(entry)) {
        const key = entry;
        const prev = hostPorts.get(key);
        if (prev && prev !== name) {
          issues.push({ level: 'error', message: `端口映射 ${entry} 与 ${prev} 冲突`, service: name });
        } else {
          hostPorts.set(key, name);
        }
      } else if (/^\d+$/.test(entry)) {
        // 仅声明容器端口,不冲突
      }
    }
    if (Array.isArray(service.environment) || (service.environment && typeof service.environment === 'object')) {
      const seen = new Set();
      const items = Array.isArray(service.environment) ? service.environment : Object.keys(service.environment);
      for (const item of items) {
        const key = String(item).split('=')[0];
        if (seen.has(key)) issues.push({ level: 'warn', message: `服务 ${name} 的 environment 重复定义 ${key}`, service: name });
        seen.add(key);
      }
    }
  }

  if (doc.volumes && typeof doc.volumes === 'object') {
    for (const [name, def] of Object.entries(doc.volumes)) {
      if (def && typeof def === 'object' && def.driver_opts && Object.keys(def.driver_opts).length) {
        issues.push({ level: 'info', message: `卷 ${name} 使用了 driver_opts(可能在远程节点不可用)`, service: null });
      }
    }
  }
  return issues.slice(0, 50);
}

function normalizeList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.keys(value); // depends_on: { db: { condition } }
  return [value];
}

function parsePublishedPort(spec) {
  if (spec && typeof spec === 'object') {
    const published = Number(spec.published ?? spec.published_port);
    if (!Number.isInteger(published) || published < 1 || published > 65535) return null;
    return { port: published, ip: String(spec.host_ip || spec.hostIp || '0.0.0.0'), protocol: String(spec.protocol || 'tcp').toLowerCase() };
  }
  const parts = String(spec || '').split(':');
  if (parts.length < 2) return null;
  const published = Number(parts.at(-2));
  if (!Number.isInteger(published) || published < 1 || published > 65535) return null;
  const ip = parts.length > 2 ? parts.slice(0, -2).join(':').replace(/^\[|\]$/g, '') : '0.0.0.0';
  const target = parts.at(-1).split('/');
  return { port: published, ip: ip || '0.0.0.0', protocol: (target[1] || 'tcp').toLowerCase() };
}

function addressesConflict(left, right) {
  const wildcard = (value) => ['', '0.0.0.0', '::', '[::]'].includes(String(value || '').toLowerCase());
  return wildcard(left) || wildcard(right) || String(left).toLowerCase() === String(right).toLowerCase();
}

export function previewComposeChange(newContent, project, options = null) {
  const { currentContent: previousContent = null, occupiedPorts = null,
    portConflictsKnown = Array.isArray(occupiedPorts) } = typeof options === 'string'
      ? { currentContent: options } : (options || {});
  const result = { added: [], removed: [], changed: [], restarted: [], portConflicts: [], basis: previousContent === null ? 'runtime-summary' : 'saved-file', portConflictsKnown: !!portConflictsKnown, changeAnalysisKnown: previousContent !== null };
  const doc = YAML.parse(newContent);
  const before = previousContent === null ? null : YAML.parse(previousContent);
  const newServices = doc?.services || {};
  const containers = project.containers || [];
  const serviceName = (container) => {
    if (container.service) return container.service;
    for (const separator of ['-', '_']) {
      const prefix = `${project.projectName}${separator}`;
      if (project.projectName && container.name.startsWith(prefix)) {
        return container.name.slice(prefix.length).replace(/[-_]\d+$/, '');
      }
    }
    return /^[^-_]+[-_](.+)[-_]\d+$/.exec(container.name)?.[1] || container.name;
  };
  const currentServices = new Map(containers.map(container => [serviceName(container), container]));
  const oldServices = previousContent === null
    ? Object.fromEntries([...currentServices].map(([name, container]) => [name, { image: container.image }]))
    : (before?.services || {});
  const findContainer = (name) => containers.find(container => serviceName(container) === name
    || container.name === oldServices[name]?.container_name || container.name === newServices[name]?.container_name);
  const fieldLabels = { image: '镜像', environment: '环境变量', ports: '端口映射', volumes: '卷', command: '命令', entrypoint: '入口', build: '构建', networks: '网络', depends_on: '依赖', healthcheck: '健康检查', restart: '重启策略', deploy: '部署配置', labels: '标签', container_name: '容器名' };
  for (const name of Object.keys(oldServices)) {
    if (Object.hasOwn(newServices, name)) continue;
    const container = findContainer(name);
    result.removed.push({ service: name, container: container?.name || name, state: container?.state || 'unknown' });
  }
  for (const [name, service] of Object.entries(newServices)) {
    for (const raw of normalizeList(service?.ports)) {
      const desired = parsePublishedPort(raw);
      if (!desired) continue;
      for (const occupied of occupiedPorts || []) {
        if (Number(occupied.port) !== desired.port || String(occupied.protocol || 'tcp').toLowerCase() !== desired.protocol || !addressesConflict(occupied.ip, desired.ip)) continue;
        result.portConflicts.push({ service: name, port: desired.port, ip: desired.ip, protocol: desired.protocol, holder: occupied.name || '其他容器' });
      }
    }
    if (!Object.hasOwn(oldServices, name)) { result.added.push({ service: name }); continue; }
    const previous = oldServices[name] || {};
    const next = service || {};
    const keys = previousContent === null ? (typeof previous.image === 'string' ? ['image'] : []) : [...new Set([...Object.keys(previous), ...Object.keys(next)])];
    const reasons = keys.filter(key => !isDeepStrictEqual(previous[key], next[key])).map(key => fieldLabels[key] || key);
    if (!reasons.length) continue;
    const container = findContainer(name);
    result.changed.push({ service: name, reasons, container: container?.name || name, state: container?.state || 'unknown' });
    for (const instance of containers.filter(item => serviceName(item) === name || item.name === oldServices[name]?.container_name || item.name === newServices[name]?.container_name)) {
      if (instance.state === 'running') result.restarted.push({ service: name, container: instance.name });
    }
  }
  return result;
}

/** Collect external published ports; failure is represented as unknown, not as no conflict. */
export async function createComposeChangePreview(newContent, project, currentContent, docker) {
  let occupiedPorts = null;
  try {
    const containers = await docker.listContainers({ all: true });
    const ownIds = new Set((project.containers || []).map((item) => item.id).filter(Boolean));
    const projectName = String(project.projectName || '');
    const workingDir = String(project.workingDir || '');
    occupiedPorts = [];
    for (const container of containers) {
      if (ownIds.has(container.Id)) continue;
      const labels = container.Labels || {};
      if (projectName && labels['com.docker.compose.project'] === projectName &&
        (!workingDir || labels['com.docker.compose.project.working_dir'] === workingDir)) continue;
      for (const port of container.Ports || []) {
        if (port.PublicPort) occupiedPorts.push({
          port: Number(port.PublicPort), ip: port.IP || '0.0.0.0', protocol: String(port.Type || 'tcp').toLowerCase(),
          name: (container.Names?.[0] || '').replace(/^\//, '') || container.Id?.slice(0, 12) || '其他容器',
        });
      }
    }
  } catch { /* Keep null: port occupancy is unknown when Docker is unreachable. */ }
  return previewComposeChange(newContent, project, { currentContent, occupiedPorts, portConflictsKnown: Array.isArray(occupiedPorts) });
}
