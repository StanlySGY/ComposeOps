import { readFile } from 'fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { getSetting, setSetting, addOperation, setProjectPreference } from '../lib/db.js';
import { getDockerForHost, getHost, getActiveHostId, assertProjectHostUnchanged } from './docker-hosts.js';
import { withNewWorkspace, putArchiveFile, runWorkspaceComposeArgs } from './compose-workspace.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { invalidateScanCache } from './scanner.js';
import YAML from 'yaml';
import { validateYaml } from '../lib/files.js';
import { composeProjectId } from './project-id.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLUEPRINTS_PATH = path.join(__dirname, '../data/blueprints.json');

let blueprintsCache = null;
let blueprintsPromise = null;

export function listBlueprints() {
  if (blueprintsCache) return blueprintsCache;
  if (!blueprintsPromise) {
    blueprintsPromise = readFile(BLUEPRINTS_PATH, 'utf8')
      .then((content) => { blueprintsCache = JSON.parse(content); return blueprintsCache; })
      .catch((error) => { blueprintsPromise = null; throw error; });
  }
  return blueprintsPromise;
}

export async function getBlueprint(id) {
  const list = await listBlueprints();
  return list.find((item) => item.id === id) || null;
}



function fieldValue(field, values) {
  return String(values[field.key] ?? field.default ?? '');
}

/** 只替换 YAML 字符串节点，用户值永远不成为 YAML 结构或二次模板。 */
export function renderBlueprintCompose(blueprint, values = {}) {
  const replacements = new Map((blueprint.envSchema || []).map(field => [field.key, fieldValue(field, values)]));
  const document = YAML.parseDocument(blueprint.defaultCompose);
  if (document.errors.length) throw Object.assign(new Error('应用模板 YAML 无效'), { statusCode: 422 });
  YAML.visit(document, { Scalar(_key, node) {
    if (typeof node.value === 'string') {
      node.value = node.value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) =>
        replacements.has(key) ? replacements.get(key).replaceAll('$', () => '$$') : match);
    }
  } });
  return document.toString({ lineWidth: 0 });
}

/** Compose .env 双引号编码；转义反斜杠/控制字符，并阻止美元插值。 */
export function renderBlueprintEnv(blueprint, values = {}) {
  return (blueprint.envSchema || []).map(field => {
    const value = fieldValue(field, values);
    if (!value && field.secret) return `# ${field.key}=(请填写)`;
    const encoded = /^[A-Za-z0-9_./:@,+-]*$/.test(value)
      ? value : JSON.stringify(value.replaceAll('$', () => '$$'));
    return `${field.key}=${encoded}`;
  }).join('\n');
}

function validateBlueprintValues(blueprint, values) {
  const requestedPorts = new Set();
  for (const field of blueprint.envSchema || []) {
    const raw = values[field.key] ?? field.default ?? '';
    if (!['string', 'number', 'boolean'].includes(typeof raw)) {
      throw Object.assign(new Error(`${field.label || field.key} 必须为文本或数值`), { statusCode: 400 });
    }
    const value = String(raw);
    const hasUnsupportedControl = [...value].some(character => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    });
    if (value.length > 8192 || hasUnsupportedControl) {
      throw Object.assign(new Error(`${field.key} 过长或含不支持的控制字符`), { statusCode: 400 });
    }
    if ((field.secret || field.type === 'password' || field.required) && !value.trim()) {
      throw Object.assign(new Error(`请填写 ${field.label || field.key}（${field.key}）`), { statusCode: 400 });
    }
    if (field.type === 'port' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) {
      throw Object.assign(new Error(`${field.label || field.key} 必须是 1–65535 的端口号`), { statusCode: 400 });
    }
    if (field.type === 'port') {
      if (requestedPorts.has(Number(value))) throw Object.assign(new Error(`多个端口字段重复使用 ${value}，请分别选择端口`), { statusCode: 400 });
      requestedPorts.add(Number(value));
    }
  }
}

/** 仅检查 Docker 已发布的端口；宿主进程占用仍以 Compose 实际结果为准。 */
export async function checkPortConflicts(blueprint, values = {}, { dockerClient = null, containers = null } = {}) {
  const docker = dockerClient || getDockerForHost(getActiveHostId());
  const listed = containers || await docker.listContainers({ all: false });
  const used = new Set(listed.flatMap(container => (container.Ports || []).map(port => Number(port.PublicPort)).filter(Boolean)));
  return (blueprint.envSchema || []).filter(field => field.type === 'port')
    .map(field => ({ key: field.key, port: Number(fieldValue(field, values)) }))
    .filter(field => used.has(field.port));
}

/** 已知秘密按值脱敏，并暂存可能横跨 stdout/stderr 分片的秘密前缀。 */
function deploymentOutput(blueprint, values, onOutput) {
  const secrets = (blueprint.envSchema || []).filter(field => field.secret || field.type === 'password')
    .map(field => fieldValue(field, values)).filter(Boolean).sort((a, b) => b.length - a.length);
  const pending = new Map();
  const redact = text => secrets.reduce((value, secret) => value.split(secret).join('[REDACTED]'), String(text));
  return {
    redact,
    write(type, text) {
      const clean = redact((pending.get(type) || '') + text);
      let held = 0;
      for (const secret of secrets) {
        for (let length = Math.min(secret.length - 1, clean.length); length > held; length--) {
          if (clean.endsWith(secret.slice(0, length))) { held = length; break; }
        }
      }
      pending.set(type, held ? clean.slice(-held) : '');
      const visible = held ? clean.slice(0, -held) : clean;
      if (visible) onOutput(type, visible);
    },
    flush() {
      for (const [type, text] of pending) if (text) onOutput(type, '[REDACTED]');
      pending.clear();
    },
  };
}

/** 创建独立工作区并启动；失败保留已写配置，绝不覆盖或删除已有项目。 */
export async function deployBlueprint(blueprintId, values = {}, options = {}) {
  const hostId = getActiveHostId();
  const host = getHost(hostId);
  if (!host) throw Object.assign(new Error('目标节点不存在'), { statusCode: 409 });
  const {
    onOutput = () => {}, onChild = () => {}, onPhase = () => {}, signal,
    hostType = host.type, dockerClient = null,
    workspaceRunner = withNewWorkspace, composeRunner = runWorkspaceComposeArgs,
  } = options;
  const identity = { hostId, activeHostAtScan: options.expectedHostId || hostId };
  const assertCurrent = () => { signal?.throwIfAborted(); assertProjectHostUnchanged(identity); };
  assertCurrent();
  const blueprint = await getBlueprint(blueprintId);
  if (!blueprint) throw Object.assign(new Error('蓝图不存在'), { statusCode: 404 });
  const projectName = String(values.projectName || blueprint.id);
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(projectName)) {
    throw Object.assign(new Error('项目名需以小写字母或数字开头，仅含小写字母、数字、_ 和 -，最多 40 字符'), { statusCode: 400 });
  }
  if (hostType === 'tcp') {
    throw Object.assign(new Error('TCP Docker API 节点无法验证宿主 Compose 文件路径,蓝图部署请切换到本地或 SSH 节点'), { statusCode: 409 });
  }
  const resolvedValues = { ...values, CONTAINER_NAME: projectName };
  validateBlueprintValues(blueprint, resolvedValues);
  const compose = renderBlueprintCompose(blueprint, resolvedValues);
  const envContent = renderBlueprintEnv(blueprint, resolvedValues);
  validateYaml(compose);
  const root = path.posix.join('/projects', projectName);
  const projectId = composeProjectId(root, projectName, hostId, getSetting('projects.legacy_host_id', 'local'));
  const project = {
    ...identity, id: projectId, projectName, workingDir: root,
    composeFiles: [path.posix.join(root, 'docker-compose.yml')],
    managed: true, mountEnabled: true, mounted: false, editable: true,
  };
  const context = { projectId, projectName, hostId, hostName: host.name, workingDir: root, blueprint: blueprint.name, writeMode: 'workspace' };
  const output = deploymentOutput(blueprint, resolvedValues, onOutput);
  onPhase({ phase: 'queued', ...context });
  return withProjectOperationLock(projectId, async () => {
    assertCurrent();
    onPhase({ phase: 'checking', ...context });
    const docker = dockerClient || getDockerForHost(hostId);
    const containers = await docker.listContainers({ all: true });
    assertCurrent();
    if (containers.some(container => {
      const labels = container.Labels || {};
      return labels['com.docker.compose.project.working_dir'] === root || labels['com.docker.compose.project'] === projectName;
    })) throw Object.assign(new Error('同名项目已经部署，请在服务页查看原项目'), { statusCode: 409 });
    const conflicts = await checkPortConflicts(blueprint, resolvedValues, { dockerClient: docker, containers });
    if (conflicts.length) throw Object.assign(new Error(`端口已被 Docker 容器占用：${conflicts.map(item => `${item.key}=${item.port}`).join('、')}`), { statusCode: 409, conflicts });
    assertCurrent();
    let filesCreated = false;
    let directoryCreated = false;
    let code;
    let message = '';
    try {
      onPhase({ phase: 'preparing', ...context });
      await workspaceRunner(project, async container => {
        directoryCreated = true;
        assertCurrent();
        // Compose 可能内联秘密，与 .env 同为仅拥有者可读。
        await putArchiveFile(container, root, 'docker-compose.yml', compose, { mode: 0o600, uid: 0, gid: 0 });
        assertCurrent();
        await putArchiveFile(container, root, '.env', envContent, { mode: 0o600, uid: 0, gid: 0 });
        filesCreated = true;
      });
      setProjectPreference(projectId, { managed: true, mountEnabled: true });
      assertCurrent();
      onPhase({ phase: 'starting', ...context, filesCreated });
      code = await composeRunner(project, ['up', '-d'], (type, text) => output.write(type, text), {
        onExec: handle => { onChild(handle); if (signal?.aborted) handle.kill?.('SIGTERM'); },
      });
      signal?.throwIfAborted();
      if (code !== 0) message = `Compose 启动失败（退出码 ${code}），配置保留在 ${root}`;
      else setSetting(`blueprint.${hostId}.${projectName}.deployed`, String(Date.now()));
    } catch (error) {
      directoryCreated ||= !!error.directoryCreated;
      if (!directoryCreated) throw error;
      message = output.redact(error.message);
      output.write('stderr', `${message}\n`);
      code = 1;
    } finally {
      output.flush();
      invalidateScanCache();
    }
    const ok = code === 0;
    addOperation({ projectId, projectName, action: 'blueprint.deploy', status: ok ? 'success' : 'failed', detail: blueprint.name });
    return { ...context, ok, code, filesCreated, directoryCreated, message, status: ok ? 'started' : 'failed' };
  });
}
