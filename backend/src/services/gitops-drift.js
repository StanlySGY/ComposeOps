import { recordAlertEventAndNotify } from './events.js';
/**
 * GitOps drift 检测:只读对比"生产状态"与"Git 远端"的差异,不执行任何变更。
 *
 * 三个信号(全部基于 git,不依赖 Docker,远程节点同样可用):
 * 1. workingTree —— 本地 checkout(即生产 compose/.env 所在目录)存在未提交改动:
 *    说明有人在生产环境手改过文件但没有进 Git → 生产与仓库漂移。
 * 2. behindRemote —— 本地 HEAD 落后 origin/<branch>:远端有新提交但还没同步。
 * 3. detached —— 本地处于 detached HEAD(gitops.rollback 之后):后续无法按分支同步。
 *
 * 修复建议只给"可执行的下一步",变化动作(sync/restore/up)一律交给 Agent 确认门或用户。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { listGitOpsRepos } from './gitops.js';

const SAFE_BRANCH = /^(?![./])(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._/-]{0,99}(?<![./])$/;

function validateLocalPath(value) {
  const localPath = String(value || '');
  if (!localPath || !isAbsolute(localPath) || localPath.includes('\0')) {
    throw Object.assign(new Error('本地路径必须是绝对路径'), { statusCode: 400 });
  }
  return normalize(localPath);
}

/** 与 gitops.js 相同的 SSH env 构造(密钥路径做 shell 转义)。 */
function gitEnv(sshKey) {
  if (!sshKey) return process.env;
  const quoted = "'" + sshKey.replaceAll("'", "'\\\\''") + "'";
  return { ...process.env, GIT_SSH_COMMAND: `ssh -i ${quoted} -o StrictHostKeyChecking=accept-new` };
}

function runGit(repo, args, options = {}) {
  const env = gitEnv(repo.sshKey);
  return execFileSync('git', ['-C', repo.localPath, ...args], { stdio: 'pipe', ...options, env });
}

/** 读取远端分支的最新提交(引用不存在时退化为本地 HEAD,仍不存在返回 null)。 */
function readRemoteHead(repo) {
  const branch = String(repo.branch || 'main');
  if (!SAFE_BRANCH.test(branch)) return null;
  try {
    return runGit(repo, ['rev-parse', `origin/${branch}`]).toString('utf8').trim();
  } catch {
    try {
      return runGit(repo, ['rev-parse', 'HEAD']).toString('utf8').trim();
    } catch {
      return null;
    }
  }
}

/**
 * 扫描单个仓库的 drift。
 * @returns {Promise<{repoId, repoName, status, headCommit, remoteCommit, behind, detached, branch, drifts: Array, summary, scannedAt}>}
 */
export async function scanRepoDrift(repo) {
  const result = {
    repoId: repo.id,
    repoName: repo.name,
    status: 'clean',
    headCommit: null,
    remoteCommit: null,
    behind: 0,
    detached: false,
    branch: null,
    drifts: [],
  };

  const localPath = validateLocalPath(repo.localPath);
  repo.localPath = localPath;
  if (!existsSync(join(localPath, '.git'))) {
    result.status = 'not_cloned';
    result.summary = '本地仓库尚未克隆,首次执行同步后即可参与漂移检测。';
    result.scannedAt = new Date().toISOString();
  if (result.status !== 'clean') recordAlertEventAndNotify({ key: `gitops-drift:${repo.id}`, title: `GitOps 漂移 · ${repo.name}`, detail: result.summary, priority: 'warning', to: `/gitops?repo=${encodeURIComponent(repo.id)}&from=events` });
    return result;
  }

  try {
    result.headCommit = runGit(repo, ['rev-parse', 'HEAD']).toString('utf8').trim();
  } catch {
    result.headCommit = null;
  }

  try {
    result.branch = runGit(repo, ['symbolic-ref', '--short', 'HEAD']).toString('utf8').trim();
    result.detached = false;
  } catch {
    result.detached = true;
  }

  // 未提交改动(只看已跟踪文件;untracked 通常是部署产物等非版本文件,不视为漂移)
  try {
    const changes = runGit(repo, ['status', '--porcelain', '--untracked-files=no']).toString('utf8');
    for (const line of changes.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const file = trimmed.slice(2).trim();
      if (!file) continue;
      const code = trimmed.slice(0, 2).trim();
      result.drifts.push({ type: (code === 'D' || code === 'RD') ? 'deleted' : 'modified', file });
    }
  } catch {
    // git status 失败不影响其余信号
  }

  const remoteHead = readRemoteHead(repo);
  result.remoteCommit = remoteHead;
  if (result.headCommit && result.remoteCommit && result.remoteCommit !== result.headCommit) {
    try {
      const out = runGit(repo, ['rev-list', '--count', `${result.headCommit}..${result.remoteCommit}`]);
      result.behind = Number(out.toString('utf8').trim()) || 0;
    } catch {
      result.behind = 0;
    }
  }

  result.status = result.detached ? 'detached'
    : result.drifts.length > 0 ? 'diverged'
      : result.behind > 0 ? 'behind'
        : 'clean';
  result.summary = summarizeDrift(result);
  result.scannedAt = new Date().toISOString();
  if (result.status !== 'clean') recordAlertEventAndNotify({ key: `gitops-drift:${repo.id}`, title: `GitOps 漂移 · ${repo.name}`, detail: result.summary, priority: 'warning', to: `/gitops?repo=${encodeURIComponent(repo.id)}&from=events` });
  return result;
}

function summarizeDrift(drift) {
  const parts = [];
  if (drift.drifts.length) {
    const names = drift.drifts.slice(0, 5).map((item) => item.file).join('、');
    parts.push(`${drift.drifts.length} 处文件与 Git 不一致(${names}${drift.drifts.length > 5 ? ' 等' : ''})`);
  }
  if (drift.behind > 0) parts.push(`落后远端 ${drift.behind} 个提交`);
  if (drift.detached) parts.push('处于 detached HEAD,需切回分支');
  return parts.length ? parts.join('; ') : '生产状态与 Git 远端一致,无漂移';
}

/** 修复建议(只读):给 Agent / 前端展示"下一步该做什么",不自动执行。 */
export function planDriftRepair(drift) {
  const steps = [];
  if (drift.detached) {
    steps.push({ action: 'checkout', tool: 'gitops.sync', description: `仓库处于 detached HEAD,先执行同步按分支拉齐后再继续。` });
  }
  if (drift.drifts.length) {
    const files = drift.drifts.slice(0, 5).map((item) => item.file).join('、');
    steps.push({
      action: 'commit-or-restore',
      tool: null,
      description: `以下已跟踪文件与 Git 不一致:${files}。若为有意修改,请提交到仓库(生成修复 PR);若为误改,可放弃本地改动回到远端版本。`,
    });
  }
  if (drift.behind > 0) {
    steps.push({ action: 'sync', tool: 'gitops.sync', description: `本地落后远端 ${drift.behind} 个提交,执行同步把生产拉齐到远端版本。` });
  }
  if (!steps.length) {
    steps.push({ action: 'none', tool: null, description: '无漂移,无需处理。' });
  }
  return steps;
}

/** 扫描全部仓库的 drift(单个仓库失败只降级为一条记录,不中断)。 */
export async function scanAllRepoDrift() {
  const repos = listGitOpsRepos();
  const results = [];
  for (const repo of repos) {
    try {
      results.push(await scanRepoDrift(repo));
    } catch (error) {
      results.push({
        repoId: repo.id,
        repoName: repo.name,
        status: 'error',
        headCommit: null,
        remoteCommit: null,
        behind: 0,
        detached: false,
        branch: null,
        drifts: [],
        summary: `扫描失败:${error.message}`,
        scannedAt: new Date().toISOString(),
      });
    }
  }
  const counts = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  return { repos: results, counts, scannedAt: new Date().toISOString() };
}

/** 全量扫描 + 修复建议(Agent 工具 / 页面共用)。 */
export async function planAllRepoDrift() {
  const scan = await scanAllRepoDrift();
  return scan.repos.map((result) => ({ ...result, repairs: planDriftRepair(result) }));
}