import path from 'node:path';
import { readFile, writeFile, mkdir, lstat, realpath, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import tar from 'tar-stream';
import { decryptArtifact, digestFile } from './maintenance-archive.js';

const fail = message => { throw new Error(message); };
const inside = (root, file) => file === root || file.startsWith(root + '/');
// Docker inspect 中已是展开后的实际值；写回 Compose 必须转义，不能再次展开环境变量。
export function serializeRestoreCompose(compose) {
  return JSON.stringify(compose, (_key, value) => typeof value === 'string' ? value.replaceAll('$', () => '$$') : value, 2);
}
export async function readRestoreManifest(source, key) {
  const receipt = JSON.parse(await readFile(path.join(source, 'receipt.json'), 'utf8'));
  if (receipt.type !== 'full' || !receipt.complete || !receipt.fileVerified || !Array.isArray(receipt.artifacts)) fail('备份未完整完成');
  const chunks = [];
  let bytes = 0;
  await decryptArtifact(path.join(source, 'manifest.json.enc'), key, new Writable({ write(chunk, _, done) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 ** 2) return done(new Error('恢复清单超过限制'));
    chunks.push(chunk); done();
  } }));
  const manifest = JSON.parse(Buffer.concat(chunks).toString());
  if (manifest.id !== receipt.id || manifest.type !== 'full' || !Array.isArray(manifest.artifacts) || manifest.artifacts.length + 1 !== receipt.artifacts.length) fail('备份批次与认证清单不一致');
  const seen = new Set();
  for (const artifact of [...manifest.artifacts, receipt.artifacts.find(a => a.kind === 'manifest')]) {
    if (!artifact || !/^[\w-]+\.(?:tar|json)\.enc$/.test(artifact.file) || seen.has(artifact.file)) fail('备份文件名无效或重复');
    seen.add(artifact.file);
    if (!receipt.artifacts.some(a => a.file === artifact.file && a.sha256 === artifact.sha256 && a.bytes === artifact.bytes)) fail('备份产物不完整');
    const file = path.join(source, artifact.file), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes || await digestFile(file) !== artifact.sha256) fail('备份文件校验失败');
  }
  return manifest;
}

export function buildRestorePlan(manifest, destination, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail('恢复任务 ID 无效');
  const root = path.posix.join(destination, 'composeops-restore-' + id);
  const blockers = [];
  const mappings = manifest.artifacts.filter(a => ['project', 'bind', 'configuration', 'volume'].includes(a.kind)).map((a, i) => ({
    kind: a.kind, source: a.source, file: a.file, archiveRoot: a.archiveRoot,
    target: path.posix.join(root, 'sources', String(i), a.archiveRoot || 'data'),
  }));
  for (const a of mappings) if (!a.archiveRoot || a.archiveRoot === '.' || a.archiveRoot === '..' || a.archiveRoot.includes('/') || a.archiveRoot.includes('\\')) fail('恢复归档根无效');
  const services = {};
  const networks = {};
  for (const [i, c] of manifest.containers.entries()) {
    const host = c.HostConfig || {}, conf = c.Config || {};
    if (host.Privileged || host.Devices?.length || host.DeviceRequests?.length || ['host', 'container'].some(mode => String(host.NetworkMode).startsWith(mode)) || host.PidMode === 'host' || host.IpcMode === 'host' || host.CapAdd?.length || host.SecurityOpt?.some(v => /unconfined/.test(v))) blockers.push(`${c.Name}: 宿主权限、设备或共享命名空间需要专门的恢复适配`);
    const snapshot = manifest.artifacts.find(a => a.kind === 'writable-layer' && a.containerId === c.Id);
    if (!snapshot?.imageId) { blockers.push(`${c.Name}: 缺少可写层镜像`); continue; }
    const volumes = [];
    for (const mount of c.Mounts || []) {
      const source = mount.Type === 'volume' ? mount.Name : mount.Source;
      const candidates = mappings.filter(m => mount.Type === 'volume' ? m.kind === 'volume' && m.source === source : m.kind !== 'volume' && inside(m.source, source)).sort((a, b) => b.source.length - a.source.length);
      const mapping = candidates[0];
      if (!mapping) { blockers.push(`${c.Name}: 挂载 ${mount.Destination} 没有独立备份，不能复用原资源`); continue; }
      volumes.push({ type: 'bind', source: mapping.target + (mount.Type === 'volume' ? '' : source.slice(mapping.source.length)), target: mount.Destination, read_only: mount.RW === false, bind: { create_host_path: false } });
    }
    const attached = {};
    for (const [network, endpoint] of Object.entries(c.NetworkSettings?.Networks || {})) {
      const key = 'net' + Object.keys(networks).length;
      const existing = Object.keys(networks).find(k => networks[k]['x-original'] === network);
      const n = existing || key;
      networks[n] ||= { internal: true, 'x-original': network };
      attached[n] = { aliases: [...new Set([...(endpoint.Aliases || []), conf.Labels?.['com.docker.compose.service']].filter(Boolean))] };
    }
    if (!Object.keys(attached).length) { networks.isolated ||= { internal: true }; attached.isolated = {}; }
    services['service' + i] = {
      image: snapshot.imageId, pull_policy: 'never',
      ...(conf.Entrypoint ? { entrypoint: conf.Entrypoint } : {}),
      ...(conf.Cmd ? { command: conf.Cmd } : {}), environment: conf.Env || [],
      ...(conf.WorkingDir ? { working_dir: conf.WorkingDir } : {}),
      ...(conf.User ? { user: conf.User } : {}),
      ...(conf.Healthcheck ? { healthcheck: { test: conf.Healthcheck.Test, ...(conf.Healthcheck.Interval ? { interval: conf.Healthcheck.Interval + 'ns' } : {}), ...(conf.Healthcheck.Timeout ? { timeout: conf.Healthcheck.Timeout + 'ns' } : {}), ...(conf.Healthcheck.Retries ? { retries: conf.Healthcheck.Retries } : {}), ...(conf.Healthcheck.StartPeriod ? { start_period: conf.Healthcheck.StartPeriod + 'ns' } : {}) } } : {}),
      volumes, networks: attached, restart: 'no', read_only: !!host.ReadonlyRootfs,
      labels: { 'composeops.restore': id, 'composeops.restore.source': manifest.id },
    };
  }
  return { originallyRunningServices: manifest.containers.flatMap((c, i) => c.State?.Running ? ['service' + i] : []), id, backupId: manifest.id, root, mappings, blockers, containerCount: Object.keys(services).length,
    compose: { name: 'co-restore-' + id.slice(0, 8), services, networks },
    verification: 'isolated-files-and-container-creation',
  };
}

export async function validateRestoreTar(file, root) {
  const parser = tar.extract(), links = [], entries = [];
  parser.on('entry', (header, stream, next) => {
    stream.on('error', () => {});
    try {
      const name = header.name.replace(/\/$/, '');
      if (!name || path.posix.isAbsolute(name) || name.includes('\\') || name.split('/').includes('..') || !inside(root, name)) fail('归档包含越界路径');
      if (!['file', 'directory', 'symlink', 'link'].includes(header.type)) fail('归档包含不支持的特殊文件');
      if (['symlink', 'link'].includes(header.type)) {
        const target = header.linkname || '';
        const resolved = path.posix.normalize(header.type === 'symlink' ? path.posix.join(path.posix.dirname(name), target) : target);
        if (path.posix.isAbsolute(target) || !inside(root, resolved)) fail('归档链接越界');
        links.push(name);
      }
      entries.push(name);
      stream.on('end', next); stream.resume();
    } catch (error) { stream.destroy(error); parser.destroy(error); }
  });
  await pipeline(createReadStream(file), parser);
  if (entries.some(name => links.some(link => name !== link && inside(link, name)))) fail('归档不能向链接路径下写入');
}
async function command(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${bin} 恢复步骤失败（${code}）`)));
  });
}
export async function runRestore(config, { docker, emit = () => {}, source = '/backup/' + config.backupId, output = '/restore' } = {}) {
  if ((await docker.info()).ID !== config.engineId) fail('Docker Engine 身份已变化');
  if (config.manifestDigest && await digestFile(path.join(source, 'manifest.json.enc')) !== config.manifestDigest) fail('恢复备份在确认后已变化');
  const destinationInfo = await lstat(output);
  if (config.destinationIdentity && (String(destinationInfo.dev) !== config.destinationIdentity.dev || String(destinationInfo.ino) !== config.destinationIdentity.ino)) fail('恢复目录在确认后被替换');
  const key = Buffer.from(config.key, 'base64');
  const manifest = await readRestoreManifest(source, key);
  const plan = buildRestorePlan(manifest, config.destination, config.id);
  if (plan.blockers.length) fail(plan.blockers.join('；'));
  if (await realpath(output) !== output) fail('恢复目标不能是符号链接');
  const local = path.join(output, path.basename(plan.root));
  await mkdir(local, { mode: 0o700 }); // EEXIST deliberately refuses replay and overwrite.
  await writeFile(path.join(local, 'restore-journal.json'), JSON.stringify({ id: config.id, backupId: config.backupId, stage: 'started', engineId: config.engineId }), { flag: 'wx', mode: 0o600 });
  const decrypted = path.join(local, '.artifacts'); await mkdir(decrypted, { mode: 0o700 });
  // Authenticate every artifact completely before allowing it into Docker or extracting it.
  for (const a of manifest.artifacts) {
    emit({ status: 'running', stage: '验证并解密恢复产物 ' + a.file });
    await decryptArtifact(path.join(source, a.file), key, createWriteStream(path.join(decrypted, a.file.slice(0, -4)), { flags: 'wx', mode: 0o600 }));
  }
  for (const [i, mapping] of plan.mappings.entries()) {
    const file = path.join(decrypted, mapping.file.slice(0, -4));
    await validateRestoreTar(file, mapping.archiveRoot);
    const target = path.join(local, 'sources', String(i)); await mkdir(target, { recursive: true, mode: 0o700 });
    await command('tar', ['--acls', '--xattrs', '--numeric-owner', '-xpf', file, '-C', target], local);
  }
  for (const a of manifest.artifacts.filter(a => a.kind === 'writable-layer')) {
    emit({ status: 'running', stage: '导入固定镜像 ' + a.kind });
    const stream = await docker.loadImage(createReadStream(path.join(decrypted, a.file.slice(0, -4))));
    await new Promise((resolve, reject) => docker.modem.followProgress(stream, (error, results) => error || results?.some(r => r.error) ? reject(error || new Error('镜像导入失败')) : resolve()));
    if ((await docker.getImage(a.imageId).inspect()).Id !== a.imageId) fail('导入镜像身份不一致');
  }
  await writeFile(path.join(local, 'compose.json'), serializeRestoreCompose(plan.compose), { flag: 'wx', mode: 0o600 });
  await command('docker', ['compose', '-f', path.join(local, 'compose.json'), 'create', '--pull', 'never'], local);
  const containers = await docker.listContainers({ all: true, filters: { label: ['composeops.restore=' + config.id] } });
  if (containers.length !== plan.containerCount || containers.some(c => c.State === 'running')) fail('隔离容器创建状态未通过验收');
  if (config.start && plan.originallyRunningServices.length) {
    await command('docker', ['compose', '-f', path.join(local, 'compose.json'), 'start', ...plan.originallyRunningServices], local);
    for (const container of containers.filter(c => plan.originallyRunningServices.includes(c.Labels?.['com.docker.compose.service']))) {
      let healthy = false;
      for (let i = 0; i < 60; i++) {
        const info = await docker.getContainer(container.Id).inspect();
        if (info.State.Running && (!info.State.Health || info.State.Health.Status === 'healthy')) { healthy = true; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!healthy) fail('隔离容器未通过运行状态检查，请查看隔离副本日志');
    }
  }
  await rm(decrypted, { recursive: true });
  const result = { root: plan.root, containerIds: containers.map(c => c.Id), composeFile: plan.root + '/compose.json', filesVerified: true, containersCreated: true, businessVerified: false, started: !!config.start };
  await writeFile(path.join(local, 'restore-journal.json'), JSON.stringify({ id: config.id, stage: 'complete', ...result }), { mode: 0o600 });
  return result;
}
