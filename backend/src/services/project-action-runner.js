import { ACTIONS, resolveProjectFile, spawnCompose } from './compose-runner.js';
import { runWorkspaceCompose } from './compose-workspace.js';
import { runContainerAction, supportsContainerAction } from './project-control.js';
import { withProjectOperationLock } from './project-operation-lock.js';
import { invalidateScanCache } from './scanner.js';

export function assertProjectActionAllowed(project, action) {
  if (!Object.hasOwn(ACTIONS, action)) {
    throw Object.assign(new Error('不支持的项目操作'), { statusCode: 400 });
  }
  if (!project.managed) throw Object.assign(new Error('项目尚未加入管理'), { statusCode: 403 });
  if (!project.mountEnabled && !supportsContainerAction(action)) {
    throw Object.assign(new Error('尚未为该项目启用 Compose 目录能力'), { statusCode: 403 });
  }
  if (project.mountEnabled && !project.editable && !supportsContainerAction(action)) {
    throw Object.assign(new Error('Compose 项目路径缺失或权限范围过宽，无法安全挂载'), { statusCode: 409 });
  }
}

export async function prepareProjectAction(project, action) {
  assertProjectActionAllowed(project, action);
  if (project.editable && project.mounted) {
    const safeFiles = await Promise.all(project.composeFiles.map((_, index) => resolveProjectFile(project, index)));
    return {
      mode: 'compose',
      // options.timeoutMs:后台任务(compose background=true)需要放宽超时,前台保持 5 分钟默认。
      run(onOutput = () => {}, onChild = () => {}, options = {}) {
        return withProjectOperationLock(project.id, () => new Promise((resolve, reject) => {
          const child = spawnCompose({ ...project, composeFiles: safeFiles }, action);
          onChild(child);
          child.stdout.on('data', (chunk) => onOutput('stdout', chunk.toString('utf8')));
          child.stderr.on('data', (chunk) => onOutput('stderr', chunk.toString('utf8')));
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
          }, options.timeoutMs || 300000);
          child.on('error', (error) => { clearTimeout(timer); reject(error); });
          child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve(signal ? 124 : code ?? 1);
          });
        })).finally(invalidateScanCache);
      },
    };
  }
  if (project.editable) {
    // workspace 模式跑在 runner 容器的 docker exec 里,没有本地子进程;
    // onExec 把断流式伪停止句柄包成 child.kill 形态交给后台任务管理器。
    return {
      mode: 'workspace',
      run(onOutput = () => {}, onChild = () => {}, options = {}) {
        return withProjectOperationLock(project.id, () => runWorkspaceCompose(project, action, onOutput, {
          timeoutMs: options.timeoutMs,
          onExec: (handle) => onChild(handle),
        })).finally(invalidateScanCache);
      },
    };
  }
  // containers 模式走 dockerode API(无子进程),task.stop 只能标记终止,动作会自然结束。
  return { mode: 'containers', run: (onOutput = () => {}) => withProjectOperationLock(project.id, () => runContainerAction(project, action, onOutput)).finally(invalidateScanCache) };
}
