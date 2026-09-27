import { readFile } from 'fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { setSetting, addOperation, setProjectPreference } from '../lib/db.js';
import { getActivityDocker, getActiveHostType } from './docker-hosts.js';
import { withRunner, putArchiveFile, runWorkspaceComposeArgs } from './compose-workspace.js';
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



/**
 * 用用户填写的 envSchema 值渲染 compose 模板。
 * 纯函数,便于单测。
 */
export function renderBlueprintCompose(blueprint, values = {}) {
  let compose = blueprint.defaultCompose;
  const schema = blueprint.envSchema || [];
  for (const field of schema) {
    const value = values[field.key] !== undefined ? String(values[field.key]) : field.default !== undefined ? String(field.default) : '';
    compose = compose.replaceAll(`\${${field.key}}`, value);
  }
  return compose;
}

/**
 * 渲染 .env 内容(仅保留用户填写的非空秘密 + 可选全部变量)。
 */
export function renderBlueprintEnv(blueprint, values = {}) {
  const schema = blueprint.envSchema || [];
  const lines = [];
  for (const field of schema) {
    const value = values[field.key] !== undefined ? String(values[field.key]) : field.default !== undefined ? String(field.default) : '';
    // 仅输出有值或可暴露的字段;无默认值的秘密留空提示
    if (value || !field.secret) {
      lines.push(`${field.key}=${value}`);
    } else {
      lines.push(`# ${field.key}=(请填写)`);
    }
  }
  return lines.join('\n');
}

/** 校验端口冲突(仅检查宿主已开放端口)。 */
export async function checkPortConflicts(blueprint, values = {}) {
  const docker = getActivityDocker();
  const containers = await docker.listContainers({ all: false }).catch(() => []);
  const used = new Set();
  for (const container of containers) {
    for (const port of container.Ports || []) {
      if (port.PublicPort) used.add(Number(port.PublicPort));
    }
  }
  const schema = blueprint.envSchema || [];
  const conflicts = [];
  for (const field of schema.filter((item) => item.type === 'port')) {
    const value = Number(values[field.key] ?? field.default);
    if (value && used.has(value) && values[field.key] !== undefined) {
      conflicts.push({ key: field.key, port: value });
    }
  }
  return conflicts;
}

function projectRoot(projectName) {
  // 默认部署到 /projects(可被宿主挂载或 workspace 使用);容器内常见路径为 /projects
  return path.posix.join('/projects', projectName);
}

/**
 * 部署蓝图:在项目目录创建 docker-compose.yml + .env,注册纳管并 up -d。
 * 返回 { projectId, projectName, workingDir, code }。
 */
export async function deployBlueprint(blueprintId, values = {}, options = {}) {
  const {
    onOutput = () => {},
    onChild = () => {},
    hostType = getActiveHostType(),
    dockerClient = null,
    workspaceRunner = withRunner,
    composeRunner = runWorkspaceComposeArgs,
  } = options;
  const blueprint = await getBlueprint(blueprintId);
  if (!blueprint) throw Object.assign(new Error('蓝图不存在'), { statusCode: 404 });
  const projectName = String(values.projectName || '').trim() || String(blueprint.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeName || safeName.length > 40) throw Object.assign(new Error('项目名称需为字母数字与 _-' ), { statusCode: 400 });

  const compose = renderBlueprintCompose(blueprint, { ...values, CONTAINER_NAME: safeName });
  const envContent = renderBlueprintEnv(blueprint, { ...values, CONTAINER_NAME: safeName });
  validateYaml(compose);

  if (hostType === 'tcp') {
    throw Object.assign(new Error('TCP Docker API 节点无法验证宿主 Compose 文件路径,蓝图部署请切换到本地或 SSH 节点'), { statusCode: 409 });
  }

  const root = projectRoot(safeName);
  const docker = dockerClient || getActivityDocker();
  const projectId = composeProjectId(root, safeName);
  // 检查目录是否已存在
  const existing = await docker.listContainers({ all: true }).then((cs) => cs.filter((c) => (c.Labels || {})['com.docker.compose.project.working_dir'] === root));
  if (existing.length) throw Object.assign(new Error('同名项目已经部署'), { statusCode: 409 });

  // 统一通过宿主可见的 workspace runner 写文件。面板容器内 mkdir 成功
  // 不能证明 Docker daemon 所在宿主机能看到同一路径。
  const writeMode = 'workspace';
  const mockProject = { id: projectId, composeFiles: [path.posix.join(root, 'docker-compose.yml')], workingDir: root, managed: true, mountEnabled: true };
  await workspaceRunner(mockProject, async (container) => {
    await putArchiveFile(container, root, 'docker-compose.yml', compose, { mode: 0o644, uid: 0, gid: 0 });
    await putArchiveFile(container, root, '.env', envContent, { mode: 0o600, uid: 0, gid: 0 });
  });

  // 注册纳管(供后续扫描器发现)
  setProjectPreference(projectId, { managed: true, mountEnabled: true });
  // 注册 compose 项目缓存标记(非容器标签,仅供扫描器经 DOCKER 标签识别;实际以容器标签为准)
  setSetting(`blueprint.${safeName}.deployed`, String(Date.now()));

  let code;
  try {
    const project = {
      id: projectId,
      projectName: safeName,
      workingDir: root,
      composeFiles: [path.posix.join(root, 'docker-compose.yml')],
      mounted: false,
      editable: true,
      managed: true,
      host: null,
    };
    code = await runUp(project, { onOutput, onChild, composeRunner });
  } catch (error) {
    code = 1;
    onOutput('stderr', `${error.message}\n`);
  }
  addOperation({ projectId, projectName: safeName, action: 'blueprint.deploy', status: code === 0 ? 'success' : 'failed', detail: blueprint.name });
  return { projectId, projectName: safeName, workingDir: root, blueprint: blueprint.name, code, writeMode };
}

async function runUp(project, { onOutput, onChild, composeRunner }) {
  return composeRunner(project, ['up', '-d'], onOutput, {
    onExec: (handle) => onChild(handle),
  });
}
