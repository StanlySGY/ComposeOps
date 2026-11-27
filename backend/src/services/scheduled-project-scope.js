import { getProjectPreference, getProjectMountEnabled } from '../lib/db.js';
import { scanProjects } from './scanner.js';
import { assertScheduledHost, assertScheduledEngineHost, captureScheduledEngineHost } from './scheduled-host-scope.js';

export const PROJECT_JOB_TYPES = new Set(['volume-backup', 'pull-images', 'db-backup']);
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };

export function assertScheduledProjectPermission(target, type) {
  if (!PROJECT_JOB_TYPES.has(type)) fail('该任务类型不支持限定项目', 400);
  assertScheduledHost(target);
  if (!target.projectId || !target.engineId) fail('项目计划缺少固定目标，请重新创建');
  const preference = getProjectPreference(target.projectId);
  if (!preference.managed) fail('计划项目已取消纳管，已阻止执行', 403);
  if (type !== 'db-backup' && !getProjectMountEnabled(target.projectId)) fail('计划项目已关闭 Compose 目录能力，已阻止执行', 403);
}

export async function resolveScheduledProject(target, type) {
  assertScheduledProjectPermission(target, type);
  await assertScheduledEngineHost(target);
  const project = (await scanProjects(target.hostId, { background: true })).find(item => item.id === target.projectId);
  assertScheduledProjectPermission(target, type);
  if (!project || !project.managed) fail('计划项目不在固定节点上或已取消纳管');
  if (type !== 'db-backup' && !project.editable) fail('计划项目当前没有可用的 Compose 目录能力');
  return project;
}

export async function captureScheduledProject(input, type) {
  if (!input.hostId || !input.projectId) fail('项目计划必须明确选择节点与项目', 400);
  const target = { ...await captureScheduledEngineHost(input.hostId, input.connectionRevision), projectId: String(input.projectId) };
  const project = await resolveScheduledProject(target, type);
  return { ...target, projectName: project.projectName };
}

// Recheck immediately before each effect, including after waiting on a project lock.
export async function assertScheduledProject(target, type) {
  assertScheduledProjectPermission(target, type);
  await assertScheduledEngineHost(target);
  assertScheduledProjectPermission(target, type);
}
