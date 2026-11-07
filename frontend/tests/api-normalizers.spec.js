import { describe, expect, it } from 'vitest';
import {
  normalizeBackgroundJob,
  normalizeCostReport,
  normalizeDockerUsage,
  normalizeMetrics,
  normalizeMountPlan,
  normalizeStorageDf,
} from '../src/lib/api-normalizers.js';

describe('API response normalizers', () => {
  it('补齐存储统计中缺失的嵌套分组', () => {
    const result = normalizeStorageDf({ images: { total: 12 } });

    expect(result.images.total).toBe(12);
    expect(result.buildCache.total).toBe(0);
    expect(result.volumes.total).toBe(0);
    expect(result.containers.total).toBe(0);
  });

  it('将维护用量和空响应归一化为可渲染结构', () => {
    const result = normalizeDockerUsage(undefined);

    expect(result.images.total).toBe(0);
    expect(result.buildCache.reclaimable).toBe(0);
    expect(result.containers.count).toBe(0);
    expect(result.volumes.total).toBe(0);
  });

  it('补齐监控指标中的 host、memory、cpu 和 network 嵌套字段', () => {
    const result = normalizeMetrics({ host: { memory: { total: 8 } } });

    expect(result.host.memory.total).toBe(8);
    expect(result.host.cpu.loadavg).toEqual([0, 0, 0]);
    expect(result.network.rx).toBe(0);
    expect(result.containers).toEqual([]);
  });

  it('补齐成本报告的 summary、storage 和数组字段', () => {
    const result = normalizeCostReport({ summary: { totalProjects: '2' }, storage: { images: { total: 4 } } });

    expect(result.summary.totalProjects).toBe(2);
    expect(result.summary.totalCPUPercent).toBe(0);
    expect(result.storage.images.total).toBe(4);
    expect(result.storage.containers.total).toBe(0);
    expect(result.trends).toEqual([]);
  });

  it('补齐纳管计划摘要和项目列表', () => {
    const result = normalizeMountPlan({ summary: { total: 1 } });

    expect(result.summary.total).toBe(1);
    expect(result.summary.managed).toBe(0);
    expect(result.projects).toEqual([]);
    expect(result.unsupportedProjects).toEqual([]);
  });

  it('补齐后台任务进度并从项目项推导 total', () => {
    const result = normalizeBackgroundJob({ items: [{ id: 'one' }, { id: 'two' }] });

    expect(result.total).toBe(2);
    expect(result.completed).toBe(0);
    expect(result.items).toHaveLength(2);
  });

  it('将成本报告中的异常统计值归一化为数字', () => {
    const result = normalizeCostReport({ projects: [{ totalCPUPercent: undefined }], trends: [{ totalMemoryMB: undefined }] });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].totalCPUPercent).toBe(0);
    expect(result.trends).toHaveLength(1);
    expect(result.trends[0].totalMemoryMB).toBe(0);
  });
});


it('保留存储的节点范围与不可达节点，避免部分总数被当成完整结果', () => {
  expect(normalizeDockerUsage({ hostId: 'all', unavailableHosts: ['remote'] })).toMatchObject({ hostId: 'all', unavailableHosts: ['remote'] });
});
