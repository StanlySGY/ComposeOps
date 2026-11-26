import db from '../lib/db.js';

const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function normalizeWebUiPath(value) {
  if (typeof value !== 'string' || value.length > 512) throw invalid('访问路径最多 512 字符');
  const path = value.trim();
  if (!path) return '';
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw invalid('访问路径编码无效'); }
  if (!path.startsWith('/') || !decoded.startsWith('/') || decoded.startsWith('//') || /[\\?#\s]/u.test(decoded) || [...decoded].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127) ||
      decoded.split('/').some(segment => segment === '.' || segment === '..')) {
    throw invalid('请输入以 / 开头的应用路径，例如 /web/，不能包含域名、查询参数或跳转路径');
  }
  const normalized = new URL(path, 'http://localhost').pathname;
  if (normalized.length > 512) throw invalid('编码后的访问路径最多 512 字符');
  return normalized;
}

export function readWebUiSettings(hostId, projectId) {
  const row = db.prepare('SELECT revision, entries_json FROM project_webui_settings WHERE host_id = ? AND project_id = ?').get(hostId, projectId);
  return { hostId, revision: row?.revision || 0, entries: row ? JSON.parse(row.entries_json) : [] };
}

export function saveWebUiSettings(hostId, projectId, revision, entries) {
  if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(entries) || entries.length > 100) throw invalid('访问入口格式无效，最多 100 项');
  const seen = new Set();
  const normalized = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['service', 'port', 'path'].includes(key)) ||
        typeof entry.service !== 'string' || !entry.service.trim() || entry.service.length > 128 ||
        !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw invalid('应用与端口格式无效');
    const service = entry.service.trim();
    const key = JSON.stringify([service, entry.port]);
    if (seen.has(key)) throw invalid('同一应用端口不能重复配置');
    seen.add(key);
    return { service, port: entry.port, path: normalizeWebUiPath(entry.path) };
  }).filter(entry => entry.path && entry.path !== '/');
  return db.transaction(() => {
    const current = readWebUiSettings(hostId, projectId);
    if (current.revision !== revision) throw invalid('访问入口已被其他页面修改，请重新读取后编辑', 409);
    const next = revision + 1;
    db.prepare(`INSERT INTO project_webui_settings(host_id, project_id, revision, entries_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(host_id, project_id) DO UPDATE SET revision = excluded.revision, entries_json = excluded.entries_json`)
      .run(hostId, projectId, next, JSON.stringify(normalized));
    return { ok: true, revision: next };
  })();
}

export function applyWebUiSettings(links, settings) {
  return links.map(entry => ({ ...entry, ports: entry.ports.map(port => {
    const path = settings.find(setting => setting.service === entry.serviceName && setting.port === port.port)?.path || '';
    if (!path) return { ...port, path: '' };
    const url = new URL(port.url); url.pathname = normalizeWebUiPath(path);
    return { ...port, url: url.href, path };
  }) }));
}
