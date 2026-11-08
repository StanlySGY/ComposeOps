import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

const dir = mkdtempSync(path.join(os.tmpdir(), 'composeops-marketplace-consistency-'));
process.env.DB_PATH = path.join(dir, 'db.sqlite');
const { default: db, setSetting, getSetting } = await import('../src/lib/db.js');
const { createCustomTemplate, updateCustomTemplate, deleteCustomTemplate, getCustomTemplates, addFavorite, getFavorites, getMarketplaceStats } = await import('../src/services/marketplace.js');
const compose = 'services:\n  web:\n    image: nginx:alpine\n';
const create = name => createCustomTemplate({ name, category: 'Web', defaultCompose: compose });
beforeEach(() => { setSetting('marketplace.custom.templates', '[]'); setSetting('marketplace.favorites', '[]'); });
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test('marketplace: 同时创建的模板全部持久化，已确认成功不能被后写覆盖', async () => {
  const created = await Promise.all(Array.from({ length: 16 }, (_, index) => create('并发模板-' + index)));
  const stored = await getCustomTemplates();
  assert.equal(stored.length, 16); assert.deepEqual(new Set(stored.map(t => t.id)), new Set(created.map(t => t.id)));
});

test('marketplace: 不同模板同时更新保留两笔修改', async () => {
  const a = await create('A'), b = await create('B');
  await Promise.all([updateCustomTemplate(a.id, { description: 'A updated' }), updateCustomTemplate(b.id, { description: 'B updated' })]);
  const stored = await getCustomTemplates(); assert.equal(stored.find(t => t.id === a.id).description, 'A updated'); assert.equal(stored.find(t => t.id === b.id).description, 'B updated');
});

test('marketplace: 同模板不同字段同时更新按最新记录合并', async () => {
  const item = await create('A');
  await Promise.all([updateCustomTemplate(item.id, { name: 'renamed' }), updateCustomTemplate(item.id, { description: 'description' })]);
  const stored = (await getCustomTemplates())[0]; assert.equal(stored.name, 'renamed'); assert.equal(stored.description, 'description');
});

test('marketplace: 删除与新建交错不复活被删除项', async () => {
  const a = await create('A'); await create('B');
  await Promise.all([deleteCustomTemplate(a.id), create('C')]);
  assert.deepEqual((await getCustomTemplates()).map(t => t.name).sort(), ['B', 'C']);
});

test('marketplace: 已删除模板的迟到编辑明确404，不能复活原记录', async () => {
  const a = await create('A');
  const results = await Promise.allSettled([deleteCustomTemplate(a.id), updateCustomTemplate(a.id, { name: 'returned' })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.statusCode, 404);
  assert.deepEqual(await getCustomTemplates(), []);
});

test('marketplace: 更新只接纳编辑字段，系统身份与创建信息保持不变', async () => {
  const item = await create('original');
  const updated = await updateCustomTemplate(item.id, { id: 'custom-hijacked', author: 'forged', createdAt: '2000-01-01', updatedAt: '2000-01-01', downloads: 99999, favorited: true, name: '合法标题' });
  assert.equal(updated.id, item.id); assert.equal(updated.author, 'user'); assert.equal(updated.createdAt, item.createdAt); assert.notEqual(updated.updatedAt, '2000-01-01');
  assert.equal(updated.name, '合法标题'); assert.equal(updated.downloads, undefined); assert.equal(updated.favorited, undefined);
});

test('marketplace: 损坏模板目录拒绝读取和写入，原始内容不会被当空列表覆盖', async () => {
  for (const corrupt of ['{"unfinished":', '{}', 'null', '[null]', '[{"id":"bad","name":"x"}]']) {
    setSetting('marketplace.custom.templates', corrupt);
    await assert.rejects(getCustomTemplates(), error => error.code === 'MARKETPLACE_DATA_INVALID');
    await assert.rejects(create('must-not-overwrite'), error => error.code === 'MARKETPLACE_DATA_INVALID');
    assert.equal(getSetting('marketplace.custom.templates'), corrupt);
  }
});

test('marketplace: 删除模板同时清理收藏，统计只包含现存模板', async () => {
  const a = await create('A'), b = await create('B'); addFavorite(a.id); addFavorite(b.id); addFavorite('custom-already-gone');
  assert.equal((await getMarketplaceStats()).totalFavorites, 2);
  await deleteCustomTemplate(a.id); assert.ok(!getFavorites().includes(a.id)); assert.equal((await getMarketplaceStats()).totalFavorites, 1);
});

test('marketplace: 收藏清理失败回滚模板删除，不产生半完成状态', async () => {
  const item = await create('A'); addFavorite(item.id);
  db.exec("CREATE TRIGGER fail_market_favorites BEFORE UPDATE ON settings WHEN NEW.key = 'marketplace.favorites' BEGIN SELECT RAISE(ABORT, 'fixture cleanup failure'); END");
  try { await assert.rejects(deleteCustomTemplate(item.id), /fixture cleanup failure/); }
  finally { db.exec('DROP TRIGGER fail_market_favorites'); }
  assert.equal((await getCustomTemplates())[0].id, item.id); assert.ok(getFavorites().includes(item.id));
  await deleteCustomTemplate(item.id); assert.deepEqual(await getCustomTemplates(), []);
});

test('marketplace: 校验失败不影响其它成功写入，事务之后仍可正常使用', async () => {
  const item = await create('A');
  const writes = await Promise.allSettled([updateCustomTemplate(item.id, { defaultCompose: 'services: {}' }), create('B')]);
  assert.equal(writes[0].status, 'rejected'); assert.equal(writes[1].status, 'fulfilled');
  assert.equal((await getCustomTemplates()).find(t => t.id === item.id).defaultCompose, compose);
  assert.equal((await getCustomTemplates()).length, 2);
});

test('marketplace HTTP: 鉴权后的并发创建、更新和删除结果与存储一致', async () => {
  const { buildApp } = await import('../src/app.js'); const app = await buildApp({ logger: false });
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { password: 'marketplace-consistency-test-only' } });
    assert.equal(setup.statusCode, 200); const cookie = setup.headers['set-cookie'].split(';')[0]; const headers = { cookie };
    const denied = await app.inject({ method: 'POST', url: '/api/v1/marketplace/templates/custom', payload: { name: 'denied', defaultCompose: compose } }); assert.equal(denied.statusCode, 401);
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => app.inject({ method: 'POST', url: '/api/v1/marketplace/templates/custom', headers, payload: { name: 'HTTP-' + i, defaultCompose: compose } })));
    for (const response of created) assert.equal(response.statusCode, 200);
    const ids = created.map(response => response.json().template.id); assert.equal((await getCustomTemplates()).length, 12);
    const updated = await app.inject({ method: 'PATCH', url: '/api/v1/marketplace/templates/custom/' + ids[0], headers,
      payload: { name: 'HTTP-safe', id: 'custom-forged', author: 'forged', createdAt: 'forged' } });
    assert.equal(updated.statusCode, 200); assert.equal(updated.json().template.id, ids[0]); assert.equal(updated.json().template.author, 'user');
    const removed = await Promise.all(ids.slice(0, 6).map(id => app.inject({ method: 'DELETE', url: '/api/v1/marketplace/templates/custom/' + id, headers })));
    for (const response of removed) assert.equal(response.statusCode, 200);
    const searched = await app.inject({ url: '/api/v1/marketplace/templates/search?source=custom', headers });
    assert.deepEqual(new Set(searched.json().results.map(item => item.id)), new Set(ids.slice(6)));
    setSetting('marketplace.custom.templates', '{"privateValue":"must-not-be-returned"');
    const broken = await app.inject({ method: 'POST', url: '/api/v1/marketplace/templates/custom', headers, payload: { name: 'unsafe overwrite', defaultCompose: compose } });
    assert.equal(broken.statusCode, 503); assert.ok(!broken.body.includes('must-not-be-returned'));
    assert.equal(getSetting('marketplace.custom.templates'), '{"privateValue":"must-not-be-returned"');
  } finally { await app.close(); }
});
