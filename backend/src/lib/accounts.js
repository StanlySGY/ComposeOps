import { notifyAuthRevoked } from './auth-revocations.js';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import db from './db.js';
import { redactSecretValue } from './secret-redactor.js';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export const legacyAdmin = Object.freeze({ id: 'admin', username: 'admin', displayName: '管理员', role: 'admin', enabled: true, revision: 1 });
export function accountById(id) {
  if (id === 'admin') return legacyAdmin;
  const row = db.prepare('SELECT id,username,display_name,role,enabled,revision FROM accounts WHERE id=?').get(id);
  return row ? { id: row.id, username: row.username, displayName: row.display_name, role: row.role, enabled: !!row.enabled, revision: row.revision } : null;
}
export function grantsFor(id) { return db.prepare('SELECT host_id AS hostId,project_id AS projectId FROM account_grants WHERE account_id=? ORDER BY host_id,project_id').all(id); }
export function listAccounts() { return db.prepare('SELECT id FROM accounts ORDER BY username').all().map(row => ({ ...accountById(row.id), grants: grantsFor(row.id) })); }
function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw fail('密码长度需为 10–200 个字符');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}
const dummyHash = hashPassword(randomBytes(32).toString('hex'));
function matches(password, hash) {
  const [, salt, hex] = hash.split('$'), expected = Buffer.from(hex, 'hex');
  const actual = scryptSync(typeof password === 'string' && password.length <= 200 ? password : '', salt, 64);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export function authenticateAccount(username, password) {
  const row = db.prepare('SELECT id,password_hash,enabled FROM accounts WHERE username=?').get(String(username || '').trim().toLowerCase());
  const valid = matches(password, row?.password_hash || dummyHash);
  return valid && row?.enabled ? accountById(row.id) : null;
}
export function accountAudit(actor, action, target, details = {}) {
  db.prepare('INSERT INTO account_audit(actor,action,target,details_json,created_at) VALUES(?,?,?,?,?)').run(actor, action, target, JSON.stringify(redactSecretValue(details)), Date.now());
}
export function saveAccount(input, actor) {
  const current = input.id ? accountById(input.id) : null;
  if (input.id && (!current || input.id === 'admin')) throw fail('成员不存在或不能编辑内置管理员', 404);
  if (current && current.revision !== input.revision) throw fail('成员已被更新，请刷新后重试', 409);
  const username = String(input.username || current?.username || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,39}$/.test(username) || username === 'admin') throw fail('账号需为 3–40 位字母、数字或 ._-，且不能使用 admin');
  const role = input.role || current?.role || 'viewer';
  if (!['admin', 'operator', 'viewer'].includes(role)) throw fail('角色无效');
  const enabled = input.enabled !== false, grants = input.grants || [];
  if (!Array.isArray(grants) || grants.length > 200 || grants.some(g => typeof g?.hostId !== 'string' || !g.hostId || g.hostId.length > 128 || typeof g?.projectId !== 'string' || !g.projectId || g.projectId.length > 256)) throw fail('项目授权无效');
  if (current?.id === actor && (!enabled || role !== 'admin')) throw fail('不能停用或降低当前管理员的权限');
  const hash = input.password ? hashPassword(input.password) : current ? null : hashPassword(input.password);
  const id = current?.id || 'user-' + randomUUID(), now = Date.now();
  const displayName = String(input.displayName || username).trim().slice(0, 80);
  try { db.transaction(() => {
    if (current) db.prepare('UPDATE accounts SET username=?,display_name=?,role=?,enabled=?,password_hash=COALESCE(?,password_hash),revision=revision+1,updated_at=? WHERE id=?').run(username, displayName, role, enabled ? 1 : 0, hash, now, id);
    else db.prepare('INSERT INTO accounts(id,username,display_name,password_hash,role,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, username, displayName, hash, role, enabled ? 1 : 0, now, now);
    db.prepare('DELETE FROM account_grants WHERE account_id=?').run(id);
    const insert = db.prepare('INSERT OR IGNORE INTO account_grants(account_id,host_id,project_id) VALUES(?,?,?)');
    if (role !== 'admin') for (const grant of grants) insert.run(id, grant.hostId, grant.projectId);
    db.prepare('DELETE FROM sessions WHERE account_id=?').run(id);
    accountAudit(actor, current ? 'account_updated' : 'account_created', id, { username, role, enabled, grants, passwordChanged: !!hash });
  })(); } catch (error) { if (String(error.message).includes('UNIQUE')) throw fail('账号已存在', 409); throw error; }
  notifyAuthRevoked();
  return { ...accountById(id), grants: grantsFor(id) };
}
export function changeAccountPassword(id, currentPassword, nextPassword) {
  const row = db.prepare('SELECT password_hash FROM accounts WHERE id=? AND enabled=1').get(id);
  if (!row || !matches(currentPassword, row.password_hash)) throw fail('当前密码错误');
  const hash = hashPassword(nextPassword);
  db.transaction(() => {
    db.prepare('UPDATE accounts SET password_hash=?,revision=revision+1,updated_at=? WHERE id=?').run(hash, Date.now(), id);
    db.prepare('DELETE FROM sessions WHERE account_id=?').run(id);
    accountAudit(id, 'password_changed', id);
  })();
  notifyAuthRevoked();
}
export function assertProjectGrant(principal, hostId, projectId, write = false) {
  // Reload on every action: permissions may have been revoked since the request started.
  const current = principal?.id ? accountById(principal.id) : null;
  if (!current?.enabled || (write && current.role === 'viewer')) throw fail('当前账号没有操作权限', 403);
  if (current.role === 'admin') return;
  if (!db.prepare('SELECT 1 FROM account_grants WHERE account_id=? AND host_id=? AND project_id=?').get(current.id, hostId, projectId)) throw fail('没有该节点项目的访问权限', 403);
}
