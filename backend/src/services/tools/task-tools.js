/**
 * 后台任务域工具注册(task.list / task.output / task.stop)。
 * 配合 compose.up/compose.pull 的 background 参数使用:
 * 长构建/拉取转后台立即返回,用 task.output 等待或读取,
 * 任务完成后同会话下一轮也会自动搭车提醒。
 */
import { getBackgroundTask, listBackgroundTasks, stopBackgroundTask, waitForTaskOutput } from '../agent/background-tasks.js';

function assertTaskOwner(taskId, context) {
  const task = getBackgroundTask(taskId);
  if (!task) throw new Error('后台任务不存在');
  if (context.sessionId && Number(task.sessionId) !== Number(context.sessionId)) throw new Error('后台任务不属于当前会话');
  return task;
}

export function registerTaskTools(agent) {
  agent
    .registerTool('task.list', {
      description: '列出当前会话的后台任务(compose.up/pull background=true 启动的构建、拉取等)及状态',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: { type: 'object', properties: {} },
      execute: async (_params, context) => ({ tasks: listBackgroundTasks(context.sessionId) }),
    })
    .registerTool('task.output', {
      description: '读取后台任务输出;任务未完成时可阻塞等待(默认最多 120 秒,上限 300 秒),返回尾部 20000 字符',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '后台任务 ID' },
          waitMs: { type: 'number', description: '未完成时最长等待毫秒数(默认 120000)' },
        },
        required: ['taskId'],
      },
      execute: async (params, context) => {
        assertTaskOwner(params.taskId, context);
        const waitMs = Math.min(Math.max(Number(params.waitMs ?? 120000), 0), 300000);
        return waitForTaskOutput(params.taskId, waitMs);
      },
    })
    .registerTool('task.stop', {
      description: '终止一个仍在运行的后台任务。compose 模式会 SIGTERM,5 秒后 SIGKILL;workspace 模式只断开执行流;仅控制已有容器时标记终止,系统调用会自行结束',
      category: 'maintenance',
      requiredPermission: 'managed',
      confirmationRequired: true,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '后台任务 ID' }, projectId: { type: 'string', minLength: 1, description: 'task.list 返回的项目 ID' } },
        required: ['taskId', 'projectId'],
      },
      execute: async (params, context) => {
        const task = assertTaskOwner(params.taskId, context);
        if (task.projectId !== context.projectId || task.hostId !== context.hostId) throw new Error('后台任务不属于指定项目或节点');
        const result = stopBackgroundTask(params.taskId);
        return { ...result, taskId: params.taskId };
      },
    });
  return agent;
}
