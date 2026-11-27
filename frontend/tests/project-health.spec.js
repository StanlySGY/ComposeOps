import { describe, expect, it } from 'vitest';
import { projectAttention, projectLogTarget, needsAttention, isHealthyProject } from '../src/lib/project-health.js';

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

describe('运行意图与异常证据', () => {
  const stopped = { id: 'stopped', status: 'stopped', containers: [{ id: 'c', state: 'exited', exitCode: 0 }] };
  it('未标注停机和计划停机保持可见，但不算健康或故障', () => {
    for (const operationalIntent of ['unknown', 'stopped', 'maintenance']) {
      const project = { ...stopped, operationalIntent };
      expect(needsAttention(project)).toBe(false);
      expect(isHealthyProject(project)).toBe(false);
    }
    expect(projectAttention(stopped).label).toContain('意图未标注');
  });
  it('预期运行的停机、无容器与部分运行均需关注', () => {
    expect(needsAttention({ ...stopped, operationalIntent: 'running' })).toBe(true);
    expect(needsAttention({ status: 'stopped', operationalIntent: 'running', containers: [] })).toBe(true);
    expect(needsAttention({ status: 'partial', containers: [stopped.containers[0], { state: 'running' }] })).toBe(true);
  });
  it('维护和计划停机不掩盖 OOM、异常退出、健康失败及重启循环', () => {
    for (const evidence of [{ oomKilled: true }, { exitCode: 1 }, { health: 'unhealthy' }, { state: 'restarting' }, { state: 'dead' }, { exitCode: null, statusText: 'Exited (137) 1 hour ago' }]) {
      for (const operationalIntent of ['stopped', 'maintenance']) {
        expect(needsAttention({ ...stopped, operationalIntent, containers: [{ ...stopped.containers[0], ...evidence }] })).toBe(true);
      }
    }
  });
  it('故障日志优先于正常停止容器，计划停机但运行显示意图不一致', () => {
    const project = { ...stopped, containers: [...stopped.containers, { id: 'failure', state: 'running', health: 'unhealthy' }] };
    expect(projectLogTarget(project).query.containerId).toBe('failure');
    expect(needsAttention({ status: 'running', operationalIntent: 'stopped', containers: [{ state: 'running' }] })).toBe(true);
  });
});
