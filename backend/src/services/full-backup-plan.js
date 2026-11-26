import path from 'node:path';
import { readFile, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const PROJECT = 'com.docker.compose.project';
const WORKDIR = 'com.docker.compose.project.working_dir';
const BROAD_PATHS = new Set(['/', '/etc', '/var', '/home', '/root', '/opt', '/srv', '/mnt', '/media', '/vol1', '/vol2']);
const normalize = (value) => typeof value === 'string' && value.startsWith('/') && !/[\0\r\n]/.test(value)
  ? path.posix.normalize(value) : '';
const isRuntimeSource = source => source.endsWith('.sock') || /^\/(proc|sys|dev|run)(\/|$)/.test(source) || source.startsWith('/var/run/');
const errorWithStatus = (message, statusCode) => Object.assign(new Error(message), { statusCode, code: 'FULL_BACKUP_PREFLIGHT' });

export function belongsToBackupProject(container, project) {
  const labels = container.Config?.Labels || container.Labels || {};
  return !!normalize(project.workingDir) && labels[PROJECT] === project.projectName &&
    normalize(labels[WORKDIR]) === normalize(project.workingDir);
}

/** 只生成清单；不创建 helper、不读取 env 内容、不停止容器、不生成备份。 */
export function buildFullBackupPlan({ project, host, containers, composeFiles = [], inspectFailures = [], otherContainers = [] }) {
  const root = normalize(project.workingDir);
  const blockers = [];
  const warnings = [];
  const resources = new Map();
  const services = new Set();
  const issue = (target, code, message) => target.push({ code, message });
  const add = (kind, source, detail = {}) => {
    const key = `${kind}:${source}`;
    if (!resources.has(key)) resources.set(key, { kind, source, containers: [], verification: 'pending', ...detail });
    return resources.get(key);
  };
  const configReference = (value, kind, owner) => {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || value.includes('$') || value.startsWith('~')) {
      issue(blockers, 'unresolved_file_reference', `${owner} 的文件引用未解析，需要核对最终 Compose 配置`);
      return;
    }
    const source = value.startsWith('/') ? normalize(value) : root ? path.posix.resolve(root, value) : '';
    if (!source) { issue(blockers, 'invalid_file_reference', `${owner} 的文件路径无法确定`); return; }
    if (kind === 'bind' && BROAD_PATHS.has(source)) issue(blockers, 'broad_bind_source', `挂载 ${source} 范围过宽，需要明确备份边界`);
    const runtime = kind === 'bind' && isRuntimeSource(source);
    const entry = add(runtime ? 'runtime_dependency' : kind, source, { owner, verification: runtime ? 'recreate-required' : 'pending-host-check' });
    entry.optional = false;
  };

  if (!root || BROAD_PATHS.has(root)) issue(blockers, 'unsafe_project_directory', '项目目录缺失或范围过宽，需要限定到具体应用目录');
  else add('project_directory', root, { verification: 'pending-host-check' });
  if (!containers.length) issue(blockers, 'containers_missing', '当前节点未找到匹配项目和目录的容器，请刷新项目清单');
  for (const failure of inspectFailures) issue(blockers, 'container_inspect_failed', `容器 ${failure} 无法读取，不能确认备份范围`);
  if (!composeFiles.length) issue(blockers, 'compose_files_missing', '缺少 Compose 文件路径，不能恢复原编排');

  for (const file of composeFiles) {
    const source = normalize(file.path);
    const entry = add('compose_file', source || '(路径缺失)', { verification: file.status || 'unavailable' });
    if (!source || file.status !== 'readable' || typeof file.content !== 'string') {
      issue(blockers, 'compose_unreadable', `Compose 文件 ${source || '(路径缺失)'} 未读取，请确认目录在面板中可访问`);
      continue;
    }
    entry.sha256 = createHash('sha256').update(file.content).digest('hex');
    let model;
    try { model = parse(file.content); } catch {
      issue(blockers, 'compose_invalid', `Compose 文件 ${source} 不是合法 YAML`);
      continue;
    }
    if (!model || typeof model !== 'object' || Array.isArray(model) || !model.services || typeof model.services !== 'object' || Array.isArray(model.services)) {
      issue(blockers, 'compose_invalid', `Compose 文件 ${source} 缺少有效的 services 定义`);
      continue;
    }
    if (model.include) issue(blockers, 'compose_include', 'Compose 使用 include，需要展开并纳入被引用文件');
    for (const [serviceName, service] of Object.entries(model.services)) {
      services.add(serviceName);
      if (!service || typeof service !== 'object') {
        issue(blockers, 'service_invalid', `服务 ${serviceName} 定义无效`);
        continue;
      }
      if (service.extends) issue(blockers, 'compose_extends', `服务 ${serviceName} 使用 extends，需要核对外部定义`);
      const envFiles = Array.isArray(service.env_file) ? service.env_file : service.env_file ? [service.env_file] : [];
      for (const env of envFiles) configReference(typeof env === 'object' ? env.path : env, 'env_file', serviceName);
      for (const mount of Array.isArray(service.volumes) ? service.volumes : []) {
        const source = typeof mount === 'string' ? mount.split(':')[0] : mount?.source;
        // 匿名卷短语法只有容器目标；实际卷名以 inspect 为准。
        if (typeof mount === 'string' && !mount.includes(':')) continue;
        if (!source) continue;
        if (typeof source !== 'string' || source.includes('$') || source.startsWith('~')) {
          issue(blockers, 'unresolved_mount', `服务 ${serviceName} 的挂载引用未解析`);
        } else if (mount?.type === 'bind' || source.startsWith('/') || source.startsWith('.')) {
          configReference(source, 'bind', serviceName);
        } else {
          add('volume_declaration', source, { owner: serviceName, verification: 'pending-model-resolution' });
        }
      }
      if (service.build) issue(warnings, 'build_sources', `服务 ${serviceName} 使用本地构建，需要纳入构建上下文和离线镜像`);
    }
    for (const kind of ['configs', 'secrets']) {
      for (const [name, definition] of Object.entries(model[kind] || {})) {
        if (definition?.file) configReference(definition.file, 'configuration_file', `${kind}.${name}`);
        else issue(blockers, 'external_configuration', `${kind}.${name} 来自外部或环境变量，需要单独保存和恢复`);
      }
    }
  }
  if (root) add('env_file', path.posix.join(root, '.env'), { verification: 'pending-host-check', optional: true });

  for (const container of containers) {
    if (!belongsToBackupProject(container, project)) {
      issue(blockers, 'container_identity_changed', '容器所属项目或目录已变化，需要重新扫描');
      continue;
    }
    const name = String(container.Name || container.Id || '').replace(/^\//, '');
    const labels = container.Config?.Labels || {};
    const service = labels['com.docker.compose.service'];
    if (service) services.delete(service);
    const imageId = container.Image;
    if (imageId) {
      const image = add('image', imageId, { reference: container.Config?.Image || '', verification: 'pending-export' });
      if (!image.containers.includes(name)) image.containers.push(name);
    } else issue(blockers, 'image_id_missing', `容器 ${name} 缺少实际镜像 ID`);
    if (container.State?.Running) issue(warnings, 'stop_required', `容器 ${name} 正在运行，完整备份需要停写或数据库一致性方案`);
    add('writable_layer', container.Id || name, { containers: [name], verification: 'pending-diff-check' });
    for (const envFile of String(labels['com.docker.compose.project.environment_file'] || '').split(',').filter(Boolean)) {
      configReference(envFile.trim(), 'env_file', 'Compose 启动环境');
    }
    for (const mount of container.Mounts || []) {
      let entry;
      if (mount.Type === 'bind') {
        const source = normalize(mount.Source);
        if (!source) { issue(blockers, 'invalid_bind_source', `容器 ${name} 的挂载源路径无效`); continue; }
        const runtime = isRuntimeSource(source);
        entry = add(runtime ? 'runtime_dependency' : 'bind', source, { verification: runtime ? 'recreate-required' : 'pending-host-check' });
        if (!runtime && BROAD_PATHS.has(source)) issue(blockers, 'broad_bind_source', `挂载 ${source} 范围过宽，需要明确备份边界`);
      } else if (mount.Type === 'volume' && mount.Name) {
        entry = add('volume', mount.Name, { driver: mount.Driver || '', verification: 'pending-volume-check' });
      } else if (mount.Type === 'tmpfs') {
        entry = add('runtime_dependency', `${name}:${mount.Destination}`, { verification: 'recreate-required' });
      } else {
        issue(blockers, 'unsupported_mount', `容器 ${name} 的 ${mount.Type || '未知'} 挂载尚未识别`);
        continue;
      }
      if (!entry.containers.includes(name)) entry.containers.push(name);
    }
  }
  for (const service of services) issue(warnings, 'service_not_deployed', `服务 ${service} 没有已识别容器，可能属于未启用的 profile，需要复核`);
  for (const container of otherContainers) {
    for (const mount of container.Mounts || []) {
      const source = mount.Type === 'volume' ? mount.Name : normalize(mount.Source);
      const shared = mount.Type === 'volume' ? resources.has(`volume:${source}`) : mount.Type === 'bind' && source &&
        [...resources.values()].some(item => item.kind === 'bind' && (item.source === source || item.source.startsWith(`${source}/`) || source.startsWith(`${item.source}/`)));
      if (shared && mount.RW !== false) {
        issue(blockers, 'shared_mount_writer', `挂载 ${source} 还被项目外容器使用，需要协调停写`);
      }
    }
  }
  issue(warnings, 'model_not_resolved', '清单结合 Compose 声明与当前容器生成；最终变量、合并配置、profiles 及外部依赖仍需复核');
  const inventory = [...resources.values()].sort((a, b) => `${a.kind}:${a.source}`.localeCompare(`${b.kind}:${b.source}`));
  const plan = {
    schemaVersion: 1, mode: 'preview-only', executionAvailable: false, coverageVerified: false,
    host: { id: host.id, name: host.name, type: host.type },
    project: { id: project.id, name: project.projectName, directory: root },
    resources: inventory,
    blockers: [...new Map(blockers.map(item => [item.code + item.message, item])).values()],
    warnings: [...new Map(warnings.map(item => [item.code + item.message, item])).values()],
    nextSteps: ['核实全部挂载源的存在性、类型和权限', '制定停写、加密和镜像导出方案', '备份后在隔离环境执行应用与数据库恢复验收'],
  };
  return { ...plan, fingerprint: createHash('sha256').update(JSON.stringify(plan)).digest('hex'), generatedAt: new Date().toISOString() };
}

export async function previewFullBackup(projectId, dependencies = {}) {
  const { getActiveHost, getDockerForHost } = await import('./docker-hosts.js');
  const { findProject } = await import('./scanner.js');
  const activeHost = dependencies.getActiveHost || getActiveHost;
  const host = activeHost();
  const project = await (dependencies.findProject || findProject)(projectId);
  if (activeHost().id !== host.id) throw errorWithStatus('节点已切换，请重新生成清单', 409);
  if (!project) throw errorWithStatus('项目不存在或当前不可见', 404);
  if (!project.managed) throw errorWithStatus('项目尚未加入管理', 403);
  const docker = (dependencies.getDockerForHost || getDockerForHost)(host.id);
  const all = await docker.listContainers({ all: true });
  const mine = all.filter(container => belongsToBackupProject(container, project));
  const containers = [];
  const inspectFailures = [];
  // 逐项读取，避免大量并发 inspect 压垮 NAS 的 Docker API。
  for (const container of mine) {
    try { containers.push(await docker.getContainer(container.Id).inspect()); }
    catch { inspectFailures.push(container.Id); }
  }
  const composeFiles = [];
  for (const file of project.composeFiles || []) {
    const source = normalize(file);
    if (host.type !== 'local' || !project.mounted || !project.mountEnabled || !source || !normalize(project.workingDir) || BROAD_PATHS.has(normalize(project.workingDir)) ||
      !source.startsWith(`${normalize(project.workingDir).replace(/\/$/, '')}/`)) {
      composeFiles.push({ path: file, status: 'unavailable' });
      continue;
    }
    try {
      const [realRoot, realSource] = await Promise.all([realpath(project.workingDir), realpath(source)]);
      if (!realSource.startsWith(`${realRoot.replace(/\/$/, '')}/`)) throw new Error('compose symlink escapes project');
      const info = await stat(source);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('invalid compose file');
      const content = await (dependencies.readFile || readFile)(source, 'utf8');
      composeFiles.push({ path: source, status: 'readable', content });
    } catch { composeFiles.push({ path: source, status: 'unavailable' }); }
  }
  if (activeHost().id !== host.id) throw errorWithStatus('节点已切换，请重新生成清单', 409);
  return buildFullBackupPlan({ project, host, containers, composeFiles, inspectFailures,
    otherContainers: all.filter(container => !belongsToBackupProject(container, project)) });
}
