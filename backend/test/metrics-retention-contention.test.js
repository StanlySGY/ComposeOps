import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import db, { DB_PATH } from '../src/lib/db.js';
import Database from '../src/lib/sqlite.js';
import { compactMetrics } from '../src/services/metrics-retention.js';
const other = new Database(DB_PATH, { fileMustExist: true });
other.pragma('busy_timeout = 0');
after(() => other.close());
beforeEach(() => db.exec('DELETE FROM container_metrics; DELETE FROM infrastructure_metrics; DELETE FROM settings;'));
const now = Date.UTC(2026, 10, 29), bucket = Math.floor((now - 10 * 86400000) / 300000) * 300000;
const insert = (database, value, timestamp = bucket + 1000) => database.prepare("INSERT INTO container_metrics(host_id,container_id,metric_type,value,unit,timestamp) VALUES('local','fixture','cpu',?,'%',?)").run(value, timestamp);
function observeDiscovery(onRead) {
  return { exec: sql => db.exec(sql), prepare(sql) {
    const statement = db.prepare(sql);
    if (!/GROUP BY CAST\(timestamp/.test(sql)) return statement;
    return { ...statement, all(...params) { const rows = statement.all(...params); onRead(); return rows; } };
  } };
}

test('历史桶发现扫描不持有写锁，其他连接可以同时记录平台心跳', async () => {
  insert(db, 20); insert(db, 40);
  let scans = 0; const failures = [];
  const observer = observeDiscovery(() => {
    scans++;
    try { other.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('heartbeat','alive')").run(); }
    catch (error) { failures.push(error.code); }
  });
  await compactMetrics(observer, now);
  assert.ok(scans > 0);
  assert.deepEqual(failures, [], '后台扫描期间平台写入不应收到 SQLITE_BUSY');
  assert.equal(other.prepare("SELECT value FROM settings WHERE key='heartbeat'").get()?.value, 'alive');
});

test('已完成聚合的系列不因空操作扫描阻塞其他写入', async () => {
  for (let i = 0; i < 20; i++) insert(db, i, bucket + i * 300000);
  let writable = true;
  const observer = observeDiscovery(() => {
    try { other.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('noop','ok')").run(); }
    catch { writable = false; }
  });
  const result = await compactMetrics(observer, now);
  assert.equal(result.compactedRows, 0);
  assert.equal(writable, true, '无需整理的历史不应持有数据库写锁');
});

test('发现桶后到提交前的新样本会重新读取，统计值与删除原子一致', async () => {
  insert(db, 10); insert(db, 30);
  let added = false, insertionError;
  const observer = observeDiscovery(() => {
    if (added) return; added = true;
    try { insert(other, 50, bucket + 2000); } catch (error) { insertionError = error.code; }
  });
  const result = await compactMetrics(observer, now);
  assert.equal(insertionError, undefined);
  assert.equal(result.compactedRows, 2);
  const row = db.prepare('SELECT value,sample_count,value_sum,value_min,value_max FROM container_metrics').get();
  assert.deepEqual(row, { value: 30, sample_count: 3, value_sum: 90, value_min: 10, value_max: 50 });
});
