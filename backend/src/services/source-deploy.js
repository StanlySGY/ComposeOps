import { redactSecrets } from '../lib/secret-redactor.js';
import { assertProjectHostUnchanged } from './docker-hosts.js';
import { execInRunner, withRunner } from './compose-workspace.js';
import { composeProjectOptions } from './compose-runner.js';
import { withProjectOperationLock } from './project-operation-lock.js';

const GIT_TIMEOUT_MS = 120_000;
const COMPOSE_CONFIG_TIMEOUT_MS = 60_000;
const COMPOSE_BUILD_TIMEOUT_MS = 15 * 60_000;

function outputText(result) {
  return redactSecrets(String(result?.stderr || result?.stdout || '')).trim().slice(-4000);
}

async function runChecked(runCommand, onOutput, label, args, timeoutMs) {
  onOutput('stdout', '\n[' + label + '] ' + args.join(' ') + '\n');
  const result = await runCommand(args, { timeoutMs });
  if (result.code !== 0) {
    const detail = outputText(result);
    throw Object.assign(
      new Error(label + '失败 (exit ' + (result.code ?? 'unknown') + ')' + (detail ? '：\n' + detail : '')),
      { statusCode: 422, code: 'SOURCE_DEPLOY_STEP_FAILED', stage: label },
    );
  }
  return result;
}

/**
 * 执行源码更新闭环的确定性步骤。runCommand 注入点使 Git/Compose 顺序可在
 * 不连接 Docker daemon、不触碰真实仓库的情况下验证。
 */
export async function executeSourceDeployment(project, { runCommand, onOutput = () => {} } = {}) {
  if (typeof runCommand !== 'function') throw new TypeError('runCommand 必须是函数');
  const root = String(project?.workingDir || '');
  if (!root.startsWith('/')) throw Object.assign(new Error('项目工作目录不是安全的绝对路径'), { statusCode: 409 });
  if (!Array.isArray(project.composeFiles) || project.composeFiles.length === 0) {
    throw Object.assign(new Error('项目没有可用的 Compose 文件'), { statusCode: 409 });
  }

  // withRunner 已校验项目真实路径；仅信任本次命令的这一个仓库。
  const git = (...args) => ['git', '-c', `safe.directory=${root}`, '-C', root, ...args];
  const rootResult = await runChecked(runCommand, onOutput, '检查 Git 仓库根目录', git('rev-parse', '--show-prefix'), GIT_TIMEOUT_MS);
  const repoPrefix = String(rootResult.stdout || '').trim();
  if (repoPrefix) {
    throw Object.assign(new Error('项目工作目录位于 Git 仓库子目录中；为避免拉取整个父仓库，请将 Compose 项目工作目录设置为 Git 仓库根目录'), { statusCode: 409, code: 'SOURCE_DEPLOY_REPOSITORY_ROOT_MISMATCH' });
  }

  const branchResult = await runChecked(runCommand, onOutput, '检查当前分支', git('branch', '--show-current'), GIT_TIMEOUT_MS);
  const branch = String(branchResult.stdout || '').trim();
  if (!branch) throw Object.assign(new Error('当前处于 detached HEAD，无法安全执行 git pull；请先切回跟踪分支'), { statusCode: 409, code: 'SOURCE_DEPLOY_DETACHED_HEAD' });

  onOutput('stdout', '\n[检查远端跟踪分支]\n');
  const upstreamResult = await runCommand(git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'), { timeoutMs: GIT_TIMEOUT_MS });
  const upstream = String(upstreamResult.stdout || '').trim();
  if (upstreamResult.code !== 0 || !upstream) {
    throw Object.assign(new Error('当前分支没有可用的 upstream，无法执行 git pull'), { statusCode: 409, code: 'SOURCE_DEPLOY_NO_UPSTREAM' });
  }
  onOutput('stdout', '当前分支：' + branch + ' → ' + upstream + '\n');

  const statusResult = await runChecked(runCommand, onOutput, '检查工作区是否干净', git('status', '--porcelain=v1', '--untracked-files=all'), GIT_TIMEOUT_MS);
  const dirtyEntries = String(statusResult.stdout || '').trim().split('\n').filter(Boolean);
  if (dirtyEntries.length) {
    const preview = dirtyEntries.slice(0, 20).join('\n');
    const remaining = dirtyEntries.length > 20 ? '\n……另有 ' + (dirtyEntries.length - 20) + ' 项' : '';
    throw Object.assign(
      new Error('Git 工作区存在未提交或未跟踪文件，已停止更新。请先自行处理这些文件后重试：\n' + preview + remaining),
      { statusCode: 409, code: 'SOURCE_DEPLOY_WORKTREE_DIRTY' },
    );
  }

  const beforeResult = await runChecked(runCommand, onOutput, '记录更新前版本', git('rev-parse', 'HEAD'), GIT_TIMEOUT_MS);
  const beforeCommit = String(beforeResult.stdout || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(beforeCommit)) {
    throw Object.assign(new Error('无法读取更新前的 Git commit，已停止部署'), { statusCode: 409, code: 'SOURCE_DEPLOY_INVALID_HEAD' });
  }

  await runChecked(runCommand, onOutput, '拉取源码 (git pull --ff-only)', git('pull', '--ff-only'), GIT_TIMEOUT_MS);

  const afterResult = await runChecked(runCommand, onOutput, '记录更新后版本', git('rev-parse', 'HEAD'), GIT_TIMEOUT_MS);
  const afterCommit = String(afterResult.stdout || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(afterCommit)) {
    throw Object.assign(new Error('git pull 后无法确认当前 commit，已停止 Compose 构建'), { statusCode: 409, code: 'SOURCE_DEPLOY_INVALID_HEAD' });
  }
  onOutput('stdout', '拉取后的版本：' + beforeCommit.slice(0, 7) + ' → ' + afterCommit.slice(0, 7) + '\n');
  const postPullStatus = await runChecked(runCommand, onOutput, '复查拉取后的工作区', git('status', '--porcelain=v1', '--untracked-files=all'), GIT_TIMEOUT_MS);
  if (String(postPullStatus.stdout || '').trim()) {
    throw Object.assign(new Error('git pull 后工作区出现额外修改，已停止 Compose 构建；请人工检查，不会自动清理'), { statusCode: 409, code: 'SOURCE_DEPLOY_POST_PULL_DIRTY' });
  }

  const compose = ['docker', 'compose', '--project-directory', root, ...composeProjectOptions(project, project.composeFiles)];
  await runChecked(runCommand, onOutput, '校验 Compose 配置', [...compose, 'config', '--quiet'], COMPOSE_CONFIG_TIMEOUT_MS);
  await runChecked(runCommand, onOutput, '构建并启动服务 (docker compose up -d --build)', [...compose, 'up', '-d', '--build'], COMPOSE_BUILD_TIMEOUT_MS);

  const result = { branch, upstream, beforeCommit, afterCommit, updated: beforeCommit !== afterCommit };
  onOutput('stdout', '\n源码更新与 Compose 构建启动命令已完成。\n分支：' + branch + ' (' + upstream + ')\n版本：' + beforeCommit.slice(0, 7) + ' → ' + afterCommit.slice(0, 7) + '\n请继续检查容器运行状态与应用健康情况；本操作不自动回退数据库或数据卷。\n');
  return result;
}

/** 在项目互斥锁和对应 Docker 节点的安全工作区中执行 Git + Compose。 */
export async function runSourceDeployment(project, { onOutput = () => {}, onExec } = {}) {
  return withProjectOperationLock(project.id, async () => {
    assertProjectHostUnchanged(project);
    return withRunner(project, async (runner) => {
      const result = await executeSourceDeployment(project, {
        onOutput: (stream, chunk) => onOutput(stream, redactSecrets(String(chunk ?? ''))),
        runCommand: (args, options) => execInRunner(runner, args, {
          timeoutMs: options.timeoutMs,
          onOutput: (stream, chunk) => onOutput(stream, redactSecrets(String(chunk ?? ''))),
          onExec,
        }),
      });
      assertProjectHostUnchanged(project);
      return result;
    });
  });
}
