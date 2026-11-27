export function groupProjects(projects, definitions = []) {
  const groups = new Map(definitions.map(g => [g.id, { ...g, projects: [] }]));
  for (const project of projects) {
    const id = project.id === 'standalone' ? 'standalone' : project.groupId || '';
    if (!groups.has(id)) groups.set(id, { id, name: id === 'standalone' ? '独立容器' : project.groupName || '未分组', pinned: !!project.groupPinned, projects: [] });
    groups.get(id).projects.push(project);
  }
  return [...groups.values()].filter(g => g.projects.length).sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(!a.id || a.id === 'standalone') - Number(!b.id || b.id === 'standalone') || a.name.localeCompare(b.name));
}
