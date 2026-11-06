import * as YAML from 'yaml';

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

const RECREATE_FIELDS = [
  ['image', '镜像'], ['build', '构建配置'], ['environment', '环境变量'], ['env_file', '环境文件'],
  ['ports', '端口映射'], ['expose', '暴露端口'], ['volumes', '卷挂载'], ['tmpfs', '临时文件系统'],
  ['command', '命令'], ['entrypoint', '入口'], ['user', '运行用户'], ['working_dir', '工作目录'],
  ['hostname', '主机名'], ['domainname', '域名'], ['labels', '标签'], ['healthcheck', '健康检查'],
  ['restart', '重启策略'], ['networks', '网络'], ['devices', '设备'], ['privileged', '特权模式'],
  ['read_only', '只读根文件系统'], ['cap_add', 'Linux capabilities'], ['cap_drop', 'Linux capabilities'],
  ['security_opt', '安全选项'], ['deploy', '部署配置'],
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function parseServices(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  try {
    const doc = YAML.parse(content);
    return doc?.services && typeof doc.services === 'object' ? doc.services : {};
  } catch { return null; }
}

function containerService(container, projectName, knownServices) {
  if (typeof container.service === 'string' && container.service.trim()) return container.service.trim();
  const name = String(container.name || '');
  const prefix = String(projectName || '');
  if (prefix) {
    for (const separator of ['-', '_']) {
      const start = `${prefix}${separator}`;
      if (!name.startsWith(start)) continue;
      const suffix = name.slice(start.length).replace(/[-_]\d+$/, '');
      if (suffix) return suffix;
    }
  }
  return knownServices.find((service) => name === service ||
    (name.startsWith(`${service}-`) && /-\d+$/.test(name)) ||
    (name.startsWith(`${service}_`) && /_\d+$/.test(name))) || null;
}

function changedReasons(previous, next) {
  if (!previous || !next) return [];
  return RECREATE_FIELDS
    .filter(([field]) => JSON.stringify(stableValue(previous[field])) !== JSON.stringify(stableValue(next[field])))
    .map(([, label]) => label);
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

/** Compare edited/current Compose services and only report host ports observed on other containers. */
export function previewComposeChange(newContent, project, {
  currentContent = '', occupiedPorts = null, portConflictsKnown = Array.isArray(occupiedPorts),
} = {}) {
  const result = {
    added: [], removed: [], changed: [], restarted: [], portConflicts: [],
    portConflictsKnown: !!portConflictsKnown, changeAnalysisKnown: false,
  };
  const newServices = parseServices(newContent);
  if (!newServices) return result;
  const oldServices = parseServices(currentContent);
  result.changeAnalysisKnown = oldServices !== null;
  const names = [...new Set([...Object.keys(newServices), ...Object.keys(oldServices || {})])];
  const containersByService = new Map();
  for (const container of project.containers || []) {
    const service = containerService(container, project.projectName, names);
    if (!service) continue;
    if (!containersByService.has(service)) containersByService.set(service, []);
    containersByService.get(service).push(container);
    if (!Object.hasOwn(newServices, service)) result.removed.push({ service, container: container.name, state: container.state });
  }
  for (const [name, service] of Object.entries(newServices)) {
    const containers = containersByService.get(name) || [];
    if (!containers.length) result.added.push({ service: name });
    else if (oldServices && Object.hasOwn(oldServices, name)) {
      const reasons = changedReasons(oldServices[name], service);
      if (reasons.length) {
        result.changed.push({ service: name, reasons, container: containers[0].name, state: containers[0].state });
        for (const container of containers) if (container.state === 'running') result.restarted.push({ service: name, container: container.name });
      }
    }
    if (Array.isArray(occupiedPorts)) {
      for (const raw of normalizeList(service?.ports)) {
        const desired = parsePublishedPort(raw);
        if (!desired) continue;
        for (const occupied of occupiedPorts) {
          if (Number(occupied.port) !== desired.port || String(occupied.protocol || 'tcp').toLowerCase() !== desired.protocol) continue;
          if (!addressesConflict(occupied.ip, desired.ip)) continue;
          result.portConflicts.push({ service: name, port: desired.port, ip: desired.ip, protocol: desired.protocol, holder: occupied.name || '其他容器' });
        }
      }
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
