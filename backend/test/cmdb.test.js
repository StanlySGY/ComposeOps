import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-cmdb-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const {
  upsertAsset, getAsset, listAssets, deleteAsset,
  addAssetRelation, listAssetRelations,
} = await import('../src/lib/db.js');

test('cmdb: 资产 upsert 幂等', () => {
  const asset = upsertAsset({ id: 'host:local', kind: 'host', name: 'local', displayName: 'Local Daemon', status: 'online' });
  assert.equal(asset.id, 'host:local');
  assert.equal(asset.kind, 'host');
  // 再次 upsert 更新状态
  const updated = upsertAsset({ id: 'host:local', kind: 'host', name: 'local', displayName: 'Local Daemon', status: 'offline' });
  assert.equal(updated.status, 'offline');
  assert.equal(listAssets({ kind: 'host' }).length, 1);
});

test('cmdb: 资产关系建立与查询', () => {
  upsertAsset({ id: 'project:web', kind: 'project', name: 'web', displayName: 'Web' });
  upsertAsset({ id: 'container:c1', kind: 'container', name: 'c1', displayName: 'c1' });
  addAssetRelation('container:c1', 'project:web', 'runs_on');
  const relations = listAssetRelations();
  assert.ok(relations.some((r) => r.sourceId === 'container:c1' && r.targetId === 'project:web' && r.relation === 'runs_on'));
});

test('cmdb: 关系重复写入幂等且查询有安全上限', () => {
  addAssetRelation('container:c1', 'project:web', 'runs_on', { source: 'second-sync' });
  const same = listAssetRelations().filter((r) => r.sourceId === 'container:c1' && r.targetId === 'project:web' && r.relation === 'runs_on');
  assert.equal(same.length, 1);
  assert.deepEqual(same[0].properties, { source: 'second-sync' });

  for (let index = 0; index < 510; index += 1) {
    upsertAsset({ id: `service:bulk-${index}`, kind: 'service', name: `bulk-${index}` });
  }
  assert.equal(listAssets({ kind: 'service', limit: 9999 }).length, 500);
  assert.equal(listAssets({ kind: 'service', limit: 10, offset: 500 }).length, 10);
  assert.equal(listAssetRelations({ limit: 9999 }).length <= 500, true);
});

test('cmdb: 删除资产', () => {
  upsertAsset({ id: 'project:temp', kind: 'project', name: 'temp' });
  assert.ok(getAsset('project:temp'));
  assert.ok(deleteAsset('project:temp'));
  assert.equal(getAsset('project:temp'), null);
});
