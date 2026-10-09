import path from 'node:path';

const BROAD_PATHS = new Set([
  '/', '/home', '/root', '/opt', '/srv', '/var', '/data', '/mnt', '/media', '/Users',
]);

function normalizedAbsolutePath(value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) return null;
  if (!path.posix.isAbsolute(value)) return null;
  return path.posix.normalize(value);
}

export function safeProjectMountPath(value) {
  const candidate = normalizedAbsolutePath(value);
  if (!candidate || BROAD_PATHS.has(candidate)) return null;
  const parts = candidate.split('/').filter(Boolean);
  if ((parts[0] === 'home' || parts[0] === 'Users') && parts.length < 3) return null;
  return candidate;
}

function containsPath(parent, child) {
  return child === parent || child.startsWith(`${parent}/`);
}

/** 检查宿主目录是否为项目根目录下的真实词法子路径，防止 ../ 与同名前缀逃逸。 */
export function isWithinProjectPath(projectRoot, candidate) {
  const root = safeProjectMountPath(projectRoot);
  if (!root || typeof candidate !== 'string' || !candidate || /[\0\r\n]/.test(candidate) || !path.posix.isAbsolute(candidate)) return false;
  const normalized = path.posix.normalize(candidate);
  return normalized !== root && normalized.startsWith(`${root}/`);
}

/**
 * 精确目录去重：如果一个待挂载项目本身已经是另一个项目的父目录，只保留父目录。
 * 不会为了减少条目而擅自扩大到 /home、/srv 等公共根目录。
 */
export function compactMountPaths(values) {
  const paths = [...new Set(values.map(normalizedAbsolutePath).filter(Boolean))]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return paths.filter((candidate, index) =>
    !paths.slice(0, index).some((selected) => containsPath(selected, candidate))
  );
}

function isSafeParentSuggestion(parent) {
  if (!parent || BROAD_PATHS.has(parent)) return false;
  const parts = parent.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  // /home/<user> 与 /Users/<user> 通常是整个个人目录，不自动建议扩大权限。
  if ((parts[0] === 'home' || parts[0] === 'Users') && parts.length < 3) return false;
  return true;
}

function projectMountPath(project) {
  return safeProjectMountPath(project.workingDir);
}

function yamlString(value) {
  return JSON.stringify(value);
}

function renderComposeSnippet(mountPaths) {
  if (!mountPaths.length) return '';
  const entries = mountPaths.flatMap((mountPath) => [
    '      - type: bind',
    `        source: ${yamlString(mountPath)}`,
    `        target: ${yamlString(mountPath)}`,
  ]);
  return [
    'services:',
    '  opsdash:',
    '    volumes:',
    '      # 保留已有的 Docker Socket 与数据卷，并加入以下目录：',
    ...entries,
  ].join('\n');
}

function buildParentSuggestions(mountPaths, projectsByPath) {
  const groups = new Map();
  for (const mountPath of mountPaths) {
    const parent = path.posix.dirname(mountPath);
    if (!isSafeParentSuggestion(parent)) continue;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(mountPath);
  }
  return [...groups.entries()]
    .filter(([, children]) => children.length > 1)
    .map(([parent, children]) => ({
      path: parent,
      replaces: children,
      projectIds: [...new Set(children.flatMap((child) => projectsByPath.get(child) || []))],
      warning: '父目录方案会让 ComposeOps 访问该目录下的其他文件，请确认权限范围后再使用。',
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 根据 Docker Compose 标签扫描结果生成只读挂载规划。
 * 这里只生成建议，不会修改宿主机文件，也不会创建高权限辅助容器。
 */
export function buildMountPlan(projects) {
  const discoveredProjects = projects.map((project) => ({
    id: project.id,
    projectName: project.projectName,
    owner: project.owner,
    workingDir: project.workingDir || '',
    composeFiles: project.composeFiles || [],
    managed: !!project.managed,
    mountEnabled: !!project.managed && project.mountEnabled !== false,
    mounted: !!project.mounted,
    editable: !!project.editable,
    mountState: project.mountState,
    containerCount: project.containers?.length || 0,
  }));
  const pendingProjects = [];
  const unsupportedProjects = [];
  const projectsByPath = new Map();

  for (const project of projects) {
    if (!project.managed || project.mountEnabled === false || project.mounted) continue;
    const mountPath = projectMountPath(project);
    const item = {
      id: project.id,
      projectName: project.projectName,
      owner: project.owner,
      workingDir: project.workingDir || '',
      composeFiles: project.composeFiles || [],
      mountState: project.mountState || (mountPath ? 'directory_unreachable' : 'metadata_missing'),
      mountPath,
    };
    if (!mountPath) {
      unsupportedProjects.push(item);
      continue;
    }
    pendingProjects.push(item);
    if (!projectsByPath.has(mountPath)) projectsByPath.set(mountPath, []);
    projectsByPath.get(mountPath).push(project.id);
  }

  const mountPaths = compactMountPaths(pendingProjects.map((project) => project.mountPath));
  const mounts = mountPaths.map((mountPath) => ({
    path: mountPath,
    projectIds: pendingProjects
      .filter((project) => containsPath(mountPath, project.mountPath))
      .map((project) => project.id),
    shortSyntax: `${mountPath}:${mountPath}`,
  }));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: projects.length,
      managed: projects.filter((project) => project.managed).length,
      operable: projects.filter((project) => project.editable).length,
      unmanaged: projects.filter((project) => !project.managed).length,
      pending: pendingProjects.length,
      unsupported: unsupportedProjects.length,
    },
    projects: discoveredProjects,
    pendingProjects,
    unsupportedProjects,
    mounts,
    parentSuggestions: buildParentSuggestions(mountPaths, projectsByPath),
    composeSnippet: renderComposeSnippet(mountPaths),
    recreateCommand: 'docker compose up -d --force-recreate opsdash',
  };
}
