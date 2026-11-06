import { describe, expect, it } from 'vitest';
import { applyOperationFrame, operationSucceeded } from '../src/lib/operation-feedback.js';
const fresh = () => ({ text: '', exitCode: null, failureReason: '' });
describe('操作结果反馈', () => {
  it('只收到输出或空退出码不能判为成功', () => {
    const output = fresh();
    applyOperationFrame(output, { type: 'stdout', data: 'done' });
    applyOperationFrame(output, { type: 'exit', data: { code: null } });
    expect(operationSucceeded(output)).toBe(false);
    expect(output.exitCode).toBeNull();
  });
  it('明确的非零退出码为失败，零退出码可确认命令完成', () => {
    for (const code of [0, 1, 137]) {
      const output = fresh(); applyOperationFrame(output, { type: 'exit', data: { code } });
      expect(operationSucceeded(output)).toBe(code === 0);
    }
  });
  it.each([{ ok: false, message: '镜像不存在' }, { ok: true, degraded: true }])('后置验收失败优先于命令的成功退出码 %s', data => {
    const output = fresh();
    applyOperationFrame(output, { type: 'exit', data: { code: 0 } });
    applyOperationFrame(output, { type: 'result', data });
    expect(operationSucceeded(output)).toBe(false);
    expect(output.failureReason).toBeTruthy();
    expect(output.exitCode).toBe(0);
  });
  it('升级流在验收结果之前中断时，成功退出码不足以确认健康', () => {
    const output = fresh();
    applyOperationFrame(output, { type: 'exit', data: { code: 0 } });
    expect(operationSucceeded(output, { requireResult: true })).toBe(false);
    applyOperationFrame(output, { type: 'result', data: { ok: true, upgraded: true, degraded: false } });
    expect(operationSucceeded(output, { requireResult: true })).toBe(true);
  });
  it('显式错误不能被后续成功码掩盖，普通日志文字不决定结果', () => {
    const output = fresh();
    applyOperationFrame(output, { type: 'error', data: '连接中断' });
    applyOperationFrame(output, { type: 'exit', data: { code: 0 } });
    expect(operationSucceeded(output)).toBe(false);
    const normal = fresh();
    applyOperationFrame(normal, { type: 'stderr', data: '0 errors' });
    applyOperationFrame(normal, { type: 'exit', data: { code: 0 } });
    expect(operationSucceeded(normal)).toBe(true);
  });
});
