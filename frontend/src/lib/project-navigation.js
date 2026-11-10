import { returnTarget } from './deep-links.js';
// Preserve the list the user came from across project tools, including refresh.
// Accept only the service list and its harmless presentation state.
export function projectReturnLocation(value, projectId) {
  const query = {};
  if (typeof value === 'string' && value.length <= 2048 && /^\/services(?:\?|$)/.test(value)) {
    const params = new URLSearchParams(value.split('?')[1] || '');
    for (const key of ['q', 'filter', 'sort']) {
      if (params.get(key)) query[key] = params.get(key);
    }
  }
  if (projectId) query.focus = projectId;
  return { path: '/services', query };
}

export function projectToolLocation(name, project, containerId = '', context = {}) {
  const query = { projectId: project.id };
  if (project.hostId) query.hostId = project.hostId;
  const source = returnTarget(context.from) ? context.from : 'services';
  query.from = source;
  if (typeof context.returnTo === 'string' && /^\/services(?:\?|$)/.test(context.returnTo)) query.returnTo = context.returnTo.slice(0, 2048);
  // Carry a real container through configuration too, so returning to logs
  // does not silently switch from one container to the aggregate stream.
  if ((project.containers || []).some(container => container.id === containerId)) query.containerId = containerId;
  return { path: '/' + name, query };
}
