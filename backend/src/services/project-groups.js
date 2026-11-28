import { randomUUID } from 'node:crypto';
import db, { setProjectPreference } from '../lib/db.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const cleanName = value => {
  if (typeof value !== 'string') throw fail('请填写分组名称');
  const name = value.trim();
  if (!name || name.length > 40 || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw fail('分组名称须为 1–40 个可见字符');
  return name;
};
export function listProjectGroups() {
  return db.prepare('SELECT id, name, pinned FROM project_groups ORDER BY pinned DESC, name COLLATE NOCASE, id').all().map(g => ({ ...g, pinned: !!g.pinned }));
}
export function saveProjectGroup({ id, name, pinned }) {
  const current = id ? db.prepare('SELECT * FROM project_groups WHERE id=?').get(id) : null;
  if (id && !current) throw fail('分组已不存在，请刷新', 404);
  const nextName = cleanName(name ?? current?.name);
  const existing = db.prepare('SELECT * FROM project_groups WHERE name=? COLLATE NOCASE').get(nextName);
  if (existing && existing.id !== id) {
    if (!id) return { id: existing.id, name: existing.name, pinned: !!existing.pinned };
    throw fail('已存在同名分组', 409);
  }
  const next = { id: id || randomUUID(), name: nextName, pinned: pinned ?? !!current?.pinned };
  db.prepare(`INSERT INTO project_groups(id,name,pinned) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,pinned=excluded.pinned,updated_at=datetime('now')`).run(next.id, next.name, Number(next.pinned));
  return next;
}
export function deleteProjectGroup(id) {
  db.transaction(() => {
    db.prepare("UPDATE project_preferences SET group_id=NULL,updated_at=datetime('now') WHERE group_id=?").run(id);
    db.prepare('DELETE FROM project_groups WHERE id=?').run(id);
  })();
  return { ok: true };
}
export function projectGroupMetadata(projectId) {
  const row = db.prepare(`SELECT p.group_id AS groupId,g.name AS groupName,g.pinned AS groupPinned
    FROM project_preferences p LEFT JOIN project_groups g ON g.id=p.group_id WHERE p.project_id=?`).get(projectId);
  return { groupId: row?.groupId || null, groupName: row?.groupName || '未分组', groupPinned: !!row?.groupPinned };
}
export function validateGroupAssignments(projects, assignments = []) {
  if (!Array.isArray(assignments) || assignments.length > 1000) throw fail('分组选择格式无效');
  const known = new Set(projects.map(p => p.id));
  const groups = new Set(listProjectGroups().map(g => g.id));
  const seen = new Set();
  for (const row of assignments) {
    if (!row || !known.has(row.projectId) || seen.has(row.projectId)) throw fail('选择中包含重复项目或当前节点未发现的项目');
    if (row.groupId !== null && !groups.has(row.groupId)) throw fail('目标分组已不存在，请重新选择', 409);
    seen.add(row.projectId);
  }
}
export function writeAssignments(projects, assignments) {
  const byId = new Map(projects.map(p => [p.id, p]));
  for (const row of assignments) {
    setProjectPreference(row.projectId, {});
    db.prepare("UPDATE project_preferences SET group_id=?,host_id=?,updated_at=datetime('now') WHERE project_id=?")
      .run(row.groupId, byId.get(row.projectId).hostId, row.projectId);
  }
}
export function assignProjectGroups(projects, assignments) {
  validateGroupAssignments(projects, assignments);
  db.transaction(() => writeAssignments(projects, assignments))();
  return { ok: true };
}
/** Permission and grouping changes commit together, scoped to the displayed host. */
export function applyProjectManagement(projects, hostId, managedIds, mountIds, assignments = []) {
  validateGroupAssignments(projects, assignments);
  const managed = new Set(managedIds), mounts = new Set(mountIds);
  db.transaction(() => {
    // Bind old preferences lazily; never revoke another host's permissions.
    for (const project of projects) {
      setProjectPreference(project.id, {});
      db.prepare('UPDATE project_preferences SET host_id=? WHERE project_id=?').run(hostId, project.id);
    }
    db.prepare("UPDATE project_preferences SET managed=0,mount_enabled=0,updated_at=datetime('now') WHERE host_id=?").run(hostId);
    for (const project of projects) if (managed.has(project.id)) setProjectPreference(project.id, { managed: true, mountEnabled: mounts.has(project.id) });
    writeAssignments(projects, assignments);
  })();
  return { managedProjectIds: projects.filter(p => managed.has(p.id)).map(p => p.id), mountProjectIds: projects.filter(p => managed.has(p.id) && mounts.has(p.id)).map(p => p.id) };
}
