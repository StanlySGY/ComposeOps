import { access } from 'fs/promises';
import path from 'node:path';
import { getActiveHostType, getActivityDocker } from './docker-hosts.js';
import { getProjectMountEnabled, getProjectPreference } from '../lib/db.js';
import { safeProjectMountPath } from './mount-plan.js';
import { composeProjectId } from './project-id.js';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_WORKDIR_LABEL = 'com.docker.compose.project.working_dir';
const COMPOSE_CONFIG_LABEL = 'com.docker.compose.project.config_files';
const OWNER_LABEL = 'myops.owner';
const UNCATEGORIZED = 'Uncategorized';

/**
 * 判断宿主机路径在当前进程文件系统里是否可达（容器化下取决于是否 bind-mount）。
 * 只读检查（R_OK），不抛错；不可达返回 false。
 */
async function isReachable(p) {
  if (!p) return false;
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描全机 Compose 容器，按 myops.owner 标签分组。
 *
 * 判定标准：过滤包含 com.docker.compose.project 标签的容器。
 * 项目唯一标识：com.docker.compose.project.working_dir
 * Owner 来源：myops.owner 标签，缺失归类为 Uncategorized。
 *
 * 权限：所有项目先自动发现。本地已挂载或 SSH 节点上路径安全时 editable=true。
 * 仅有 Docker API 的 TCP 节点不能编辑远端 Compose 文件。未纳管项目不能操作。
 *
 * @returns {Promise<{owners: string[], groupedByOwner: Object}>}
 */
export async function scanAndGroupServices() {
  const projectList = await scanProjects();
  const groupedByOwner = {};
  const ownerSet = new Set();
  for (const project of projectList) {
    if (!groupedByOwner[project.owner]) groupedByOwner[project.owner] = [];
    groupedByOwner[project.owner].push(project);
    ownerSet.add(project.owner);
  }
  const owners = [...ownerSet].sort((a, b) => {
    if (a === UNCATEGORIZED) return 1;
    if (b === UNCATEGORIZED) return -1;
    return a.localeCompare(b);
  });
  return { owners, groupedByOwner };
}

function parseComposeFiles(raw, workingDir) {
  const files = String(raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  return files.length ? files : (workingDir ? [`${workingDir}/docker-compose.yml`] : []);
}

export async function scanProjects() {
  const activeDocker = getActivityDocker();
  const containers = await activeDocker.listContainers({ all: true });
  // 远程节点无法访问本机 compose 目录,标记为容器控制模式。
  const nodeType = getActiveHostType();

  // 按 compose project 分组（以 workingDir 为 key）
  const projects = new Map();

  for (const c of containers) {
    const labels = c.Labels || {};
    const projectName = labels[COMPOSE_PROJECT_LABEL];
    if (!projectName) continue; // 非 compose 容器，跳过

    const workingDir = labels[COMPOSE_WORKDIR_LABEL] || '';
    const composeFileRaw = labels[COMPOSE_CONFIG_LABEL] || '';
    const composeFiles = parseComposeFiles(composeFileRaw, workingDir);
    const owner = labels[OWNER_LABEL] || UNCATEGORIZED;
    const key = workingDir ? `${workingDir}\0${projectName}` : `${owner}/${projectName}`;

    if (!projects.has(key)) {
      projects.set(key, {
        id: composeProjectId(workingDir, projectName),
        projectName,
        owner,
        workingDir,
        composeFiles,
        composeFile: composeFiles[0] || '',
        containers: [],
      });
    }

    const project = projects.get(key);
    const started = Number(c.Created || 0) * 1000;
    const statusMatch = /\((\d+) days?\)/.exec(c.Status || '');
    const stopped = statusMatch ? Date.now() - Number(statusMatch[1]) * 86400000 : null;
    project.containers.push({
      id: c.Id,
      name: (c.Names[0] || '').replace(/^\//, ''),
      state: c.State,
      statusText: c.Status,
      image: c.Image,
      imageId: c.ImageID || '',
      created: c.Created,
      startedAt: started || null,
      stoppedAt: stopped,
      health: /\((healthy|unhealthy|starting)\)/.exec(c.Status || '')?.[1] || null,
      ports: (c.Ports || []).filter((port) => port.PublicPort).map((port) => ({
        private: port.PrivatePort,
        public: port.PublicPort,
        ip: port.IP,
        type: port.Type,
      })),
    });
  }

  // 计算每个 project 的状态：running | stopped | partial + 可达性检查
  for (const project of projects.values()) {
    const runningCount = project.containers.filter(c => c.state === 'running').length;
    if (runningCount === project.containers.length) {
      project.status = 'running';
    } else if (runningCount === 0) {
      project.status = 'stopped';
    } else {
      project.status = 'partial';
    }

    // 容器化下，workingDir 是宿主机路径；只有挂载进来的才可达 → 才能编辑/执行生命周期。
    // 同时返回细分状态，便于前端区分“目录未挂载”和“标签里的文件已经失效”。
    project.workingDirReachable = await isReachable(project.workingDir);
    const composeReachability = await Promise.all(project.composeFiles.map(async (file) => ({
      path: file,
      reachable: await isReachable(file),
    })));
    project.unreachableComposeFiles = composeReachability
      .filter((file) => !file.reachable)
      .map((file) => file.path);
    project.mounted = nodeType === 'local' && project.workingDirReachable && composeReachability.length > 0 &&
      composeReachability.every((file) => file.reachable);
    const preference = getProjectPreference(project.id);
    project.managed = !!preference.managed;
    project.mountEnabled = getProjectMountEnabled(project.id);
    // 本地未挂载目录走短生命周期 workspace 容器;SSH 节点直接在远端主机上读写,TCP 只有 Docker API。
    const sshHost = nodeType === 'ssh';
    const workspaceRoot = (nodeType === 'local' || sshHost) ? safeProjectMountPath(project.workingDir) : '';
    project.workspaceAvailable = !!workspaceRoot && project.composeFiles.length > 0 &&
      project.composeFiles.every((file) => {
        const normalized = path.posix.normalize(file);
        return path.posix.isAbsolute(normalized) && normalized.startsWith(`${workspaceRoot}/`);
      });
    if (project.mounted) project.mountState = 'ready';
    else if (!project.workingDir) project.mountState = 'metadata_missing';
    else if (nodeType === 'tcp') project.mountState = 'remote_api_only';
    else if (sshHost && project.workspaceAvailable) project.mountState = 'remote_ssh';
    else if (!project.workingDirReachable) project.mountState = 'directory_unreachable';
    else project.mountState = 'compose_files_unreachable';
    project.editable = project.managed && project.mountEnabled && (project.mounted || project.workspaceAvailable);
    project.composeMode = project.editable ? (project.mounted ? 'direct' : 'workspace') : 'containers';
    project.favorite = !!preference.favorite;
    project.note = preference.note || '';
  }
  return [...projects.values()].sort((a, b) =>
    Number(b.managed) - Number(a.managed) || Number(b.favorite) - Number(a.favorite) ||
    a.owner.localeCompare(b.owner) ||
    a.projectName.localeCompare(b.projectName)
  );
}

export async function findProject(id) {
  return (await scanProjects()).find((project) => project.id === id) || null;
}

export async function findProjectContainer(projectIdValue, containerId) {
  const project = await findProject(projectIdValue);
  if (!project) return { project: null, container: null };
  const container = project.containers.find((item) =>
    item.id === containerId || item.id.startsWith(containerId) || item.name === containerId
  ) || null;
  return { project, container };
}

/**
 * 扫描当前所有 compose 项目的 workingDir（宿主机路径集合）。
 * 供 compose 路由做 allowlist：只放行 Docker 自己上报的路径，不依赖配置。
 */
export { OWNER_LABEL, UNCATEGORIZED };
