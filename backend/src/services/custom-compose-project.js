import path from 'node:path';
import YAML from 'yaml';
import { getActiveHost, getActiveHostId, getDockerForHost, getHost, assertProjectHostUnchanged } from './docker-hosts.js';
import { addOperation, getSetting, registerCustomComposeProject, setProjectPreference } from '../lib/db.js';
import { configuredComposeProjectRoots, safeProjectMountPath } from './mount-plan.js';
import { composeProjectId } from './project-id.js';
import { withNewWorkspace, putArchiveFile, runWorkspaceComposeArgs } from './compose-workspace.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { invalidateScanCache } from './scanner.js';
import { validateYaml } from '../lib/files.js';

const COMPOSE_FILE = 'docker-compose.yml';
const ENV_MAX = 524288;
const COMPOSE_MAX = 1048576;

export function composeProjectCreateOptions(host = getActiveHost()) {
  return {
    hostId: host.id,
    hostName: host.name,
    supported: host.type !== 'tcp',
    reason: host.type === 'tcp' ? 'TCP Docker API 节点无法在宿主机创建 Compose 文件，请切换到本地或 SSH 节点。' : '',
    roots: host.type === 'tcp' ? [] : configuredComposeProjectRoots(),
  };
}

export function validateProjectName(value) {
  const projectName = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(projectName)) {
    throw Object.assign(new Error('项目名需以小写字母或数字开头，仅含小写字母、数字、_ 和 -，最多 40 字符'), { statusCode: 400 });
  }
  return projectName;
}

export function validateComposeInput(composeContent, envContent) {
  if (typeof composeContent !== 'string' || !composeContent.trim() || composeContent.length > COMPOSE_MAX) {
    throw Object.assign(new Error('Compose YAML 不能为空，且不能超过 1 MiB'), { statusCode: 400 });
  }
  validateYaml(composeContent);
  const document = YAML.parseDocument(composeContent, { maxAliasCount: 50 });
  if (document.errors.length) throw Object.assign(new Error('Compose YAML 格式无效：' + document.errors[0].message), { statusCode: 422 });
  const config = document.toJS();
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      !config.services || typeof config.services !== 'object' || Array.isArray(config.services) ||
      Object.keys(config.services).length === 0) {
    throw Object.assign(new Error('Compose 文件必须定义至少一个 services 服务'), { statusCode: 422 });
  }
  for (const [name, service] of Object.entries(config.services)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || !service || typeof service !== 'object' || Array.isArray(service)) {
      throw Object.assign(new Error('Compose 服务名称或配置格式无效：' + name), { statusCode: 422 });
    }
  }
  const env = envContent === undefined || envContent === null ? '' : envContent;
  if (typeof env !== 'string' || env.length > ENV_MAX || env.includes('\0')) {
    throw Object.assign(new Error('.env 内容无效或超过 512 KiB'), { statusCode: 400 });
  }
  return { config, envContent: env };
}

export function hasPullableImages(config) {
  return Object.values(config.services || {}).some((service) =>
    service && typeof service === 'object' && typeof service.image === 'string' && service.image.trim() &&
    !service.build && service.pull_policy !== 'never' && service.pull_policy !== 'build');
}

function safeOutputCallback(callback) {
  return typeof callback === 'function' ? callback : () => {};
}

/**
 * 创建一个自定义 Compose 项目。
 * 先将文件登记到项目列表，再校验、拉取镜像和启动；任何失败都保留目录与配置供用户修复。
 */
export async function createCustomComposeProject(input = {}, options = {}) {
  const dependencies = options.dependencies || {};
  const readActiveHostId = dependencies.getActiveHostId || getActiveHostId;
  const readHost = dependencies.getHost || getHost;
  const readDocker = dependencies.getDockerForHost || getDockerForHost;
  const assertHost = dependencies.assertProjectHostUnchanged || assertProjectHostUnchanged;
  const readSetting = dependencies.getSetting || getSetting;
  const makeProjectId = dependencies.composeProjectId || composeProjectId;
  const createWorkspace = dependencies.withNewWorkspace || withNewWorkspace;
  const writeArchiveFile = dependencies.putArchiveFile || putArchiveFile;
  const runComposeArgs = dependencies.runWorkspaceComposeArgs || runWorkspaceComposeArgs;
  const withLock = dependencies.withProjectOperationLock || withProjectOperationLock;
  const invalidate = dependencies.invalidateScanCache || invalidateScanCache;
  const registerProject = dependencies.registerCustomComposeProject || registerCustomComposeProject;
  const saveProjectPreference = dependencies.setProjectPreference || setProjectPreference;
  const recordOperation = dependencies.addOperation || addOperation;
  const allowedRoots = dependencies.configuredComposeProjectRoots || configuredComposeProjectRoots;
  const hostId = readActiveHostId();
  const host = readHost(hostId);
  if (!host) throw Object.assign(new Error('目标 Docker 节点不存在'), { statusCode: 404 });
  const expectedHostId = String(input.expectedHostId || '');
  if (!expectedHostId || expectedHostId !== hostId) {
    throw Object.assign(new Error('Docker 节点已变化，请重新读取节点并发起部署'), { statusCode: 409, code: 'HOST_CHANGED' });
  }
  if (host.type === 'tcp') {
    throw Object.assign(new Error('TCP Docker API 节点无法在宿主机创建 Compose 文件，请改用本地或 SSH 节点'), { statusCode: 409 });
  }

  const projectName = validateProjectName(input.projectName);
  const rootDir = safeProjectMountPath(String(input.rootDir || ''));
  if (!rootDir || !allowedRoots().includes(rootDir)) {
    throw Object.assign(new Error('项目根目录不在管理员允许列表中，请在部署配置中设置 COMPOSEOPS_PROJECT_ROOTS'), { statusCode: 403 });
  }
  const { config, envContent } = validateComposeInput(input.composeContent, input.envContent);
  const workingDir = path.posix.join(rootDir, projectName);
  const composeFile = path.posix.join(workingDir, COMPOSE_FILE);
  const projectId = makeProjectId(workingDir, projectName, hostId, readSetting('projects.legacy_host_id', 'local'));
  const identity = { hostId, activeHostAtScan: hostId };
  const project = {
    ...identity,
    id: projectId,
    projectName,
    owner: String(input.owner || 'Personal').trim().slice(0, 80) || 'Personal',
    creationRoot: rootDir,
    workingDir,
    composeFiles: [composeFile],
    composeFile,
    managed: true,
    mountEnabled: true,
    mounted: false,
    editable: true,
  };
  const onOutput = safeOutputCallback(options.onOutput);
  const onPhase = safeOutputCallback(options.onPhase);
  const onExec = safeOutputCallback(options.onExec);
  const signal = options.signal;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertHost(identity);
  };

  return withLock(projectId, async () => {
    assertCurrent();
    onPhase({ phase: 'checking', projectId, projectName, workingDir });
    const docker = readDocker(hostId);
    const containers = await docker.listContainers({ all: true });
    assertCurrent();
    const nameConflict = containers.find((container) => {
      const labels = container.Labels || {};
      return labels['com.docker.compose.project'] === projectName;
    });
    if (nameConflict) {
      throw Object.assign(new Error('当前 Docker 节点已经存在同名 Compose 项目，请使用其他项目名称'), { statusCode: 409 });
    }

    let directoryCreated = false;
    let filesCreated = false;
    let operationSuccess = false;
    const emitOutput = (type, text) => {
      const value = String(text || '');
      if (!value) return;
      onOutput(type, value.slice(-20000));
    };
    try {
      onPhase({ phase: 'preparing', projectId, projectName, workingDir });
      await createWorkspace(project, async (container) => {
        directoryCreated = true;
        assertCurrent();
        await writeArchiveFile(container, workingDir, COMPOSE_FILE, input.composeContent, { mode: 0o600, uid: 0, gid: 0 });
        registerProject({ projectId, hostId, projectName, workingDir, composeFile, owner: project.owner });
        saveProjectPreference(projectId, { managed: true, mountEnabled: true });
        await writeArchiveFile(container, workingDir, '.env', envContent, { mode: 0o600, uid: 0, gid: 0 });
        filesCreated = true;
      });

      invalidate();
      assertCurrent();
      onPhase({ phase: 'validating', projectId, projectName, workingDir });
      const validateCode = await runComposeArgs(project, ['config', '--quiet'], emitOutput, {
        onExec: (handle) => { onExec(handle); if (signal?.aborted) handle.kill?.('SIGTERM'); },
        timeoutMs: 120000,
      });
      if (validateCode !== 0) {
        return {
          ok: false, code: validateCode, projectId, projectName, workingDir,
          directoryCreated, filesCreated,
          message: 'Compose 配置校验失败；文件已保留，可在服务列表中打开配置修复。',
        };
      }

      assertCurrent();
      if (hasPullableImages(config)) {
        onPhase({ phase: 'pulling', projectId, projectName, workingDir });
        const pullCode = await runComposeArgs(project, ['pull', '--ignore-buildable'], emitOutput, {
          onExec: (handle) => { onExec(handle); if (signal?.aborted) handle.kill?.('SIGTERM'); },
          timeoutMs: 15 * 60 * 1000,
        });
        if (pullCode !== 0) {
          return {
            ok: false, code: pullCode, projectId, projectName, workingDir,
            directoryCreated, filesCreated,
            message: '镜像拉取失败；项目目录和配置已保留，可检查镜像地址、凭据或网络后重试。',
          };
        }
      }

      assertCurrent();
      onPhase({ phase: 'starting', projectId, projectName, workingDir });
      const code = await runComposeArgs(project, ['up', '-d', '--build'], emitOutput, {
        onExec: (handle) => { onExec(handle); if (signal?.aborted) handle.kill?.('SIGTERM'); },
        timeoutMs: 15 * 60 * 1000,
      });
      assertCurrent();
      operationSuccess = code === 0;
      return {
        ok: operationSuccess,
        code,
        projectId,
        projectName,
        workingDir,
        directoryCreated,
        filesCreated,
        message: operationSuccess
          ? '项目配置已保存，镜像拉取与 Compose 启动命令已完成；请继续检查容器健康状态。'
          : 'Compose 启动失败；项目目录和配置已保留，可在服务列表中打开配置修复。',
      };
    } catch (error) {
      error.directoryCreated ||= directoryCreated;
      error.projectId = projectId;
      error.projectName = projectName;
      error.workingDir = workingDir;
      error.filesCreated = filesCreated;
      throw error;
    } finally {
      invalidate();
      recordOperation({
        projectId,
        projectName,
        action: 'compose.create',
        status: operationSuccess ? 'success' : 'failed',
        detail: workingDir,
      });
    }
  });
}

export default createCustomComposeProject;
