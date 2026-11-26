import db, { addOperation } from '../lib/db.js';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { getActiveHost, getHost, getDockerForHost } from './docker-hosts.js';
import { scanProjects } from './scanner.js';
import {
  withRunner,
  execInRunner,
  readArchiveFile,
  closeIdleProjectRunners,
} from './compose-workspace.js';
import { parse as parseYaml } from 'yaml';
import {
  isProjectOperationLocked,
} from './project-operation-lock.js';
import { collectDockerOutput } from '../lib/docker-streams.js';
import { catalog, mutateCatalog, recoveryKey, keyPath, seal, unseal } from './maintenance-store.js';
import { validBackupPath, within, containerIdentity as identity } from './maintenance-worker.js';
import { imageCheckSettings } from './image-registry.js';

const plans = new Map();
const active = new Set();
let refreshPromise;
export const fault = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const group = (c) => {
  const l = c.Config.Labels || {};
  return l['com.docker.compose.project'] && l['com.docker.compose.project.working_dir']
    ? l['com.docker.compose.project'] + '\0' + l['com.docker.compose.project.working_dir']
    : c.Id;
};
const name = (c) => c.Name?.replace(/^\//, '') || c.Id;
const runtime = (source) => source === '/var/run/docker.sock';
async function composeModel(project, raw = false) {
  return withRunner(project, async (container) => {
    if (raw)
      for (const file of project.composeFiles) {
        const original = parseYaml((await readArchiveFile(container, file)).content);
        if (original.include || Object.values(original.services || {}).some((s) => s?.extends))
          throw fault('include / extends 的原始配置引用需要专门展开，当前阻止完整备份');
      }
    const result = await execInRunner(
      container,
      [
        'docker',
        'compose',
        '--project-name',
        project.projectName,
        ...project.composeFiles.flatMap((file) => ['-f', file]),
        ...(project.environmentFiles || []).flatMap((file) => ['--env-file', file]),
        'config',
        ...(raw ? ['--no-interpolate', '--no-env-resolution'] : []),
        '--format',
        'json',
      ],
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) throw fault('最终 Compose 配置无法读取');
    return JSON.parse(result.stdout);
  });
}

async function localRuntime(hostId) {
  const host = hostId ? getHost(hostId) : getActiveHost();
  if (host.type !== 'local') throw fault('完整备份执行首版仅支持本机 Docker 节点；远程节点不能冒用本机路径');
  const docker = getDockerForHost(host.id);
  const info = await docker.info();
  if (info.OSType !== 'linux') throw fault('完整备份执行需要 Linux Docker 宿主');
  let self;
  try {
    self = await docker.getContainer(process.env.HOSTNAME || '').inspect();
  } catch {
    /* 本机开发可显式指定 runner 镜像 */
  }
  const image = process.env.COMPOSEOPS_RUNNER_IMAGE || self?.Image;
  if (process.platform !== 'linux' || (!self && existsSync('/.dockerenv')))
    throw fault('无法确认本机 Linux 宿主与面板身份，禁止执行完整备份');
  if (!image) throw fault('无法识别备份执行器镜像，请在容器中运行面板或配置 COMPOSEOPS_RUNNER_IMAGE');
  return { host, docker, self, image, dockerRoot: info.DockerRootDir, engineId: info.ID };
}
function rootMounts(config) {
  return [
    {
      Type: 'bind',
      Source: '/',
      Target: '/host',
      ReadOnly: true,
      BindOptions: { ReadOnlyForceRecursive: true },
    },
    { Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock' },
    ...config.sources
      .filter((s) => s.kind === 'volume')
      .map((s) => ({
        Type: 'volume',
        Source: s.source,
        Target: '/volumes/' + s.index,
        ReadOnly: true,
        VolumeOptions: { NoCopy: true },
      })),
  ];
}
async function launch(runtimeInfo, config, task = false) {
  const { docker, image, host } = runtimeInfo;
  const mounts =
    ['sync', 'restore'].includes(config.mode)
      ? [{ Type: 'bind', Source: config.backupPath, Target: '/backup', ReadOnly: true }]
      : rootMounts(config);
  if (!['sync', 'restore'].includes(config.mode))
    mounts.push({ Type: 'bind', Source: config.backupPath, Target: '/backup', ReadOnly: false });
  if (config.mode === 'restore') {
    mounts.push({ Type: 'bind', Source: config.destination, Target: '/restore' });
    mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock' });
  }
  const container = await docker.createContainer({
    Image: image,
    Cmd: ['node', 'src/services/maintenance-worker.js'],
    WorkingDir: '/app/backend',
    Labels: {
      'composeops.helper': 'maintenance',
      'composeops.maintenance': config.id || 'probe',
      'composeops.host': host.id,
    },
    NetworkDisabled: config.mode !== 'sync',
    HostConfig: {
      Mounts: mounts,
      ReadonlyRootfs: true,
      Tmpfs: { '/run/composeops': 'rw,noexec,nosuid,size=32m' },
      RestartPolicy: { Name: 'no' },
      SecurityOpt: ['no-new-privileges:true'],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '2m', 'max-file': '1' } },
    },
  });
  try {
    await container.start();
    // Docker putArchive 拒绝 readonly rootfs，即使目标是 tmpfs；通过 exec stdin 写入临时内存文件。
    const setup = await container.exec({
      Cmd: [
        'node',
        '-e',
        "const fs=require('fs');let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{JSON.parse(data);fs.writeFileSync('/run/composeops/config.json',data,{mode:0o600});fs.writeFileSync('/run/composeops/ready','ready',{mode:0o600});});",
      ],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const setupStream = await setup.start({ hijack: true, stdin: true });
    const setupDone = collectDockerOutput(setupStream);
    setupStream.end(JSON.stringify(config));
    await setupDone;
    if ((await setup.inspect()).ExitCode !== 0) throw fault('无法将运行配置传入备份执行器');
    if (task) return container.id;
    const result = await container.wait();
    const events = decode(await collectDockerOutput(await container.logs({ stdout: true, stderr: true })));
    const last = events.at(-1);
    if (result.StatusCode !== 0 || last?.status !== 'success')
      throw fault(
        last?.message || '备份执行器未返回有效结果；请检查镜像、路径权限与宿主内核递归只读挂载支持',
      );
    return last.result;
  } finally {
    if (!task) await container.remove({ force: true, v: false }).catch(() => {});
  }
}
function decode(output) {
  return output
    .split('\n')
    .filter((l) => l.startsWith('COMPOSEOPS_RESULT:'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l.slice(18))];
      } catch {
        return [];
      }
    });
}

export function backupSettings() {
  const host = getActiveHost();
  return {
    hostId: host.id,
    backupPath: catalog().settings[host.id] || '',
    keyAvailable: true,
    keyLocation: keyPath,
  };
}
export async function saveBackupSettings(backupPath) {
  if (!validBackupPath(backupPath)) throw fault('请输入具体的宿主机绝对目录，不能使用根目录或上级跳转', 400);
  const r = await localRuntime();
  if (r.dockerRoot && (within(r.dockerRoot, backupPath) || within(backupPath, r.dockerRoot)))
    throw fault('备份目录不能位于 Docker 内部数据目录或其父目录');
  const probe = await launch(r, { mode: 'probe', sources: [], backupPath });
  if (getActiveHost().id !== r.host.id) throw fault('节点已切换，请重新保存');
  mutateCatalog((s) => {
    s.settings[r.host.id] = backupPath;
  });
  return { ...backupSettings(), freeBytes: probe.freeBytes };
}
export async function maintenanceOverview() {
  const host = getActiveHost(),
    docker = getDockerForHost(host.id);
  const containers = await docker.listContainers({ all: true });
  const projects = await scanProjects();
  const state = await refreshTasks();
  if (getActiveHost().id !== host.id) throw fault('节点已切换，请刷新');
  return {
    hostId: host.id,
    settings: backupSettings(),
    imageCheck: imageCheckSettings(),
    containers: containers.map((c) => {
      const project = projects.find(
        (p) =>
          p.projectName === c.Labels?.['com.docker.compose.project'] &&
          p.workingDir === c.Labels?.['com.docker.compose.project.working_dir'],
      );
      return {
        id: c.Id,
        name: c.Names?.[0]?.replace(/^\//, '') || c.Id,
        image: c.Image,
        state: c.State,
        projectName: c.Labels?.['com.docker.compose.project'] || '',
        managed: !!project?.managed,
        helper: !!c.Labels?.['composeops.helper'],
        self:
          host.type === 'local' &&
          !!process.env.HOSTNAME &&
          (c.Id === process.env.HOSTNAME || c.Id.startsWith(process.env.HOSTNAME)),
        service: c.Labels?.['com.docker.compose.service'] || '',
        projectId: project?.id || null,
        updateCheckAvailable: !!project?.editable,
        updateCheckReason: !project
          ? '没有可读取的 Compose 定义'
          : !project.managed
            ? '应用不存在或当前不可见'
            : !project.mountEnabled
              ? '当前节点或项目路径不支持 Compose 目录访问'
              : !project.editable
                ? '当前节点无法读取 Compose 配置'
                : '',
      };
    }),
    tasks: state.tasks.filter((t) => t.hostId === host.id).slice(0, 100),
    backups: state.backups.filter((b) => b.hostId === host.id),
  };
}
// 纯范围判定：同 Compose 应用自动扩展；不把临时辅助容器或面板自身宣称为可完整备份。
export function inventoryForBackup(
  all,
  ids,
  { selfId = '', backupPath = '', projects = [], action = 'backup' } = {},
) {
  const requested = all.filter((c) => ids.includes(c.Id));
  const groups = new Set(requested.map(group));
  const selected = action === 'update' ? all.filter((c) => groups.has(group(c))) : requested;
  const members = all.filter((c) => groups.has(group(c)));
  const blockers = [],
    warnings = [],
    declared = [],
    runtimeDependencies = [];
  if (requested.length !== new Set(ids).size) blockers.push('部分所选容器已不存在，请刷新');
  const add = (kind, source) => {
    if (!declared.some((s) => s.kind === kind && s.source === source)) declared.push({ kind, source });
  };
  for (const c of members) {
    if (c.Id === selfId) blockers.push('面板自身需要外部执行器，当前不能在本面板内完成自身停机备份');
    if (c.Config.Labels?.['composeops.helper'] || c.Config.Labels?.['com.docker.swarm.service.id'])
      blockers.push(name(c) + ' 是辅助容器或 Swarm 服务，需要先明确重建方式');
    if (c.State.Paused || c.State.Restarting || c.State.Dead || c.HostConfig.AutoRemove)
      blockers.push(name(c) + ' 当前状态或自动删除设置不允许受控停机备份');
    if (c.HostConfig.Tmpfs && Object.keys(c.HostConfig.Tmpfs).length)
      blockers.push(name(c) + ' 有 tmpfs 应用数据，停机前需要专门导出适配');
    if (c.HostConfig.Devices?.length || c.HostConfig.DeviceRequests?.length)
      warnings.push(name(c) + ' 恢复时需要原设备或 GPU 运行环境');
    const labels = c.Config.Labels || {},
      directory = labels['com.docker.compose.project.working_dir'];
    if (directory) {
      const project = projects.find(
        (p) => p.projectName === labels['com.docker.compose.project'] && p.workingDir === directory,
      );
      if (!project?.managed || !project.mountEnabled)
        blockers.push(name(c) + ' 所属应用或 Compose 目录不可用');
      add('project', directory);
    }
    for (const m of c.Mounts || []) {
      if (m.Type === 'bind' && runtime(m.Source)) {
        runtimeDependencies.push({
          containerId: c.Id,
          source: m.Source,
          destination: m.Destination,
          requires: 'Docker socket on restored host',
        });
        continue;
      }
      if (m.Type === 'bind') add('bind', m.Source);
      else if (m.Type === 'volume' && m.Name) add('volume', m.Name);
      else blockers.push(name(c) + ' 存在暂不支持的挂载 ' + m.Type);
    }
  }
  for (const s of declared.filter((s) => s.kind !== 'volume')) {
    if (!validBackupPath(s.source) || /^\/(proc|sys|dev|run)(\/|$)/.test(s.source))
      blockers.push('备份源路径过宽或属于运行时文件系统：' + s.source);
    if (within(s.source, backupPath) || within(backupPath, s.source))
      blockers.push('备份保存目录不能与备份源重叠：' + s.source);
  }
  for (const c of all.filter((c) => !members.some((m) => m.Id === c.Id)))
    for (const m of c.Mounts || []) {
      if (m.RW === false) continue;
      if (
        declared.some((s) =>
          s.kind === 'volume'
            ? m.Type === 'volume' && m.Name === s.source
            : m.Type === 'bind' && (within(s.source, m.Source) || within(m.Source, s.source)),
        )
      )
        blockers.push('备份数据还被应用外容器使用：' + name(c) + '；需一并选择并协调停写');
    }
  // 祖先目录归档覆盖子路径；保留 declared 清单用于恢复映射。
  const sources = declared
    .filter(
      (s) =>
        s.kind === 'volume' ||
        !declared.some((p) => p.kind !== 'volume' && p.source !== s.source && within(p.source, s.source)),
    )
    .filter(
      (s, i, a) =>
        a.findIndex((v) =>
          v.kind === 'volume' && s.kind === 'volume'
            ? v.source === s.source
            : v.kind !== 'volume' && s.kind !== 'volume' && v.source === s.source,
        ) === i,
    )
    .map((s, index) => ({ ...s, index }));
  return {
    updateScope: action === 'update' ? 'compose' : null,
    members,
    selected,
    sources,
    declared,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    runtimeDependencies,
  };
}
export async function inspectBackupInventory(docker, rows) {
  const inspected = [];
  for (const row of rows) {
    try {
      inspected.push(await docker.getContainer(row.Id).inspect());
    } catch (error) {
      // 空闲辅助容器可在 Docker 列表与 inspect 之间被自动回收。
      // 业务容器消失仍要求重新预检，不能缩减用户选择的备份范围。
      if (error.statusCode === 404 && row.Labels?.['composeops.helper']) continue;
      if (error.statusCode === 404) throw fault('容器清单正在变化，请刷新后重新预检');
      throw error;
    }
  }
  return inspected;
}

export async function prepareMaintenance(input) {
  if (input.action && input.action !== 'backup') throw fault('应用更新请使用发布评审流程', 400);
  const r = await localRuntime();
  const { host, docker, self } = r;
  if (!r.engineId) throw fault('无法确认 Docker Engine 身份');
  const backupPath = input.backupPath || catalog().settings[host.id];
  if (!validBackupPath(backupPath)) throw fault('请先配置已存在的备份保存目录', 400);
  if (r.dockerRoot && (within(r.dockerRoot, backupPath) || within(backupPath, r.dockerRoot)))
    throw fault('备份目录不能位于 Docker 内部数据目录或其父目录');
  const projects = await scanProjects();
  const before = await docker.listContainers({ all: true });
  const selectedProjects = projects.filter((p) => before.some((c) =>
    input.containerIds.includes(c.Id) &&
    c.Labels?.['com.docker.compose.project'] === p.projectName &&
    c.Labels?.['com.docker.compose.project.working_dir'] === p.workingDir,
  ));
  await closeIdleProjectRunners(selectedProjects.map((p) => p.id), { waitMs: 35_000 });
  const raw = await docker.listContainers({ all: true, size: true });
  const all = await inspectBackupInventory(docker, raw);
  const plan = inventoryForBackup(all, input.containerIds, {
    selfId: self?.Id,
    backupPath,
    projects,
    action: input.action,
  });
  if (
    input.action === 'update' &&
    plan.selected.some((c) => !c.Config.Labels?.['com.docker.compose.service'])
  )
    plan.blockers.push('独立容器更新尚无可靠的 Compose 重建定义；请先纳入 Compose 管理');
  const models = [],
    networks = [],
    volumes = [];
  for (const foundProject of projects.filter((p) =>
    plan.members.some((c) => group(c) === p.projectName + '\0' + p.workingDir),
  )) {
    const p = {
      ...foundProject,
      environmentFiles: [
        ...new Set(
          plan.members
            .filter((c) => group(c) === foundProject.projectName + '\0' + foundProject.workingDir)
            .flatMap((c) =>
              String(c.Config.Labels['com.docker.compose.project.environment_file'] || '')
                .split(',')
                .map((f) => f.trim())
                .filter(Boolean),
            ),
        ),
      ],
    };
    try {
      const model = await composeModel(p),
        unresolved = await composeModel(p, true);
      const references = [];
      const addRef = (value) => {
        if (typeof value === 'string')
          references.push(value.startsWith('/') ? value : path.posix.resolve(p.workingDir, value));
      };
      for (const c of plan.members.filter((c) => group(c) === p.projectName + '\0' + p.workingDir))
        for (const file of String(c.Config.Labels['com.docker.compose.project.environment_file'] || '')
          .split(',')
          .filter(Boolean))
          addRef(file.trim());
      for (const service of Object.values(unresolved.services || {})) {
        for (const ref of service.env_file || []) addRef(typeof ref === 'string' ? ref : ref.path);
        for (const ref of service.label_file || []) addRef(ref);
        if (service.extends?.file) addRef(service.extends.file);
        const build = service.build;
        if (build?.additional_contexts && Object.keys(build.additional_contexts).length)
          plan.blockers.push(p.projectName + ' 使用 additional_contexts，需要展开构建依赖再备份');
        if (build?.context && !/^(https?:|git@|service:)/.test(build.context)) addRef(build.context);
      }
      for (const kind of ['secrets', 'configs'])
        for (const c of Object.values(unresolved[kind] || {})) if (c.file) addRef(c.file);
      for (const file of references) {
        if (file.includes('$') || !validBackupPath(file))
          plan.blockers.push('外部文件路径未解析或范围过宽：' + file);
        else if (!plan.declared.some((s) => s.kind !== 'volume' && s.source === file))
          plan.declared.push({ kind: 'configuration', source: file });
      }
      // 包含未部署服务/外部配置的模型不能只备份当前卷就宣称完整。
      for (const service of Object.keys(model.services || {}))
        if (
          !plan.members.some(
            (c) =>
              c.Config.Labels?.['com.docker.compose.service'] === service &&
              group(c) === p.projectName + '\0' + p.workingDir,
          )
        )
          plan.blockers.push(p.projectName + ' 的服务 ' + service + ' 未部署，无法覆盖其数据与镜像');
      for (const kind of ['secrets', 'configs'])
        for (const config of Object.values(model[kind] || {}))
          if (config.external || !config.file)
            plan.blockers.push(p.projectName + ' 含外部 ' + kind + '，需要先补齐可导出的配置文件');
      if (input.action === 'update')
        for (const c of plan.selected.filter((c) => group(c) === p.projectName + '\0' + p.workingDir)) {
          const service = c.Config.Labels['com.docker.compose.service'],
            definition = model.services[service];
          if (
            !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service) ||
            !definition?.image ||
            definition.build ||
            definition.image.includes('@') ||
            ['never', 'build'].includes(definition.pull_policy)
          )
            plan.blockers.push(
              p.projectName + '/' + service +
              ' 使用固定镜像、本地构建或禁止拉取策略；需先明确整个应用的更新方案，仍可完整备份',
            );
          if (
            plan.members.filter(
              (m) => group(m) === group(c) && m.Config.Labels['com.docker.compose.service'] === service,
            ).length !== 1
          )
            plan.blockers.push(service + ' 是多副本服务，需先确定逐副本更新方案');
        }
      models.push({
        id: p.id,
        name: p.projectName,
        directory: p.workingDir,
        composeFiles: p.composeFiles,
        environmentFiles: p.environmentFiles,
        model,
      });
    } catch {
      plan.blockers.push(p.projectName + ' 的最终 Compose 配置无法解析；不能确认变量、外部文件和依赖范围');
    }
  }
  await closeIdleProjectRunners(models.map((p) => p.id), { waitMs: 35_000 });
  plan.sources = plan.declared
    .filter(
      (s) =>
        s.kind === 'volume' ||
        !plan.declared.some(
          (p) => p.kind !== 'volume' && p.source !== s.source && within(p.source, s.source),
        ),
    )
    .filter(
      (s, i, a) =>
        a.findIndex((v) => (v.kind === 'volume') === (s.kind === 'volume') && v.source === s.source) === i,
    )
    .map((s, index) => ({ ...s, index }));
  for (const s of plan.sources.filter((s) => s.kind !== 'volume'))
    if (within(s.source, backupPath) || within(backupPath, s.source))
      plan.blockers.push('保存目录与配置源重叠：' + s.source);
  const hostKey = self
    ? self.Mounts?.filter((m) => m.Type === 'bind' && within(m.Destination, keyPath)).map((m) =>
        path.posix.join(m.Source, path.posix.relative(m.Destination, keyPath)),
      )
    : [keyPath];
  for (const s of plan.sources.filter((s) => s.kind !== 'volume')) {
    if (r.dockerRoot && (within(r.dockerRoot, s.source) || within(s.source, r.dockerRoot)))
      plan.blockers.push('请通过实际 Docker 卷备份应用数据，不能直接归档 Docker 内部数据目录');
    if (hostKey?.some((key) => within(s.source, key)))
      plan.blockers.push('备份源包含恢复密钥，不能将密钥打入备份');
    for (const c of all.filter((c) => !plan.members.some((m) => m.Id === c.Id)))
      for (const m of c.Mounts || [])
        if (m.Type === 'bind' && m.RW !== false && (within(s.source, m.Source) || within(m.Source, s.source)))
          plan.blockers.push('配置或构建资料还被其他容器使用：' + name(c));
  }
  plan.blockers = [...new Set(plan.blockers)];
  for (const c of plan.members) {
    for (const networkId of Object.values(c.NetworkSettings.Networks || {})
      .map((n) => n.NetworkID)
      .filter(Boolean))
      if (!networks.some((n) => n.Id === networkId))
        networks.push(await docker.getNetwork(networkId).inspect());
    for (const m of c.Mounts || [])
      if (m.Type === 'volume' && !volumes.some((v) => v.Name === m.Name)) {
        const v = await docker.getVolume(m.Name).inspect();
        volumes.push(v);
        if (v.Driver !== 'local' || Object.keys(v.Options || {}).length)
          plan.blockers.push('卷 ' + v.Name + ' 使用外部存储驱动或挂载选项，需先验证独立一致性');
      }
  }
  const configFiles = [
    ...new Set([
      ...models.flatMap((p) => [...p.composeFiles, path.posix.join(p.directory, '.env')]),
      ...plan.declared.filter((s) => s.kind === 'configuration').map((s) => s.source),
    ]),
  ];
  let scan = null,
    imageBytes = 0;
  for (const id of new Set(plan.members.map((c) => c.Image))) {
    const img = await docker.getImage(id).inspect();
    imageBytes += Number(img.Size) || 0;
  }
  const rootfsBytes = raw
    .filter((c) => plan.members.some((m) => m.Id === c.Id))
    .reduce((n, c) => n + (c.SizeRw || 0), 0);
  if (!plan.blockers.length) {
    try {
      scan = await launch(r, { mode: 'probe', sources: plan.sources, backupPath, configFiles });
      if (scan.freeBytes < (scan.bytes + imageBytes * 2 + rootfsBytes) * 1.15 + 256 * 1024 ** 2)
        plan.blockers.push('备份保存目录的可用空间不足');
    } catch (error) {
      plan.blockers.push(error.message);
    }
  }
  if (getActiveHost().id !== host.id) throw fault('节点已切换，请重新预检');
  const token = randomUUID(),
    expiresAt = Date.now() + 10 * 60_000;
  const config = {
    mode: 'backup',
    id: randomUUID(),
    hostId: host.id,
    engineId: r.engineId,
    backupPath,
    containers: plan.members,
    sources: plan.sources,
    declared: plan.declared,
    projects: models,
    networks,
    volumes,
    scan,
    configFiles,
    configDigests: scan?.configDigests,
    imageBytes,
    rootfsBytes,
    allIds: all.map((c) => c.Id),
    allSignatures: all
      .filter((c) => !c.Config.Labels?.['composeops.helper'])
      .map((c) => ({ id: c.Id, signature: hash(identity(c)) })),
    runtimeDependencies: plan.runtimeDependencies,
  };
  const publicPlan = {
    token,
    hostId: host.id,
    expiresAt,
    backupPath,
    action: input.action || 'backup',
    updateScope: plan.updateScope || null,
    selectionNote: plan.updateScope === 'compose'
      ? '更新会覆盖所选容器所属的整个 Compose 应用，并统一执行完整备份、拉取与重建'
      : '',
    backupFirst: true,
    selected: plan.selected.map((c) => ({ id: c.Id, name: name(c) })),
    members: plan.members.map((c) => ({ id: c.Id, name: name(c), running: c.State.Running })),
    sources: plan.declared,
    blockers: plan.blockers,
    warnings: [
      ...plan.warnings,
      '停机期间请确保没有宿主机进程或外部客户端继续写入备份数据',
      '恢复清单记录网络、设备和外部运行依赖；NAS 系统镜像不在应用备份范围内',
    ],
    freeBytes: scan?.freeBytes || 0,
    estimatedBytes: scan ? scan.bytes + imageBytes * 2 + rootfsBytes : 0,
    downtime: '数据归档和可写层导出期间需要停机；当前没有足够测量数据估算分钟数',
    coverageVerified: !plan.blockers.length,
  };
  for (const [id, p] of plans) if (p.expiresAt < Date.now()) plans.delete(id);
  if (plans.size >= 50) plans.delete(plans.keys().next().value);
  plans.set(token, {
    r,
    config,
    publicPlan,
    expiresAt,
    fingerprint: hash(plan.members.map(identity)),
    action: input.action || 'backup',
    selectedIds: plan.selected.map((c) => c.Id),
  });
  return publicPlan;
}

export function maintenanceExecutionMode(prepared, { confirmed, keySaved }) {
  if (prepared.publicPlan.blockers.length || !prepared.publicPlan.coverageVerified)
    throw fault('完整备份预检未通过，不能更新或备份');
  if (prepared.action !== 'backup') throw fault('应用更新请使用发布评审流程', 400);
  if (confirmed !== true || keySaved !== true)
    throw fault('尚未确认停机影响及恢复密钥已单独保存');
  return 'manual';
}

export async function executeMaintenance({ token, confirmed, keySaved, makeDefault = false }) {
  const prepared = plans.get(token);
  if (!prepared || prepared.expiresAt < Date.now()) throw fault('确认清单已过期，请重新预检');
  if (getActiveHost().id !== prepared.r.host.id) throw fault('节点已切换，请重新预检');
  const confirmationMode = maintenanceExecutionMode(prepared, { confirmed, keySaved }, backupSettings().backupPath);
  const hostId = prepared.r.host.id;
  if (active.has(hostId) || catalog().tasks.some((t) => t.hostId === hostId && t.status === 'running'))
    throw fault('当前节点已有运维任务，请等待完成或处理异常任务');
  active.add(hostId);
  plans.delete(token);
  try {
    const { config } = prepared;
    if (config.projects.some((p) => isProjectOperationLocked(p.id)))
      throw fault('所选应用正在执行其他操作，请稍后重新预检');
    const current = [];
    for (const c of config.containers) current.push(await prepared.r.docker.getContainer(c.Id).inspect());
    if (hash(current.map(identity)) !== prepared.fingerprint)
      throw fault('容器配置或启停状态已变化，请重新预检');
    // Recheck authorization after preview, before taking any persistent lock.
    const authorized = await scanProjects(hostId);
    if (config.projects.some(p => !authorized.some(current => current.id === p.id && current.managed && current.mountEnabled))) throw fault('项目授权已变化，请重新预检');
    const task = {
      id: config.id,
      hostId,
      engineId: prepared.r.engineId,
      originalIdentities: config.containers.map(c => ({ id: c.Id, signature: hash(identity({ ...c, State: { ...c.State, Running: false } })) })),
      workerId: null,
      status: 'running',
      action: prepared.action,
      confirmationMode,
      updateScope: prepared.publicPlan.updateScope,
      stage: '准备完整备份',
      createdAt: new Date().toISOString(),
      backupPath: config.backupPath,
      names: config.containers.map(name),
      selectedIds: prepared.selectedIds,
      selectedSignatures: config.containers
        .filter((c) => prepared.selectedIds.includes(c.Id))
        .map((c) => ({ id: c.Id, signature: hash(identity(c)) })),
      projectIds: config.projects.map((p) => p.id),
      lockIds: [...config.projects.map(p => p.id), ...config.containers.filter(c => !c.Config.Labels?.['com.docker.compose.project']).map(c => `standalone:${hostId}:${c.Id}`)],
      modelHashes: config.projects.map((p) => ({
        id: p.id,
        hash: hash(p.model),
        environmentFiles: p.environmentFiles,
      })),
      originallyRunning: config.containers.filter((c) => c.State.Running).map((c) => c.Id),
    };
    db.transaction(() => {
      for (const projectId of task.lockIds) {
        if (isProjectOperationLocked(projectId)) throw fault('所选项目有正在执行的操作');
        db.prepare('INSERT INTO maintenance_project_locks(project_id, task_id, host_id) VALUES (?, ?, ?)').run(projectId, task.id, hostId);
      }
      // 将任务先落盘再提交锁，崩溃不会留下找不到任务的永久锁；此处尚未启动执行器。
      mutateCatalog((s) => { s.tasks.unshift(task); if (makeDefault) s.settings[hostId] = config.backupPath; });
    })();
    try {
      await closeIdleProjectRunners(task.projectIds, { waitMs: 35000 });
      const workerId = await launch(prepared.r, { ...config, key: recoveryKey().toString('base64') }, true);
      Object.assign(task, { workerId });
      mutateCatalog((s) => {
        s.tasks.find((t) => t.id === task.id).workerId = task.workerId;
      });
    } catch (error) {
      mutateCatalog((s) => {
        Object.assign(
          s.tasks.find((t) => t.id === task.id),
          { status: 'running', stage: '启动结果尚未确认，正在核对独立执行器' },
        );
      });
      throw error;
    }
    addOperation({ action: 'backup.full', status: 'running', detail: '已确认完整备份任务 ' + task.id });
    return task;
  } finally {
    active.delete(hostId);
  }
}

export function refreshTasks() {
  if (!refreshPromise)
    refreshPromise = refreshTasksOnce().finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}
async function refreshTasksOnce() {
  const state = catalog();
  // 修复“成功记录已落盘、释放锁前进程退出”的窗口；未知/失败任务始终保留锁。
  for (const task of state.tasks.filter(t => t.status === 'success' && ['backup', 'recovery'].includes(t.action)))
    db.prepare('DELETE FROM maintenance_project_locks WHERE task_id = ?').run(task.originalId || task.id);
  for (const task of state.tasks.filter((t) => t.status === 'running')) {
    if (!task.workerId) {
      const found = await getDockerForHost(task.hostId)
        .listContainers({ all: true, filters: { label: ['composeops.maintenance=' + task.id] } })
        .catch(() => []);
      if (found.length === 1) {
        Object.assign(task, { workerId: found[0].Id });
        mutateCatalog((s) => {
          s.tasks.find((t) => t.id === task.id).workerId = task.workerId;
        });
      } else {
        if (Date.now() - new Date(task.createdAt).getTime() > 60_000)
          mutateCatalog((s) => {
            Object.assign(
              s.tasks.find((t) => t.id === task.id),
              { status: 'interrupted', stage: '无法确认启动结果，请检查 Docker 执行器及容器状态' },
            );
          });
        continue;
      }
    }
    const docker = getDockerForHost(task.hostId);
    try {
      if (task.engineId && (await docker.info()).ID !== task.engineId) throw fault('Docker Engine 身份已变化');
      const worker = docker.getContainer(task.workerId),
        info = await worker.inspect();
      if (info.Config?.Labels?.['composeops.maintenance'] !== task.id || info.Config?.Labels?.['composeops.host'] !== task.hostId) throw fault('执行器归属已变化');
      const events = decode(await collectDockerOutput(await worker.logs({ stdout: true, stderr: true })));
      const last = events.filter((e) => e.status).at(-1);
      const credentialUpdate = events.filter((e) => e.sealedCredentials).at(-1);
      if (credentialUpdate && task.targetId)
        mutateCatalog((s) => {
          const t = s.targets.find((t) => t.id === task.targetId);
          if (t?.revision === task.targetRevision) t.credentials = credentialUpdate.sealedCredentials;
        });
      if (!last && info.State.Running) continue;
      if (!last || (!info.State.Running && last.status === 'running')) {
        mutateCatalog((s) => {
          Object.assign(
            s.tasks.find((t) => t.id === task.id),
            {
              status: 'interrupted',
              stage: '执行器中断，结果未验证；请核对容器启停状态和备份目录 journal.json',
            },
          );
        });
        continue;
      }
      mutateCatalog((s) => {
        const stored = s.tasks.find((t) => t.id === task.id);
        Object.assign(stored, {
          status: last.status,
          stage: last.stage || last.message || (last.status === 'success' ? '已完成' : '执行中'),
          message: last.message || '',
          ...(last.status === 'success' && task.action === 'restore' ? { result: last.result } : {}),
          finishedAt: last.status === 'running' ? null : new Date().toISOString(),
        });
        if (
          last.status === 'success' &&
          task.action === 'backup' &&
          !s.backups.some((b) => b.id === task.id)
        )
          s.backups.unshift({
            ...last.result,
            id: task.id,
            hostId: task.hostId,
            backupPath: task.backupPath,
            path: path.posix.join(task.backupPath, task.id),
            names: task.names,
          });
        if (last.status === 'success' && last.result?.sealedCredentials) {
          const target = s.targets.find((t) => t.id === task.targetId);
          if (target?.revision === task.targetRevision) target.credentials = last.result.sealedCredentials;
        }
        if (last.status === 'success' && task.test) {
          const target = s.targets.find((t) => t.id === task.targetId);
          if (target?.revision === task.targetRevision) target.tested = true;
        }
      });
      // 自动同步在备份已校验且恢复运行后触发；同步失败不改写备份成功事实。
      if (last.status === 'success' && task.action === 'backup')
        await autoSyncBackup(task.id);
      if (last.status === 'success' && ['backup', 'recovery'].includes(task.action)) {
        db.prepare('DELETE FROM maintenance_project_locks WHERE task_id = ?').run(task.originalId || task.id);
        addOperation({ action: 'backup.' + task.action, status: 'success', detail: '任务完成 ' + task.id });
      }
      if (['success', 'failed'].includes(last.status)) {
        await worker.wait();
        await worker.remove({ v: false }).catch(() => {});
      }
    } catch (error) {
      mutateCatalog((s) => {
        const t = s.tasks.find((t) => t.id === task.id);
        if (t?.status === 'running') {
          if (error.statusCode === 404) t.status = 'interrupted';
          t.stage = '无法读取执行器状态，请核对容器启停状态；不会假定成功';
        }
      });
    }
  }
  return catalog();
}
export async function recoverMaintenanceTask(id) {
  const r = await localRuntime(),
    original = catalog().tasks.find((t) => t.id === id && t.hostId === r.host.id);
  if (!original || !['failed', 'interrupted'].includes(original.status) || !original.originallyRunning)
    throw fault('该任务没有可恢复的停机记录');
  try {
    if (original.workerId && (await r.docker.getContainer(original.workerId).inspect()).State.Running)
      throw fault('原执行器仍在运行，请等待结束');
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  const config = {
    id: randomUUID(),
    mode: 'recover',
    sources: [],
    backupPath: original.backupPath,
    originalId: id,
    originallyRunning: original.originallyRunning,
    originalIdentities: original.originalIdentities,
    engineId: original.engineId,
  };
  if (r.engineId !== original.engineId) throw fault('Docker Engine 身份已变化');
  if (catalog().tasks.some(t => t.status === 'running' && t.hostId === r.host.id)) throw fault('当前节点有任务运行，请等待');
  const task = {
      id: config.id,
      hostId: r.host.id,
      workerId: null,
      engineId: r.engineId,
      action: 'recovery',
      originalId: id,
      projectIds: original.projectIds,
      status: 'running',
      stage: '恢复备份前原运行容器',
      createdAt: new Date().toISOString(),
      names: original.names,
    };
  mutateCatalog((s) => s.tasks.unshift(task));
  const workerId = await launch(r, config, true);
  mutateCatalog(s => { s.tasks.find(t => t.id === task.id).workerId = workerId; });
  return { ...task, workerId };
}
export function publicTargets() {
  return catalog().targets.map(({ credentials, ...t }) => ({ ...t, authorized: !!credentials }));
}
export function saveSyncTarget(input) {
  if (
    !['115', 'webdav'].includes(input.type) ||
    !input.name?.trim() ||
    !input.remotePath?.startsWith('/') ||
    input.remotePath.split('/').some((p) => p === '..' || p === '.') ||
    /[\0\r\n]/.test(input.remotePath)
  )
    throw fault('同步目标名称、类型或远端目录无效', 400);
  let url = '';
  if (input.type === 'webdav') {
    try {
      const u = new URL(input.url);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
        throw 0;
      url = u.href;
    } catch {
      throw fault('WebDAV 地址无效，请通过独立字段提供认证信息', 400);
    }
  }
  const id = input.id || randomUUID();
  mutateCatalog((s) => {
    const before = s.targets.find((t) => t.id === id);
    const t = {
      id,
      revision: randomUUID(),
      type: input.type,
      name: input.name.trim(),
      remotePath: input.remotePath,
      url,
      user: input.user || '',
      clientId: input.clientId || '',
      auto: false,
      tested: false,
      credentials:
        before?.type === input.type && (input.type !== '115' || before.clientId === input.clientId)
          ? before.credentials
          : null,
    };
    if (input.type === 'webdav' && input.password) t.credentials = seal({ password: input.password });
    if (before) Object.assign(before, t);
    else s.targets.push(t);
  });
  return publicTargets().find((t) => t.id === id);
}
export function update115Credentials(id, credentials) {
  mutateCatalog((s) => {
    const t = s.targets.find((t) => t.id === id);
    if (!t || t.type !== '115') throw fault('115 同步目标不存在', 404);
    t.credentials = seal(credentials);
    t.revision = randomUUID();
    t.tested = false;
  });
}
export function setSyncAutomatic(id, auto) {
  mutateCatalog((s) => {
    const t = s.targets.find((t) => t.id === id);
    if (!t || !t.tested) throw fault('请先完成目标连接测试');
    t.auto = auto;
  });
  return publicTargets();
}
export async function startSync({ targetId, backupIds, test = false, hostId }) {
  const r = await localRuntime(hostId),
    state = catalog(),
    target = state.targets.find((t) => t.id === targetId);
  if (!target?.credentials) throw fault('请先保存认证信息或授权登录');
  if (!test && !target.tested) throw fault('请先测试连接');
  if (state.tasks.some((t) => t.action === 'sync' && t.targetId === targetId && t.status === 'running'))
    throw fault('该目标已有同步任务');
  const backups = state.backups.filter(
    (b) => b.hostId === r.host.id && backupIds?.includes(b.id) && b.complete && b.fileVerified,
  );
  if (!test && (!backups.length || backups.length !== new Set(backupIds).size))
    throw fault('备份不存在、未完成或属于其他节点');
  if (new Set(backups.map((b) => b.backupPath)).size > 1) throw fault('请选择相同本地保存目录的备份分批同步');
  const backupPath = backups[0]?.backupPath || state.settings[r.host.id];
  if (!validBackupPath(backupPath)) throw fault('请先配置备份保存路径');
  const config = {
    id: randomUUID(),
    hostId: r.host.id,
    mode: 'sync',
    backupPath,
    backups,
    test,
    target: { ...target, credentials: unseal(target.credentials) },
    key: recoveryKey().toString('base64'),
  };
  const task = {
    id: config.id,
    hostId: r.host.id,
    workerId: null,
    engineId: r.engineId,
    action: 'sync',
    status: 'running',
    stage: test ? '测试远端读写与校验' : '上传并校验备份',
    createdAt: new Date().toISOString(),
    names: [target.name],
    targetId,
    targetRevision: target.revision,
    test,
  };
  mutateCatalog((s) => { s.tasks.unshift(task); });
  const workerId = await launch(r, config, true);
  mutateCatalog(s => { s.tasks.find(t => t.id === task.id).workerId = workerId; });
  return { ...task, workerId };
}
async function autoSyncBackup(id) {
  for (const target of catalog().targets.filter((t) => t.auto && t.tested))
    try {
      await startSync({ targetId: target.id, backupIds: [id], hostId: catalog().backups.find(b => b.id === id)?.hostId });
    } catch (error) {
      mutateCatalog((s) => {
        s.tasks.unshift({
          id: randomUUID(),
          hostId: getActiveHost().id,
          action: 'sync',
          status: 'failed',
          names: [target.name],
          stage: error.message,
          createdAt: new Date().toISOString(),
        });
      });
    }
}


const restorePlans = new Map();
export async function prepareFullRestore({ backupId, destination, expectedHostId }) {
  const r = await localRuntime();
  if (r.host.id !== expectedHostId) throw fault('节点已变化，请重新预检');
  if (!validBackupPath(destination)) throw fault('请选择已存在的具体恢复父目录', 400);
  const backup = catalog().backups.find(b => b.id === backupId && b.hostId === r.host.id && b.complete);
  if (!backup) throw fault('本节点备份不存在', 404);
  const id = randomUUID();
  const config = { id, backupId, destination, backupPath: backup.backupPath, sources: [], key: recoveryKey().toString('base64'), engineId: r.engineId };
  const plan = await launch(r, { ...config, mode: 'restore-plan' });
  config.manifestDigest = plan.manifestDigest;
  config.destinationIdentity = plan.destinationIdentity;
  if (getActiveHost().id !== r.host.id) throw fault('节点已变化，请重新预检');
  const token = randomUUID(), expiresAt = Date.now() + 600000;
  for (const [key, entry] of restorePlans) if (entry.expiresAt < Date.now()) restorePlans.delete(key);
  if (restorePlans.size >= 50) throw fault('待确认恢复计划过多');
  restorePlans.set(token, { r, config, expiresAt, plan });
  return { ...plan, token, expiresAt };
}
export async function executeFullRestore({ token, confirmed, start = false }) {
  const prepared = restorePlans.get(token);
  if (!prepared || prepared.expiresAt < Date.now()) throw fault('恢复计划已过期');
  if (!confirmed) throw fault('请确认恢复范围', 400);
  if (prepared.r.host.id !== getActiveHost().id) throw fault('节点已变化，请重新预检');
  if (prepared.plan.blockers.length) throw fault('恢复预检未通过');
  restorePlans.delete(token);
  const { r, config } = prepared;
  const task = { id: config.id, hostId: r.host.id, engineId: r.engineId, workerId: null, action: 'restore', status: 'running', stage: '准备隔离恢复', names: [config.backupId], createdAt: new Date().toISOString() };
  mutateCatalog(s => s.tasks.unshift(task));
  const workerId = await launch(r, { ...config, mode: 'restore', start: start === true }, true);
  mutateCatalog(s => { s.tasks.find(t => t.id === task.id).workerId = workerId; });
  addOperation({ action: 'backup.restore', status: 'running', detail: '已确认隔离恢复 ' + task.id });
  return { ...task, workerId };
}
