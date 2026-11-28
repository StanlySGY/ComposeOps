/**
 * Agent 上下文/权限门模块。
 *
 * 从 agent.js 拆分 —— 只含"纯逻辑,不依赖 OperationsAgent 实例状态"的 helper:
 *  - 工具执行上下文解析(resolveToolContext: projectId/containerId → project/container)
 *  - 四档权限门(assertPermission)与轻量参数校验(validateParams)
 *
 * 被 OperationsAgent(engine.js)与 agent.test.js 复用。
 */

import { findProject, scanProjects } from '../scanner.js';
import { getActiveHostId, getHost } from '../docker-hosts.js';
import { validateToolValue } from './tool-schema.js';

/**
 * 从用户原话和当前页面事实中做确定性上下文匹配。
 * 仅在唯一明确命中时自动绑定；多个项目/服务同名时保持空上下文，交给 Agent 询问。
 */
export async function resolveImplicitContext(userMessage = '', pageContext = {}, preferredProjectId = '') {
  const allProjects = await scanProjects(pageContext?.hostId || getActiveHostId());
  return resolveImplicitContextFromProjects(userMessage, pageContext, preferredProjectId, allProjects);
}

export function resolveImplicitContextFromProjects(userMessage = '', pageContext = {}, preferredProjectId = '', allProjects = []) {
  const userText = String(userMessage || '').toLocaleLowerCase();
  const explicitProjectMatches = allProjects.filter((project) => {
    const name = String(project.projectName || project.name || '').trim().toLocaleLowerCase();
    const id = String(project.id || '').trim().toLocaleLowerCase();
    return (name.length >= 3 && userText.includes(name)) || (id.length >= 6 && userText.includes(id));
  });
  const selectedProjectId = preferredProjectId || (explicitProjectMatches.length === 1 ? explicitProjectMatches[0].id : pageContext?.projectId || '');
  const projects = selectedProjectId ? allProjects.filter((project) => project.id === selectedProjectId) : allProjects;
  if (!projects.length) return { project: null, projectId: null, container: null, serviceName: '', confidence: 'none' };
  const pageBelongsToSelectedProject = !pageContext?.projectId || projects.some((project) => project.id === pageContext.projectId);
  const page = pageBelongsToSelectedProject ? pageContext || {} : {};
  const source = [userMessage, page.summary, page.state, page.projectName, page.serviceName].filter(Boolean).join(' ').toLocaleLowerCase();
  if (!source.trim()) return { project: null, projectId: null, container: null, serviceName: '', confidence: 'none' };

  // Service mentions are bounded tokens, including short names such as api/db.
  const mentionsService = service => service.length >= 2 && new RegExp('(^|[^a-z0-9_.-])' + service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z0-9_.-])', 'i').test(userText);
  const explicitContainerHits = [];
  for (const project of projects) {
    for (const container of project.containers || []) {
      const name = String(container.name || '').trim().toLocaleLowerCase();
      const service = String(container.service || '').trim().toLocaleLowerCase();
      if ((name.length >= 5 && userText.includes(name)) || mentionsService(service)) {
        explicitContainerHits.push({ project, container });
      }
    }
  }
  if (explicitContainerHits.length === 1) {
    const hit = explicitContainerHits[0];
    return { project: hit.project, projectId: hit.project.id, container: hit.container, serviceName: hit.container.service || '', confidence: 'service' };
  }
  if (explicitContainerHits.length > 1) {
    const uniqueProjects = [...new Map(explicitContainerHits.map((hit) => [hit.project.id, hit.project])).values()];
    if (uniqueProjects.length > 1) return { project: null, projectId: null, container: null, serviceName: '', confidence: 'ambiguous', candidates: uniqueProjects.map((project) => ({ id: project.id, name: project.projectName })) };
  }

  if (page.containerId && pageBelongsToSelectedProject) {
    const pageContainerHits = projects.flatMap((project) => (project.containers || []).filter((container) => container.id === page.containerId).map((container) => ({ project, container })));
    if (pageContainerHits.length === 1) {
      const hit = pageContainerHits[0];
      return { project: hit.project, projectId: hit.project.id, container: hit.container, serviceName: hit.container.service || page.serviceName || '', confidence: 'container' };
    }
  }

  if ((preferredProjectId || explicitProjectMatches.length === 1) && projects.length === 1) {
    return { project: projects[0], projectId: projects[0].id, container: null, serviceName: '', confidence: 'project' };
  }

  const matches = [];
  for (const project of projects) {
    const projectName = String(project.projectName || project.name || '').trim().toLocaleLowerCase();
    const id = String(project.id || '').trim().toLocaleLowerCase();
    let score = 0;
    if (projectName.length >= 3 && source.includes(projectName)) score = 100;
    else if (id.length >= 6 && source.includes(id)) score = 95;
    else {
      const hits = [];
      for (const container of project.containers || []) {
        const name = String(container.name || '').trim().toLocaleLowerCase();
        const service = String(container.service || '').trim().toLocaleLowerCase();
        if (name.length >= 5 && source.includes(name)) hits.push({ score: 82, container });
        else if (service.length >= 4 && source.includes(service)) hits.push({ score: 76, container });
      }
      if (hits.length) score = Math.max(...hits.map((hit) => hit.score));
    }
    if (score) matches.push({ project, score });
  }
  matches.sort((a, b) => b.score - a.score);
  if (!matches.length) return { project: null, projectId: null, container: null, serviceName: '', confidence: 'none' };
  const best = matches[0];
  const tied = matches.filter((item) => item.score === best.score);
  if (tied.length !== 1) {
    return { project: null, projectId: null, container: null, serviceName: '', confidence: 'ambiguous',
      candidates: tied.map((item) => ({ id: item.project.id, name: item.project.projectName })) };
  }

  const containerHits = [];
  const serviceNames = new Set();
  for (const container of best.project.containers || []) {
    const name = String(container.name || '').trim().toLocaleLowerCase();
    const service = String(container.service || '').trim();
    if (name.length >= 5 && source.includes(name)) containerHits.push(container);
    else if (service.length >= 4 && source.includes(service.toLocaleLowerCase())) {
      containerHits.push(container);
      serviceNames.add(service);
    }
  }
  const container = containerHits.length === 1 ? containerHits[0] : null;
  const serviceName = page.serviceName || (serviceNames.size === 1 ? [...serviceNames][0] : container?.service || '');
  return { project: best.project, projectId: best.project.id, container, serviceName, confidence: container ? 'container' : serviceName ? 'service' : 'project' };
}
/** 解析工具执行所需的项目/容器上下文。 */
export async function resolveToolContext(params = {}, { storedScope = false } = {}) {
  // History queries validate their stored ownership without requiring a live Docker scan.
  if (storedScope) return { project: null, projectId: params.projectId || null, hostId: params.hostId || null, container: null };
  const projectId = params?.projectId;
  const hostId = params.hostId || getActiveHostId();
  if (!getHost(hostId)) throw Object.assign(new Error('Docker 节点不存在'), { statusCode: 404 });
  if (!projectId) return { project: null, projectId: null, container: null, hostId };
  const project = params.hostId ? (await scanProjects(hostId)).find(row => row.id === projectId) : await findProject(projectId);
  if (!project || project.hostId && project.hostId !== hostId) throw Object.assign(new Error('项目不存在或不属于指定节点'), { statusCode: 404 });
  let container = null;
  if (params.containerId) {
    const hits = (project.containers || []).filter(row => row.id === params.containerId || row.id.startsWith(params.containerId) || row.name === params.containerId);
    if (hits.length !== 1) throw Object.assign(new Error('容器不存在或存在歧义'), { statusCode: 400 });
    container = hits[0];
  }
  return { project, projectId, container, hostId };
}

/** 权限门:managed / editable / readonly / admin 四档。 */
export async function assertPermission(tool, context) {
  const { project } = context || {};

  // 检查项目必需性
  if (tool.requiresProject && !project) {
    throw Object.assign(new Error('该工具需要指定 projectId'), { statusCode: 400 });
  }

  // admin 工具不受项目权限约束(仅用于全局维护操作)
  if (tool.requiredPermission === 'admin') return;

  // readonly 工具在无项目时允许执行(全局只读查询)
  if (!project && tool.requiredPermission === 'readonly') return;

  // 其他工具需要项目且必须已纳管
  if (project && !project.managed) {
    throw Object.assign(new Error('项目尚未加入管理,无法执行此工具'), { statusCode: 403 });
  }

  // editable 工具额外检查 Compose 目录权限
  if (tool.requiredPermission === 'editable' && project && !project.editable) {
    throw Object.assign(new Error('项目未启用可编辑的 Compose 目录能力'), { statusCode: 403 });
  }

  // 默认拒绝:工具声明了需要的权限但上下文不满足
  if (tool.requiredPermission && !['admin', 'readonly'].includes(tool.requiredPermission)) {
    if (!project) {
      throw Object.assign(new Error('工具需要项目上下文'), { statusCode: 403 });
    }
  }
}

/**
 * 工具执行边界上的 JSON Schema 子集校验。
 * 工具参数来自 LLM 和浏览器,不能只把 schema 当作展示元数据。
 */
export function validateParams(schema = {}, params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw Object.assign(new Error('工具参数必须是 JSON 对象'), { statusCode: 400 });
  }
  validateToolValue({ type: 'object', ...schema }, params);
  return true;
}
