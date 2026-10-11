import { describe, expect, it } from 'vitest';
import { filterContainers } from '../src/lib/container-match.js';

const containers = [
  { id: 'aa11bb22cc33', name: 'compose-api', state: 'running', image: 'node:22' },
  { id: 'dd44ee55ff66', name: 'postgres', state: 'running', image: 'postgres:17' },
  { id: 'gg77hh88ii99', name: '缓存网关', state: 'exited', image: 'nginx' },
];

describe('容器模糊匹配 filterContainers', () => {
  it('空查询保持原始顺序并返回全部容器', () => {
    expect(filterContainers(containers, '')).toHaveLength(3);
    expect(filterContainers(containers, '   ')[0].name).toBe('compose-api');
  });

  it('英文缩写跳字命中,并按命中强度排序', () => {
    const result = filterContainers(containers, 'cmp');
    expect(result.map((c) => c.name)).toEqual(['compose-api']);
  });

  it('可按状态或镜像过滤(聚合模式按状态挑选容器)', () => {
    expect(filterContainers(containers, 'exited').map((c) => c.name)).toEqual(['缓存网关']);
    expect(filterContainers(containers, 'postgres:17').map((c) => c.name)).toEqual(['postgres']);
  });

  it('容器 ID 前缀同样可命中', () => {
    expect(filterContainers(containers, 'dd44').map((c) => c.name)).toEqual(['postgres']);
  });

  it('中文保持整词匹配,不做跳字', () => {
    expect(filterContainers(containers, '网关').map((c) => c.name)).toEqual(['缓存网关']);
    expect(filterContainers(containers, '关网')).toHaveLength(0);
  });

  it('非数组输入不抛错', () => {
    expect(filterContainers(undefined, 'x')).toEqual([]);
  });
});
