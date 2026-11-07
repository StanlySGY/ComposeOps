import { describe, expect, it } from 'vitest';
import { observeProjectOperation } from '../src/lib/operation-verification.js';

const project = (...containers) => ({ containers });
const running = { id: 'a', state: 'running', health: 'healthy' };
describe('命令后的容器状态核对', () => {
  it('无项目或无容器时不宣称恢复', () => {
    expect(observeProjectOperation(null, 'up').state).toBe('unknown');
    expect(observeProjectOperation(project(), 'up').state).toBe('unknown');
  });
  it('区分健康、初始化、异常和退出', () => {
    expect(observeProjectOperation(project(running), 'restart').state).toBe('confirmed');
    expect(observeProjectOperation(project({ ...running, health: 'starting' }), 'up').state).toBe('pending');
    expect(observeProjectOperation(project({ ...running, health: 'unhealthy' }), 'up').state).toBe('attention');
    expect(observeProjectOperation(project({ ...running, state: 'exited' }), 'up').state).toBe('attention');
  });
  it('未配置健康检查不伪报业务健康', () => {
    const result = observeProjectOperation(project({ ...running, health: '' }), 'restart');
    expect(result.title).toContain('全部运行');
    expect(result.detail).toContain('未配置健康检查');
    expect(result.detail).toContain('确认业务访问');
  });
  it('停止操作要求全部容器退出，暂停或重启中的容器不能通过', () => {
    expect(observeProjectOperation(project({ state: 'exited' }, { state: 'created' }), 'stop').state).toBe('confirmed');
    for (const state of ['running', 'paused', 'restarting', 'unknown', 'dead']) {
      expect(observeProjectOperation(project({ state: 'exited' }, { state }), 'stop').state).toBe('attention');
    }
  });
});
