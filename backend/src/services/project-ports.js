/**
 * WebUI 端口智能雷达:从项目容器端口映射中提取可直接访问的 Web 端口。
 * 纯函数,便于单测;运行时不依赖任何宿主命令。
 */

// 明确属于数据面、不作为 WebUI 的端口(聚类识别时优先排除)。
const DATA_PORTS = new Set([22, 3306, 5432, 6379, 27017, 11211, 9200, 9300, 1883, 25, 110, 143, 587, 993, 995]);

// WebUI 典型端口按优先级排序:80/443 最优先,依次 3000/8000/8080/9000 等。
const WEBUI_PORTS = [80, 443, 3000, 8080, 8000, 8888, 9000, 8081, 5000, 5173, 3001, 8096, 8123, 9090, 7474, 15672, 6080];

const MAX_PORT = 65535;

// 只允许明确表示 Web 监听端口的变量；不扫描任意 *_PORT，避免把数据库、代理或远端端口当成入口。
const HOST_WEB_PORT_KEYS = ['WEB_PORT', 'WEBUI_PORT', 'WEB_UI_PORT', 'HTTP_PORT', 'HTTPS_PORT'];

/** 主机网络优先使用 EXPOSE；没有 TCP 声明时，补充明确的 Web 端口配置。只返回端口元数据。 */
export function extractHostPorts(details = {}) {
  const declared = Object.keys(details.Config?.ExposedPorts || {}).flatMap(key => {
    const match = /^(\d+)\/(tcp|udp)$/.exec(key);
    const port = Number(match?.[1]);
    return match && port > 0 && port <= MAX_PORT ? [{ port, type: match[2] }] : [];
  });
  if (declared.some(port => port.type === 'tcp')) return declared;

  const values = new Map();
  for (const entry of details.Config?.Env || []) {
    if (typeof entry !== 'string') continue;
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator);
    if (separator > 0 && HOST_WEB_PORT_KEYS.includes(key)) values.set(key, entry.slice(separator + 1).trim());
  }
  const configured = new Map();
  for (const key of HOST_WEB_PORT_KEYS) {
    const value = values.get(key) || '';
    const port = Number(value);
    if (!/^\d{1,5}$/.test(value) || port < 1 || port > MAX_PORT) continue;
    configured.set(port, { port, type: 'tcp', source: 'environment', scheme: key === 'HTTPS_PORT' ? 'https' : 'http' });
  }
  return [...declared, ...configured.values()];
}

/** 过滤出 Web 候选端口,并整体判定容器是否像数据库。 */
export function classifyPorts(container = {}) {
  const published = container.networkMode === 'host'
    ? (container.hostPorts || []).filter(port => !port.purpose || port.purpose === 'web').map(({ port, type }) => ({ private: port, public: port, type }))
    : (container.ports || []);
  const ports = published.filter((port) => Number(port.public) > 0 && (!port.type || port.type === 'tcp'));
  const candidates = ports
    .filter((port) => !DATA_PORTS.has(Number(port.private || port.public)))
    .map((port) => Number(port.public));
  // 容器镜像名包含数据库关键字时,即使挂了管理端口也不暴露为 WebUI 直达。
  const image = String(container.image || '').toLowerCase();
  const isDatabase = /(postgres|mysql|mariadb|redis|mongo|clickhouse|couchdb|elasticsearch|influxdb|influx)/.test(image);
  return { candidates, isDatabase };
}

/** 保留全部候选端口，典型 Web 端口优先排列。 */
export function pickWebPorts(candidates = []) {
  const uniq = [...new Set(candidates.map((port) => Number(port)).filter((port) => port > 0))];
  if (!uniq.length) return [];
  return uniq.filter((port) => Number.isInteger(port) && port <= MAX_PORT).sort((a, b) => {
    const rank = (port) => WEBUI_PORTS.includes(port) ? WEBUI_PORTS.indexOf(port) : WEBUI_PORTS.length;
    return rank(a) - rank(b) || a - b;
  });
}

/**
 * 项目级 WebUI 端口汇总:遍历运行中容器,聚合所有 Web 候选端口。
 * 返回 [{ container, ports: [port...] }],按典型端口排序。
 */
export function scanProjectWebPorts(project = {}) {
  const containers = (project.containers || []).filter((container) => container.state === 'running');
  const results = [];
  for (const container of containers) {
    const { candidates, isDatabase } = classifyPorts(container);
    if (isDatabase) continue;
    const ports = pickWebPorts(candidates);
    if (!ports.length) continue;
    results.push({ containerId: container.id, containerName: container.name, serviceName: container.service || container.name, ports,
      source: container.networkMode === 'host' ? ((container.hostPorts || []).some(port => port.source === 'config-file' && port.purpose === 'web') ? 'host-config-file' : (container.hostPorts || []).some(port => port.source === 'environment') ? 'host-environment' : 'host-exposed') : 'published',
      httpsPorts: container.networkMode === 'host' ? (container.hostPorts || []).filter(port => port.port === 443 || port.scheme === 'https').map(port => port.port) : (container.ports || []).filter((port) => Number(port.private) === 443 && (!port.type || port.type === 'tcp')).map((port) => Number(port.public)) });
  }
  return results;
}

/**
 * 生成直达链接主机名:优先使用传入的 host(常为前端访问 Host),否则 localhost。
 * 仅保留 http/https 前缀,避免注入。
 */
export function buildWebUiLinks(hostHeader = '', entries = []) {
  let safeHost = 'localhost';
  try {
    const raw = String(hostHeader || '').trim();
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) safeHost = parsed.hostname;
  } catch { /* 无效 Host 使用本机兜底 */ }
  return entries.map((entry) => ({
    containerId: entry.containerId,
    containerName: entry.containerName,
    serviceName: entry.serviceName || entry.containerName,
    source: entry.source || 'published',
    ports: entry.ports.map((port) => ({ port, url: `${entry.httpsPorts?.includes(port) ? 'https' : 'http'}://${safeHost}:${port}` })),
  }));
}
