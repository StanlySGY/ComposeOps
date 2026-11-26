// 独立于面板进程运行。配置与密钥通过 tmpfs 文件传入，不放在 Docker Env/日志中。
import Docker from 'dockerode';
import path from 'node:path';
import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  realpath,
  readdir,
  statfs,
  access,
  rename,
  open,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { encryptArtifact, decryptArtifact, digestFile } from './maintenance-archive.js';

export const within = (parent, child) =>
  child === parent || child.startsWith(parent.replace(/\/$/, '') + '/');
// 只比较网络配置身份；停止/启动会重建 EndpointID 和临时 IP，不能据此误判配置已变。
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
export const containerIdentity = (c) =>
  canonical([
    c.Id,
    c.Image,
    c.Config,
    c.HostConfig,
    [...(c.Mounts || [])].sort((a, b) => String(a.Destination).localeCompare(String(b.Destination))),
    Object.entries(c.NetworkSettings?.Networks || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([network, n]) => [network, n.NetworkID, n.IPAMConfig, n.Aliases, n.Links, n.DriverOpts]),
    c.State?.Running,
  ]);
export function validBackupPath(value) {
  return (
    typeof value === 'string' &&
    value.length <= 1024 &&
    value.startsWith('/') &&
    !/[\0\r\n]/.test(value) &&
    !value.split('/').includes('..') &&
    ![
      '/',
      '/etc',
      '/var',
      '/root',
      '/home',
      '/vol1',
      '/vol2',
      '/tmp',
      '/proc',
      '/sys',
      '/dev',
      '/run',
      '/var/lib/docker',
      '/var/lib/containerd',
    ].includes(path.posix.normalize(value).replace(/\/$/, '') || '/')
  );
}
export function backupStopOrder(containers, projects = []) {
  const ordered = [],
    visiting = new Set(),
    visited = new Set();
  const labels = (c) => c.Config.Labels || {};
  function visit(c) {
    if (visited.has(c.Id)) return;
    if (visiting.has(c.Id)) throw new Error('Compose 依赖存在环，无法确定停写与恢复顺序');
    visiting.add(c.Id);
    const l = labels(c),
      project = projects.find(
        (p) =>
          p.name === l['com.docker.compose.project'] &&
          p.directory === l['com.docker.compose.project.working_dir'],
      );
    const dependencies = Object.keys(
      project?.model?.services?.[l['com.docker.compose.service']]?.depends_on || {},
    );
    for (const dep of dependencies)
      for (const other of containers.filter(
        (o) =>
          labels(o)['com.docker.compose.project'] === l['com.docker.compose.project'] &&
          labels(o)['com.docker.compose.project.working_dir'] ===
            l['com.docker.compose.project.working_dir'] &&
          labels(o)['com.docker.compose.service'] === dep,
      ))
        visit(other);
    visiting.delete(c.Id);
    visited.add(c.Id);
    ordered.push(c);
  }
  // 没有 Compose 依赖时，先加入数据库到启动顺序，反转后数据库最后停止。
  const db = (c) =>
    /(?:postgres|mysql|mariadb|mongo|redis|sqlite|influx|clickhouse|mssql)/i.test(c.Config.Image || '');
  for (const c of [...containers].sort((a, b) => Number(db(b)) - Number(db(a)))) visit(c);
  return ordered.reverse();
}
const hostPath = (source) => '/host' + source;
export async function inspectSources(
  sources,
  destination,
  { prefix = hostPath, volumePrefix = '/volumes/', destinationLocation = '/backup' } = {},
) {
  const root = await realpath(prefix(destination));
  await access(destinationLocation, constants.W_OK);
  const errors = [],
    stats = [],
    links = new Map();
  let bytes = 0,
    files = 0;
  const roots = [];
  for (const s of sources) {
    const file = s.kind === 'volume' ? volumePrefix + s.index : prefix(s.source);
    if (s.kind !== 'volume') {
      let current = prefix('/');
      for (const part of s.source.split('/').filter(Boolean)) {
        current = path.join(current, part);
        if ((await lstat(current)).isSymbolicLink())
          throw new Error('备份源路径包含符号链接，请改为真实路径后重新预检：' + s.source);
      }
    }
    const actual = await realpath(file);
    if (within(actual, root) || within(root, actual)) throw new Error('备份保存路径与备份源重叠');
    roots.push(actual);
    const info = await lstat(file);
    stats.push({
      source: s.source,
      dev: String(info.dev),
      ino: String(info.ino),
      size: info.size,
      mtime: info.mtimeMs,
      actual,
    });
  }
  async function visit(file, archiveRoot) {
    if (++files > 2_000_000) throw new Error('文件数量超过单次预检上限，请缩小备份范围');
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      // /host 内绝对符号链接必须按宿主机语义解析，不能意外解析成 worker 的路径。
      const { readlink } = await import('node:fs/promises');
      const target = await readlink(file);
      const resolved =
        target.startsWith('/') && file.startsWith('/host/')
          ? hostPath(target)
          : path.resolve(path.dirname(file), target);
      const actual = await realpath(resolved);
      if (!roots.some((r) => within(r, actual)))
        errors.push('符号链接目标不在备份范围内：' + file.replace(/^\/host/, ''));
    } else if (info.isDirectory()) {
      for (const name of await readdir(file)) await visit(path.join(file, name), archiveRoot);
    } else if (info.isFile()) {
      bytes += info.size;
      if (info.nlink > 1) {
        const id = `${archiveRoot}:${info.dev}:${info.ino}`;
        const entry = links.get(id) || { count: 0, expected: info.nlink };
        entry.count++;
        links.set(id, entry);
      }
    } else errors.push('存在无法静态备份的 socket、设备或 FIFO：' + file.replace(/^\/host/, ''));
    if (errors.length > 20) throw new Error(errors[0]);
  }
  // 合并父子目录，防止重复统计导致硬链接验证错误。
  const distinctRoots = roots.filter(
    (r, i) => roots.indexOf(r) === i && !roots.some((other) => r !== other && within(other, r)),
  );
  for (const r of distinctRoots) await visit(r, r);
  for (const entry of links.values())
    if (entry.count < entry.expected) errors.push('存在指向备份范围外的硬链接，无法完整保留链接关系');
  if (errors.length) throw new Error(errors[0]);
  const space = await statfs(destinationLocation);
  return {
    bytes,
    files,
    freeBytes: Number(space.bavail) * Number(space.bsize),
    stats,
    actualDestination: root,
  };
}
export async function configurationDigests(files, prefix = hostPath) {
  const result = [];
  for (const source of [...new Set(files || [])].sort()) {
    try {
      const file = prefix(source),
        info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('配置文件不可经过符号链接：' + source);
      if (info.isFile()) result.push({ source, sha256: await digestFile(file) });
    } catch (e) {
      if (e.code === 'ENOENT') result.push({ source, absent: true });
      else throw e;
    }
  }
  return result;
}

function tarSource(file) {
  const child = spawn(
    'tar',
    [
      '--acls',
      '--xattrs',
      '--xattrs-include=*',
      '--numeric-owner',
      '--sparse',
      '--format=pax',
      '-cpf',
      '-',
      '-C',
      path.dirname(file),
      '--',
      path.basename(file),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // 消费 stderr，任何非零退出（含文件变化/权限丢失）都使本次备份失败。
  child.stderr.resume();
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('归档失败或文件在归档期间变化')),
    );
  });
  done.catch(() => {});
  return { stream: child.stdout, done, stop: () => child.kill('SIGTERM') };
}
export async function verifySavedArtifact(file, key) {
  if (!file.endsWith('.tar.enc')) return decryptArtifact(file, key);
  const verifier = spawn('tar', ['-tf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
  verifier.stderr.resume();
  const done = new Promise((resolve, reject) => {
    verifier.once('error', reject);
    verifier.once('close', (code) => (code === 0 ? resolve() : reject(new Error('归档内容结构校验失败'))));
  });
  done.catch(() => {});
  try {
    await decryptArtifact(file, key, verifier.stdin);
    await done;
  } catch (error) {
    verifier.kill('SIGTERM');
    throw error;
  }
}
export async function runBackup(
  config,
  {
    docker = new Docker({ socketPath: '/var/run/docker.sock' }),
    output = '/backup',
    prefix = hostPath,
    archive = tarSource,
    verifyArtifact = verifySavedArtifact,
    emit = () => {},
  } = {},
) {
  if (config.engineId && (await docker.info()).ID !== config.engineId) throw new Error('Docker Engine 身份已变化');
  const directory = path.join(output, config.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const journalPath = path.join(directory, 'journal.json');
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const stopped = journal?.resumeIds || [];
  async function journalWrite() {
    await writeFile(journalPath + '.tmp', JSON.stringify({ resumeIds: stopped }), { mode: 0o600 });
    const file = await open(journalPath + '.tmp', 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(journalPath + '.tmp', journalPath);
  }
  async function resume() {
    const failures = [];
    // 原停止顺序的逆序恢复；所有容器都尝试，不能因首个错误放弃其他容器。
    for (const id of [...stopped].reverse()) {
      try {
        const c = docker.getContainer(id),
          inspect = await c.inspect();
        if (!inspect.State.Running) await c.start();
        stopped.splice(stopped.indexOf(id), 1);
        await journalWrite();
      } catch {
        failures.push(id);
      }
    }
    if (failures.length) throw new Error('原运行容器未全部恢复，请人工检查：' + failures.join('、'));
  }
  if (journal) {
    await resume();
    throw new Error('上次备份进程中断，已尝试恢复原运行容器；备份未标记完整，请重新预检');
  }
  const key = Buffer.from(config.key, 'base64');
  const artifacts = [],
    snapshots = [];
  let stage = '执行前重新核对范围';
  const report = () => emit({ status: 'running', stage });
  let signalError = null;
  const onSignal = () => {
    signalError = new Error('收到停止信号');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  function checkSignal() {
    if (signalError) throw signalError;
  }
  async function save(name, stream, meta) {
    checkSignal();
    const result = await encryptArtifact(stream, path.join(directory, name + '.enc'), key);
    // 读回密文，实际 GCM 解密校验，而非仅检查文件存在。
    await verifyArtifact(path.join(directory, result.file), key);
    artifacts.push({ ...result, ...meta });
  }
  try {
    report();
    for (const before of config.containers) {
      const current = await docker.getContainer(before.Id).inspect();
      if (JSON.stringify(containerIdentity(current)) !== JSON.stringify(containerIdentity(before)))
        throw new Error('容器配置或启停状态已改变，请重新预检');
    }
    for (const before of config.allSignatures || []) {
      if (config.containers.some((c) => c.Id === before.id)) continue;
      const now = await docker.getContainer(before.id).inspect();
      const signature = createHash('sha256')
        .update(JSON.stringify(containerIdentity(now)))
        .digest('hex');
      if (signature !== before.signature) throw new Error('其他容器配置已变化，需要重新确认共享写入范围');
    }
    const scan = await inspectSources(config.sources, config.backupPath, {
      prefix,
      destinationLocation: output,
    });
    const structure = (stats) => stats.map(({ source, dev, ino, actual }) => ({ source, dev, ino, actual }));
    if (JSON.stringify(structure(scan.stats)) !== JSON.stringify(structure(config.scan.stats)))
      throw new Error('备份源或保存目录已改变，请重新预检');
    if (
      config.configDigests &&
      JSON.stringify(await configurationDigests(config.configFiles, prefix)) !==
        JSON.stringify(config.configDigests)
    )
      throw new Error('部署配置或环境文件已变化，请重新预检');
    const required = (scan.bytes + config.imageBytes * 2 + config.rootfsBytes) * 1.15 + 256 * 1024 ** 2;
    if (scan.freeBytes < required) throw new Error('备份空间不足，禁止进入停机阶段');
    // 在停机前保存原镜像，减少停机时间。
    stage = '保存原始镜像';
    report();
    for (const [index, id] of [...new Set(config.containers.map((c) => c.Image))].entries())
      await save('image-' + index + '.tar', await docker.getImage(id).get(), { kind: 'image', imageId: id });
    stage = '停止关联容器并确认干净退出';
    report();
    await journalWrite();
    // 应用先停，数据库最后停，恢复时反向操作。
    const ordered = backupStopOrder(config.containers, config.projects);
    for (const c of ordered) {
      checkSignal();
      if (!c.State.Running) continue;
      // 先写恢复日志再发停止，覆盖“已停但未登记”的崩溃窗口。
      stopped.push(c.Id);
      await journalWrite();
      await docker.getContainer(c.Id).stop({ t: 120 });
      const after = await docker.getContainer(c.Id).inspect();
      if (after.State.Running || after.State.OOMKilled || after.State.ExitCode !== 0)
        throw new Error('容器未干净退出，无法证明数据库一致性：' + c.Name);
    }
    stage = '归档配置、宿主机挂载与全部数据卷';
    report();
    // 停机后再检查共享写入者，防止预检期间新容器开始写共享数据。
    const current = await docker.listContainers({ all: true });
    if (
      current.some(
        (c) =>
          !config.allIds.includes(c.Id) && c.State === 'running' && !c.Labels?.['composeops.maintenance'],
      )
    )
      throw new Error('有新增运行容器，需重新核对共享挂载写入者');
    const stoppedScan = await inspectSources(config.sources, config.backupPath, {
      prefix,
      destinationLocation: output,
    });
    if (JSON.stringify(structure(stoppedScan.stats)) !== JSON.stringify(structure(scan.stats)))
      throw new Error('停机期间备份源被替换，不能确认完整范围');
    if (
      config.configDigests &&
      JSON.stringify(await configurationDigests(config.configFiles, prefix)) !==
        JSON.stringify(config.configDigests)
    )
      throw new Error('停机期间部署配置发生变化，不能确认完整范围');
    for (const source of config.sources) {
      checkSignal();
      const file = source.kind === 'volume' ? '/volumes/' + source.index : prefix(source.source);
      const tar = archive(file);
      try {
        await save('source-' + source.index + '.tar', tar.stream, {
          kind: source.kind,
          source: source.source,
          archiveRoot: path.basename(file),
        });
        await tar.done;
      } catch (error) {
        tar.stop();
        throw error;
      }
    }
    stage = '保存容器可写层快照';
    report();
    for (const [index, c] of config.containers.entries()) {
      checkSignal();
      const committed = await docker.getContainer(c.Id).commit({ pause: false });
      snapshots.push(committed.Id);
      await save('rootfs-' + index + '.tar', await docker.getImage(committed.Id).get(), {
        kind: 'writable-layer',
        containerId: c.Id,
        imageId: committed.Id,
      });
    }
    stage = '生成完整恢复清单并校验';
    report();
    const manifest = {
      schemaVersion: 1,
      id: config.id,
      type: 'full',
      createdAt: new Date().toISOString(),
      hostId: config.hostId,
      consistency: 'all-running-containers-cleanly-stopped',
      containers: config.containers,
      projects: config.projects,
      networks: config.networks,
      volumes: config.volumes,
      sources: config.sources,
      artifacts: [...artifacts],
      runtimeDependencies: config.runtimeDependencies,
      restoreVerified: false,
    };
    await save('manifest.json', JSON.stringify(manifest), { kind: 'manifest' });
  } finally {
    stage = '恢复原有启停状态';
    report();
    try {
      await resume();
    } finally {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      for (const id of snapshots) {
        try {
          await docker.getImage(id).remove();
        } catch {
          /* 不删除已被其他容器使用的镜像 */
        }
      }
    }
  }
  for (const c of config.containers.filter((c) => c.State.Running)) {
    const handle = docker.getContainer(c.Id);
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const now = await handle.inspect();
      if (now.State.Running && (!now.State.Health || now.State.Health.Status === 'healthy')) {
        healthy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!healthy) throw new Error('已恢复启动，但健康检查未通过：' + c.Name);
  }
  const receipt = {
    id: config.id,
    type: 'full',
    complete: true,
    fileVerified: true,
    restoreVerified: false,
    artifacts,
    bytes: artifacts.reduce((n, a) => n + a.bytes, 0),
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(directory, 'receipt.json.tmp'), JSON.stringify(receipt), { mode: 0o600 });
  await rename(path.join(directory, 'receipt.json.tmp'), path.join(directory, 'receipt.json'));
  return receipt;
}

export async function runRecovery(config, {
  docker = new Docker({ socketPath: '/var/run/docker.sock' }),
  output = '/backup',
  attempts = 60,
  wait = () => new Promise(resolve => setTimeout(resolve, 1000)),
} = {}) {
  const directory = path.join(output, config.originalId);
  let journal;
  try { journal = JSON.parse(await readFile(path.join(directory, 'journal.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; journal = { resumeIds: config.originallyRunning }; }
  if (!config.engineId || (await docker.info()).ID !== config.engineId) throw new Error('Docker Engine 身份已变化，不能恢复');
  if (!Array.isArray(journal.resumeIds) || journal.resumeIds.some(id => !config.originallyRunning.includes(id)))
    throw new Error('恢复日志包含不属于原运行范围的容器，禁止执行');
  // 即使 journal 已清空，仍要复核全部原运行容器，避免健康检查失败后的恢复被误报成功。
  const ids = [...new Set([...journal.resumeIds].reverse().concat(config.originallyRunning))];
  for (const id of ids) {
    const c = docker.getContainer(id), info = await c.inspect();
    const signature = createHash('sha256').update(JSON.stringify(containerIdentity({ ...info, State: { ...info.State, Running: false } }))).digest('hex');
    if (!config.originalIdentities?.some(item => item.id === id && item.signature === signature)) throw new Error('原容器身份或配置已变化，不能恢复');
    if (!info.State.Running) await c.start();
    let healthy = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const now = await c.inspect();
      if (now.State.Running && (!now.State.Health || now.State.Health.Status === 'healthy')) { healthy = true; break; }
      await wait();
    }
    if (!healthy) throw new Error('原运行容器健康检查未通过：' + id);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'journal.json');
  await writeFile(file + '.tmp', JSON.stringify({ resumeIds: [] }), { mode: 0o600 });
  await rename(file + '.tmp', file);
  return { recovered: true };
}

async function main() {
  for (let i = 0; i < 150; i++) {
    try {
      await access('/run/composeops/ready');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const config = JSON.parse(await readFile('/run/composeops/config.json', 'utf8'));
  const emit = (value) => process.stdout.write('COMPOSEOPS_RESULT:' + JSON.stringify(value) + '\n');
  try {
    if (config.mode === 'probe') {
      const result = await inspectSources(config.sources, config.backupPath);
      result.configDigests = await configurationDigests(config.configFiles);
      emit({ status: 'success', result });
    } else if (config.mode === 'restore-plan') {
      const { readRestoreManifest, buildRestorePlan } = await import('./maintenance-restore.js');
      const destination = '/host' + config.destination;
      if (await realpath(destination) !== destination || !(await lstat(destination)).isDirectory()) throw new Error('恢复父目录必须是真实目录');
      const manifest = await readRestoreManifest('/backup/' + config.backupId, Buffer.from(config.key, 'base64'));
      const plan = buildRestorePlan(manifest, config.destination, config.id);
      try { await lstat('/host' + plan.root); throw new Error('恢复目标已存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const info = await lstat(destination);
      if (manifest.sources.some(s => s.kind !== 'volume' && within(s.source, config.destination)) || within(config.backupPath, config.destination)) throw new Error('恢复目录不能位于原数据或备份目录之内');
      const { compose: _compose, ...publicPlan } = plan;
      publicPlan.manifestDigest = await digestFile('/backup/' + config.backupId + '/manifest.json.enc');
      publicPlan.destinationIdentity = { dev: String(info.dev), ino: String(info.ino) };
      emit({ status: 'success', result: publicPlan });
    } else if (config.mode === 'restore') {
      const { runRestore } = await import('./maintenance-restore.js');
      emit({ status: 'success', result: await runRestore(config, { docker: new Docker({ socketPath: '/var/run/docker.sock' }), emit }) });
    } else if (config.mode === 'recover') {
      emit({ status: 'success', result: await runRecovery(config) });
    } else if (config.mode === 'sync') {
      const { runSync } = await import('./maintenance-sync.js');
      emit({ status: 'success', result: await runSync(config, { emit }) });
    } else emit({ status: 'success', result: await runBackup(config, { emit }) });
  } catch (error) {
    // 仅传受控错误；外部服务错误不得输出凭据、HTTP 响应或配置内容。
    emit({
      status: 'failed',
      message:
        config.mode === 'sync'
          ? '远端同步失败（连接、授权、空间或完整性校验未通过），可重试；本地备份保留'
          : error.message,
    });
    process.exitCode = 1;
  }
  // OSS 的后台凭据刷新计时器不应使一次性执行器一直驻留；先刷出最终状态再退出。
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(process.exitCode || 0);
}
if (process.argv[1]?.endsWith('/maintenance-worker.js')) await main();
