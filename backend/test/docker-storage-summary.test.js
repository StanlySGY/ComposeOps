import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDockerDiskUsage } from '../src/lib/docker-storage-summary.js';
test('Engine共享层总量不再按所有镜像大小重复求和', () => {
  const data = summarizeDockerDiskUsage({ LayersSize: 150, Images: [{ Size: 100, SharedSize: 50, Containers: 1 }, { Size: 100, SharedSize: 50, Containers: 0 }], Containers: [] });
  assert.equal(data.images.total, 150); assert.equal(data.images.reclaimable, 100); assert.equal(data.estimated, true);
});
test('优先使用Engine聚合统计，构建缓存可回收量不等于所有未使用记录之和', () => {
  const section = { TotalCount: 2, TotalSize: 150, Reclaimable: 75, ActiveCount: 1, Items: [] };
  const data = summarizeDockerDiskUsage({ ImageUsage: section, ContainerUsage: section, VolumeUsage: section, BuildCacheUsage: { ...section, Reclaimable: 20, Items: [{ Size: 150, InUse: false }] } });
  assert.equal(data.images.total, 150); assert.equal(data.buildCache.reclaimable, 20); assert.equal(data.total, 600); assert.equal(data.reclaimable, 245); assert.equal(data.estimated, false);
});
test('未知卷引用数或大小不能作为孤儿可释放空间，paused容器仍算在用', () => {
  const data = summarizeDockerDiskUsage({ Images: [], Containers: [{ State: 'paused', SizeRw: 20 }], Volumes: [{ UsageData: { RefCount: -1, Size: -1 } }, { UsageData: { Size: 30 } }] });
  assert.equal(data.containers.reclaimable, 0); assert.equal(data.containers.active, 1);
  assert.equal(data.volumes.orphans, 0); assert.equal(data.volumes.reclaimable, 0); assert.equal(data.volumes.unknown, 2);
});
test('非法空统计不能伪装成0占用', () => {
  assert.throws(() => summarizeDockerDiskUsage({ message: 'failed' }), { statusCode: 502 });
});
