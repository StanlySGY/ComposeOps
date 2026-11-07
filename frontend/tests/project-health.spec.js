import { describe, expect, it } from 'vitest';
import { projectAttention, projectLogTarget } from '../src/lib/project-health.js';

describe('总览异常处理路径', () => {
  it('部分运行不误报为全部停止，直达失败容器而非第一个健康容器', () => {
    const project = { id: 'p', status: 'partial', containers: [{ id: 'healthy', state: 'running', health: 'healthy' }, { id: 'failed', state: 'exited', health: 'unhealthy' }] };
    expect(projectAttention(project)).toEqual({ label: '部分运行', detail: '1 个未运行 · 1 个健康检查异常' });
    expect(projectLogTarget(project)).toEqual({ path: '/logs', query: { projectId: 'p', containerId: 'failed', from: 'dashboard' } });
  });
  it('运行中的健康检查失败和无容器项目都有有效目标', () => {
    const project = { id: 'p', status: 'running', containers: [{ id: 'unhealthy', state: 'running', health: 'unhealthy' }] };
    expect(projectAttention(project).label).toBe('健康检查异常');
    expect(projectLogTarget(project).query.containerId).toBe('unhealthy');
    expect(projectLogTarget({ id: 'empty' }).query).toEqual({ projectId: 'empty', from: 'dashboard' });
  });
});
