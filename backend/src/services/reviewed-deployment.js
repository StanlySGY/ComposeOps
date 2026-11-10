import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as YAML from 'yaml';
import { getActiveHostId, getProjectDocker } from './docker-hosts.js';
import { readCompose, spawnComposeCommand, composeProjectOptions } from './compose-runner.js';
import { withRunner, execInRunner, readArchiveFile } from './compose-workspace.js';
import { createComposeChangePreview, validateComposeSemantics } from './compose-validator.js';
import { harvestSecretValues, redactSecretValue } from '../lib/secret-redactor.js';

const reviews = new Map();
const TTL = 15 * 60 * 1000;
const MAX_OUTPUT = 1024 * 1024;
const conflict = () => Object.assign(new Error('配置、环境、权限或节点已变化，本次未部署，请重新评审'), { statusCode: 409 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function checkProject(project, hostId, activeHostId) {
  if (!project?.editable || !project.managed || !project.mountEnabled || activeHostId() !== hostId || (project.host?.id || project.hostId) !== hostId) throw conflict();
}
function commandResult(result) {
  if (result.code !== 0 || Buffer.byteLength(result.stdout || '') >= MAX_OUTPUT) {
    // Compose errors can contain expanded environment values. Never echo raw stderr to the browser.
    throw Object.assign(new Error('无法解析完整 Compose 配置，请检查文件、环境引用与 Compose 版本后重试'), { statusCode: 422 });
  }
  return result.stdout;
}
function localConfig(project, args) {
  return new Promise((resolve, reject) => {
    const child = spawnComposeCommand(project, ['config', ...args]);
    let output = ''; let bytes = 0; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes < MAX_OUTPUT) output += chunk.toString('utf8'); else child.kill('SIGKILL'); });
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error('完整配置解析超时，请重试'), { statusCode: 504 }));
      try { resolve(commandResult({ code: bytes >= MAX_OUTPUT ? 1 : code, stdout: output })); } catch (error) { reject(error); }
    });
  });
}

/** Same compose options, filesystem and environment as execution, for local/workspace/SSH. */
export async function captureDeploymentInputs(project, deps = {}) {
  const capture = async (io) => {
    const files = [];
    for (const [index, file] of project.composeFiles.entries()) files.push({ path: file, content: await io.read(file, index) });
    const environment = await io.config(['--environment']);
    const unresolved = JSON.parse(await io.config(['--format', 'json', '--no-env-resolution']));
    const effective = JSON.parse(await io.config(['--format', 'json']));
    const env = Object.fromEntries(environment.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    const root = path.dirname(project.composeFiles[0]);
    const envPaths = new Set([path.join(project.workingDir, '.env'), path.join(root, '.env')]);
    for (const file of (env.COMPOSE_ENV_FILES || '').split(',').filter(Boolean)) envPaths.add(path.resolve(project.workingDir, file));
    for (const service of Object.values(unresolved.services || {})) {
      for (const file of service.env_file || []) envPaths.add(path.resolve(root, typeof file === 'string' ? file : file.path));
    }
    // Include raw included/extended Compose documents, not just their merged values.
    const visited = new Set(files.map(file => file.path));
    const expand = text => String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-|:\+|\+)([^}]*))?\}/g, (_, key, op, fallback) => {
      if (op === ':+') return env[key] ? fallback : '';
      if (op === '+') return env[key] !== undefined ? fallback : '';
      return (op === ':-' ? env[key] || fallback : env[key] ?? fallback) ?? '';
    });
    for (let i = 0; i < files.length; i++) {
      if (files.length > 100) throw Object.assign(new Error('Compose 引用文件过多，请缩小评审范围'), { statusCode: 422 });
      const doc = YAML.parse(files[i].content) || {};
      for (const include of Array.isArray(doc.include) ? doc.include : doc.include ? [doc.include] : []) {
        if (typeof include !== 'object' || !include) continue;
        const envFiles = Array.isArray(include.env_file) ? include.env_file : include.env_file ? [include.env_file] : [];
        const parent = path.dirname(files[i].path);
        for (const file of envFiles) envPaths.add(path.resolve(parent, expand(file)));
        if (include.project_directory) envPaths.add(path.resolve(parent, expand(include.project_directory), '.env'));
      }
      const references = (Array.isArray(doc.include) ? doc.include : doc.include ? [doc.include] : []).flatMap(item => typeof item === 'string' ? [item] : [item.path].flat());
      for (const service of Object.values(doc.services || {})) if (service?.extends?.file) references.push(service.extends.file);
      for (const reference of references) {
        const file = path.resolve(path.dirname(files[i].path), expand(reference));
        if (visited.has(file)) continue;
        visited.add(file); envPaths.add(path.join(path.dirname(file), '.env'));
        files.push({ path: file, content: await io.read(file) });
      }
    }
    const inputs = [];
    for (const file of [...envPaths].sort()) {
      let content;
      try { content = await io.read(file); }
      catch (error) { if (error.code === 'ENOENT' || error.statusCode === 404) content = null; else throw error; }
      inputs.push({ path: file, content });
    }
    const referenced = new Set(['COMPOSE_PROFILES', 'COMPOSE_ENV_FILES', 'COMPOSE_DISABLE_ENV_FILE', 'DOCKER_DEFAULT_PLATFORM']);
    for (const file of [...files, ...inputs]) for (const match of String(file.content || '').matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) referenced.add(match[1]);
    const usedEnvironment = Object.fromEntries([...referenced].sort().map(key => [key, env[key] ?? null]));
    const identity = { projectId: project.id, projectName: project.projectName, host: project.host, hostId: project.hostId,
      workingDir: project.workingDir, composeFiles: project.composeFiles, mounted: project.mounted };
    return { fingerprint: digest({ identity, files, inputs, usedEnvironment, effective }), effective, files: files.map(file => file.path) };
  };
  if (deps.io) return capture(deps.io);
  if (project.mounted) return capture({ config: args => localConfig(project, args), read: (file, index) => index !== undefined ? readCompose(project, index).then(result => result.content) : readFile(file, 'utf8') });
  return withRunner(project, runner => capture({
    config: async args => commandResult(await execInRunner(runner, ['docker', 'compose', ...composeProjectOptions(project), 'config', ...args], { timeoutMs: 30000 })),
    read: async file => (await readArchiveFile(runner, file)).content,
  }));
}

export async function createDeploymentReview(project, deps = {}) {
  const activeHostId = deps.activeHostId || getActiveHostId;
  const hostId = activeHostId();
  checkProject(project, hostId, activeHostId);
  const capture = deps.capture || captureDeploymentInputs;
  const first = await capture(project);
  const snapshot = await capture(project);
  checkProject(project, hostId, activeHostId);
  if (first.fingerprint !== snapshot.fingerprint) throw conflict();
  const content = YAML.stringify(snapshot.effective);
  const issues = validateComposeSemantics(content);
  const preview = await (deps.preview || createComposeChangePreview)(content, project, null, deps.docker || getProjectDocker(project));
  const safe = structuredClone(snapshot.effective);
  harvestSecretValues(JSON.stringify(safe));
  // Environment and build args can hold secrets even under ordinary names.
  for (const service of Object.values(safe.services || {})) {
    if (service.environment) service.environment = Object.fromEntries(Object.keys(service.environment).map(key => [key, '[REDACTED]']));
    if (service.build?.args) service.build.args = Object.fromEntries(Object.keys(service.build.args).map(key => [key, '[REDACTED]']));
  }
  const now = Date.now();
  for (const [token, entry] of reviews) if (entry.expiresAt <= now) reviews.delete(token);
  while (reviews.size >= 200) reviews.delete(reviews.keys().next().value);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + TTL;
  reviews.set(token, { projectId: project.id, hostId, fingerprint: snapshot.fingerprint, expiresAt });
  return { token, hostId, projectId: project.id, projectName: project.projectName, files: snapshot.files, expiresAt,
    content: YAML.stringify(redactSecretValue(safe)), issues: redactSecretValue(issues), preview: redactSecretValue(preview) };
}

/** Optional intent for regular actions, mandatory opaque token for a reviewed deployment. Checked again under the operation lock. */
export async function assertReviewedDeployment(project, action, review, deps = {}) {
  if (review.reviewToken === undefined && review.expectedContent === undefined && review.expectedHostId === undefined) return;
  if (action !== 'up' || typeof review.reviewToken !== 'string' || !review.reviewToken) {
    throw Object.assign(new Error('评审部署需要完整配置评审凭据，请重新评审'), { statusCode: 400 });
  }
  const entry = reviews.get(review.reviewToken);
  if (!entry || entry.expiresAt <= Date.now() || entry.projectId !== project.id) throw conflict();
  const activeHostId = deps.activeHostId || getActiveHostId;
  checkProject(project, entry.hostId, activeHostId);
  const snapshot = await (deps.capture || captureDeploymentInputs)(project);
  checkProject(project, entry.hostId, activeHostId);
  if (snapshot.fingerprint !== entry.fingerprint) throw conflict();
  if (deps.consume) reviews.delete(review.reviewToken);
}
