/**
 * GitOps 集成服务
 * 
 * 功能：
 * - Git 仓库自动同步（docker-compose.yml、.env 文件）
 * - 变更自动部署（检测到提交后自动拉取并重启服务）
 * - 版本回滚（通过 Git 历史快速回退到任意版本）
 * - 多环境配置（dev/staging/prod 分支映射）
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import path, { join } from 'node:path';
import { getSetting, setSetting } from '../lib/db.js';
import { sendNotification } from './notifications.js';

const execFileAsync = promisify(execFile);

const GITOPS_CONFIG_KEY = 'gitops.repositories';
const POLL_INTERVAL_KEY = 'gitops.poll_interval';
const DEFAULT_POLL_INTERVAL = 300; // 5 分钟
// git fetch/clone 大仓库耗时不可预估:异步执行 + 兜底超时杀进程,
// 替代会冻结整个事件循环(含 health check)的 execFileSync。
const GIT_TIMEOUT_MS = 120_000;

const activeWatchers = new Map(); // repoId -> { interval, syncing }

const SAFE_BRANCH = /^(?![./])(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._/-]{0,99}(?<![./])$/;
const SAFE_COMMIT = /^[0-9a-f]{7,40}$/i;
// 仓库 URL 协议白名单:数组参数防住了 shell 注入,但防不住 git 自带的
// ext:: 传输(ext::sh -c <cmd> 会在 clone 时执行任意命令),必须在入口挡掉。
const SAFE_REPO_URL = /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/i;

function validateRepoUrl(value) {
  const url = String(value || '').trim();
  if (!SAFE_REPO_URL.test(url)) {
    throw Object.assign(new Error('仓库 URL 仅支持 http(s)://、ssh:// 或 git@ 形式'), { statusCode: 400 });
  }
  // URL 中的 userinfo 会被持久化并经仓库配置 API 返回，禁止把密码/令牌嵌入 URL。
  if (/^(https?:\/\/|ssh:\/\/)/i.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw Object.assign(new Error('仓库 URL 格式不合法'), { statusCode: 400 });
    }
    const isHttp = /^https?:\/\//i.test(url);
    if (parsed.password || (isHttp && parsed.username)) {
      throw Object.assign(new Error('仓库 URL 不允许包含用户名或密码，请改用 SSH 或其他安全凭据配置'), { statusCode: 400 });
    }
  }
  return url;
}

function validateGitRef(value, label = '分支') {
  const ref = String(value || '');
  if (!SAFE_BRANCH.test(ref)) throw Object.assign(new Error(label + '格式不合法'), { statusCode: 400 });
  return ref;
}

function validateLocalPath(value) {
  const localPath = String(value || '');
  if (!localPath || localPath.includes('\0') || !path.isAbsolute(localPath)) {
    throw Object.assign(new Error('本地路径必须是绝对路径且不能包含非法字符'), { statusCode: 400 });
  }
  return path.normalize(localPath);
}

function validateSshKey(value) {
  if (!value) return null;
  const sshKey = String(value);
  if (sshKey.includes('\0') || !path.isAbsolute(sshKey)) {
    throw Object.assign(new Error('SSH 私钥路径必须是绝对路径'), { statusCode: 400 });
  }
  return path.normalize(sshKey);
}

function gitEnv(sshKey) {
  if (!sshKey) return process.env;
  const quoted = "'" + sshKey.replaceAll("'", "'\\\\''") + "'";
  return { ...process.env, GIT_SSH_COMMAND: 'ssh -i ' + quoted + ' -o StrictHostKeyChecking=accept-new' };
}

async function runGit(args, options = {}) {
  const { timeout = GIT_TIMEOUT_MS, ...rest } = options;
  const result = await execFileAsync('git', args, { timeout, killSignal: 'SIGKILL', ...rest });
  return result.stdout;
}

/** 防止同一仓库的自动同步在上一轮未结束时被下一轮并发触发(git 操作竞态)。 */
function withSyncGuard(repoId, fn) {
  const watcher = activeWatchers.get(repoId);
  if (watcher?.syncing) return null;
  if (watcher) watcher.syncing = true;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (watcher) watcher.syncing = false;
    });
}

/**
 * 读取 GitOps 配置
 * @returns {Array<{id, name, url, branch, localPath, projectId, autoSync, sshKey, lastSync, lastCommit}>}
 */
export function listGitOpsRepos() {
  try {
    const raw = getSetting(GITOPS_CONFIG_KEY, '[]');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * 保存 GitOps 配置
 */
function saveGitOpsRepos(repos) {
  setSetting(GITOPS_CONFIG_KEY, JSON.stringify(repos));
}

/**
 * 添加 Git 仓库
 * @param {{name, url, branch, localPath, projectId, autoSync, sshKey}} config
 */
export function addGitOpsRepo(config) {
  const { name, url: rawUrl, branch = 'main', localPath, projectId, autoSync = false, sshKey } = config;

  if (!name || !rawUrl || !localPath || !projectId) {
    throw Object.assign(new Error('仓库名称、URL、本地路径、项目 ID 均为必填'), { statusCode: 400 });
  }

  const url = validateRepoUrl(rawUrl);
  const normalizedPath = validateLocalPath(localPath);
  const normalizedBranch = validateGitRef(branch);
  const normalizedSshKey = validateSshKey(sshKey);
  const repos = listGitOpsRepos();
  const id = `gitops_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  // 验证本地路径不冲突
  if (repos.some((repo) => repo.localPath && path.resolve(repo.localPath) === normalizedPath)) {
    throw Object.assign(new Error('本地路径已被其他 GitOps 仓库占用'), { statusCode: 400 });
  }

  const repo = {
    id,
    name,
    url,
    branch: normalizedBranch,
    localPath: normalizedPath,
    projectId,
    autoSync,
    sshKey: normalizedSshKey,
    lastSync: null,
    lastCommit: null,
    status: 'pending',
  };

  repos.push(repo);
  saveGitOpsRepos(repos);

  // 如果启用自动同步，立即启动 watcher
  if (autoSync) {
    startRepoWatcher(repo);
  }

  return repo;
}

/**
 * 更新 Git 仓库配置
 */
export function updateGitOpsRepo(id, updates) {
  const repos = listGitOpsRepos();
  const index = repos.findIndex((r) => r.id === id);
  
  if (index < 0) {
    throw Object.assign(new Error('GitOps 仓库不存在'), { statusCode: 404 });
  }

  const oldRepo = repos[index];
  const normalizedUpdates = { ...updates };
  if (Object.hasOwn(normalizedUpdates, 'url')) normalizedUpdates.url = validateRepoUrl(normalizedUpdates.url);
  if (Object.hasOwn(normalizedUpdates, 'branch')) normalizedUpdates.branch = validateGitRef(normalizedUpdates.branch);
  if (Object.hasOwn(normalizedUpdates, 'localPath')) normalizedUpdates.localPath = validateLocalPath(normalizedUpdates.localPath);
  if (Object.hasOwn(normalizedUpdates, 'sshKey')) normalizedUpdates.sshKey = validateSshKey(normalizedUpdates.sshKey);
  if (normalizedUpdates.localPath && repos.some((repo, repoIndex) => repoIndex !== index && repo.localPath && path.resolve(repo.localPath) === normalizedUpdates.localPath)) {
    throw Object.assign(new Error('本地路径已被其他 GitOps 仓库占用'), { statusCode: 400 });
  }
  const newRepo = { ...oldRepo, ...normalizedUpdates, id: oldRepo.id }; // 禁止修改 id
  
  repos[index] = newRepo;
  saveGitOpsRepos(repos);

  // 自动同步状态变化时，重启或停止 watcher
  if (oldRepo.autoSync !== newRepo.autoSync) {
    if (newRepo.autoSync) {
      startRepoWatcher(newRepo);
    } else {
      stopRepoWatcher(id);
    }
  }

  return newRepo;
}

/**
 * 删除 Git 仓库
 */
export function deleteGitOpsRepo(id) {
  const repos = listGitOpsRepos();
  const index = repos.findIndex((r) => r.id === id);
  
  if (index < 0) {
    throw Object.assign(new Error('GitOps 仓库不存在'), { statusCode: 404 });
  }

  stopRepoWatcher(id);
  repos.splice(index, 1);
  saveGitOpsRepos(repos);

  return { ok: true };
}

/**
 * 克隆或拉取仓库
 */
export async function syncGitOpsRepo(id) {
  const repos = listGitOpsRepos();
  const repo = repos.find((r) => r.id === id);
  
  if (!repo) {
    throw Object.assign(new Error('GitOps 仓库不存在'), { statusCode: 404 });
  }

  const url = validateRepoUrl(repo.url);
  const branch = validateGitRef(repo.branch);
  const localPath = validateLocalPath(repo.localPath);
  const sshKey = validateSshKey(repo.sshKey);
  const gitDir = join(localPath, '.git');
  const env = gitEnv(sshKey);

  try {
    // 如果本地仓库不存在，执行 clone
    if (!existsSync(gitDir)) {
      mkdirSync(localPath, { recursive: true });
      await runGit(['clone', '--branch', branch, '--', url, localPath], { env });
    } else {
      // 已存在则执行 pull
      await runGit(['-C', localPath, 'fetch', 'origin', branch], { env });
      await runGit(['-C', localPath, 'reset', '--hard', 'origin/' + branch], { env });
    }

    // 读取最新 commit
    const commit = (await runGit(['-C', localPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8', env })).trim();
    const commitMsg = (await runGit(['-C', localPath, 'log', '-1', '--pretty=%B'], { encoding: 'utf-8', env })).trim();

    // 更新配置
    repo.lastSync = new Date().toISOString();
    repo.lastCommit = commit;
    repo.status = 'synced';
    saveGitOpsRepos(repos);

    return { ok: true, commit, message: commitMsg, syncedAt: repo.lastSync };
  } catch (error) {
    repo.status = 'error';
    repo.lastError = error.message;
    saveGitOpsRepos(repos);
    throw Object.assign(new Error(`Git 同步失败: ${error.message}`), { statusCode: 502 });
  }
}

/**
 * 获取 Git 历史提交记录
 */
export async function getGitOpsHistory(id, limit = 20) {
  const repos = listGitOpsRepos();
  const repo = repos.find((r) => r.id === id);
  
  if (!repo) {
    throw Object.assign(new Error('GitOps 仓库不存在'), { statusCode: 404 });
  }

  const localPath = validateLocalPath(repo.localPath);
  const gitDir = join(localPath, '.git');

  if (!existsSync(gitDir)) {
    return { commits: [] };
  }

  try {
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
    const log = await runGit([
      '-C', localPath, 'log', '-' + safeLimit,
      '--pretty=format:%H|%an|%ae|%ad|%s', '--date=iso'
    ], { encoding: 'utf-8' });

    const commits = log.split('\n').filter(Boolean).map((line) => {
      const [hash, author, email, date, ...messageParts] = line.split('|');
      return { hash, author, email, date, message: messageParts.join('|') };
    });

    return { commits };
  } catch (error) {
    throw Object.assign(new Error(`读取 Git 历史失败: ${error.message}`), { statusCode: 502 });
  }
}

/**
 * 回滚到指定 commit
 */
export async function rollbackGitOpsRepo(id, commitHash) {
  const repos = listGitOpsRepos();
  const repo = repos.find((r) => r.id === id);
  
  if (!repo) {
    throw Object.assign(new Error('GitOps 仓库不存在'), { statusCode: 404 });
  }

  const localPath = validateLocalPath(repo.localPath);
  const commit = String(commitHash || '');
  if (!SAFE_COMMIT.test(commit)) {
    throw Object.assign(new Error('提交 ID 格式不合法'), { statusCode: 400 });
  }
  const sshKey = validateSshKey(repo.sshKey);
  const env = gitEnv(sshKey);

  try {
    await runGit(['-C', localPath, 'checkout', '--detach', commit], { env });

    const commitMsg = (await runGit(['-C', localPath, 'log', '-1', '--pretty=%B'], { encoding: 'utf-8', env })).trim();

    repo.lastSync = new Date().toISOString();
    repo.lastCommit = commit;
    repo.status = 'synced';
    saveGitOpsRepos(repos);

    await sendNotification(
      'GitOps 版本回滚',
      `仓库 ${repo.name} 已回滚到提交 ${commit.slice(0, 7)}: ${commitMsg}`
    );

    return { ok: true, commit, message: commitMsg };
  } catch (error) {
    throw Object.assign(new Error(`版本回滚失败: ${error.message}`), { statusCode: 502 });
  }
}

/**
 * 启动仓库自动同步监听
 */
function startRepoWatcher(repo) {
  if (activeWatchers.has(repo.id)) {
    return; // 已在运行
  }

  const pollInterval = Number(getSetting(POLL_INTERVAL_KEY, String(DEFAULT_POLL_INTERVAL))) * 1000;

  const interval = setInterval(() => {
    withSyncGuard(repo.id, async () => {
      try {
        // 每轮重新读取配置:闭包里的 repo 是启动时的旧对象,lastCommit 永远停在
        // 启动时刻,而 syncGitOpsRepo 更新落库的是每次重新解析的新对象——
        // 若用闭包对象比较,首次检测到新提交后每个轮询周期都会重复通知。
        const current = listGitOpsRepos().find((item) => item.id === repo.id);
        if (!current) {
          stopRepoWatcher(repo.id); // 仓库已被删除,watcher 自行退出
          return;
        }
        const previousCommit = current.lastCommit ?? null;
        const result = await syncGitOpsRepo(repo.id);
        if (result.ok && result.commit !== previousCommit) {
          await sendNotification(
            'GitOps 自动同步',
            `仓库 ${current.name} 检测到新提交 ${result.commit.slice(0, 7)}: ${result.message}`
          );
        }
      } catch (error) {
        console.error(`[GitOps] 自动同步失败 (${repo.name}):`, error.message);
      }
    });
  }, pollInterval);
  // 让 interval 不阻塞进程退出;真正的同步由 setTimeout 调度,不复用该 interval。
  interval.unref();

  activeWatchers.set(repo.id, { interval });
}

/**
 * 停止仓库自动同步监听
 */
function stopRepoWatcher(repoId) {
  const watcher = activeWatchers.get(repoId);
  if (watcher) {
    clearInterval(watcher.interval);
    activeWatchers.delete(repoId);
  }
}

/**
 * 初始化 GitOps 服务（启动所有自动同步仓库的 watcher）
 */
export function initGitOps() {
  const repos = listGitOpsRepos();
  for (const repo of repos) {
    if (repo.autoSync) {
      startRepoWatcher(repo);
    }
  }
}

/**
 * 停止所有 GitOps watcher
 */
export function stopAllGitOpsWatchers() {
  for (const [repoId] of activeWatchers) {
    stopRepoWatcher(repoId);
  }
}
