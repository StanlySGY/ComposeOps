import { describe, expect, it } from 'vitest';
import { createLogResume } from '../src/lib/log-resume.js';

const line = { containerId: 'a', type: 'stdout', ts: '2026-11-06T12:00:00.123456789Z', data: 'same' };
describe('日志补读与去重', () => {
  it('保存各容器位置、向前重叠一秒且不截断原始纳秒时间戳', () => {
    const other = { ...line, containerId: 'b', ts: '2026-11-06T11:50:00.987654321Z' };
    const resume = createLogResume([line, other]);
    const cursors = JSON.parse(new URLSearchParams(resume.query).get('resume'));
    expect(cursors).toEqual({ a: Math.floor(Date.parse(line.ts) / 1000) - 1, b: Math.floor(Date.parse(other.ts) / 1000) - 1 });
    expect(resume.accept({ ...line, ts: '2026-11-06T12:00:00.123456790Z' })).toBe(true);
    expect(resume.accept(line)).toBe(false);
    expect(resume.accept(other)).toBe(false);
  });
  it('按次数去重，不误删同时间同内容的新日志，容器和输出流相互隔离', () => {
    const resume = createLogResume([line, line]);
    expect(resume.accept({ ...line, containerId: 'b' })).toBe(true);
    expect(resume.accept({ ...line, type: 'stderr' })).toBe(true);
    expect(resume.accept({ ...line, data: 'new' })).toBe(true);
    expect(resume.accept(line)).toBe(false);
    expect(resume.accept(line)).toBe(false);
    expect(resume.accept(line)).toBe(true);
  });
  it('没有可靠容器或时间戳时不发送游标，清空后不残留去重状态', () => {
    for (const values of [[], [{ ...line, ts: null }], [{ ...line, containerId: '' }], [{ ...line, ts: 'invalid' }]]) {
      const resume = createLogResume(values);
      expect(resume.query).toBe(''); expect(resume.accept(line)).toBe(true);
    }
  });
  it('大量容器时限制握手大小', () => {
    expect(createLogResume(Array.from({ length: 65 }, (_, i) => ({ ...line, containerId: `c${i}` }))).query).toBe('');
  });
});
