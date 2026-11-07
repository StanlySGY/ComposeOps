import { describe, expect, it } from 'vitest';
import { buildLogLayout, captureLogAnchor, logIndexAt, restoreLogAnchor } from '../src/lib/log-layout.js';

const lines = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1 }));
describe('可变高度日志的阅读锚点', () => {
  it('展开 JSON 后按真实高度定位，不把 JSON 内部当成后续几十行', () => {
    const layout = buildLogLayout(lines, new Map([[2, 1000]]), 24);
    expect(logIndexAt(layout, 800)).toBe(1);
    expect(logIndexAt(layout, 1024)).toBe(2);
    expect(layout.total).toBe(120976);
  });
  it('5000 条缓冲区滚动淘汰时保留同一行及其内部阅读偏移', () => {
    const before = buildLogLayout(lines, new Map(), 24);
    const anchor = captureLogAnchor(before, 24005);
    const after = buildLogLayout([...lines.slice(400), ...Array.from({ length: 400 }, (_, i) => ({ id: 5001 + i }))], new Map([[900, 200]]), 24);
    const top = restoreLogAnchor(after, anchor);
    expect(captureLogAnchor(after, top)).toEqual(anchor);
    expect(top).toBe(14581);
  });
  it('阅读行被移出缓冲区或筛选后，安全定位到最早可用行', () => {
    const before = buildLogLayout(lines, new Map(), 24);
    const anchor = captureLogAnchor(before, 100);
    const after = buildLogLayout(lines.slice(100), new Map(), 24);
    expect(restoreLogAnchor(after, anchor)).toBe(0);
    expect(restoreLogAnchor(buildLogLayout([], new Map()), anchor)).toBe(0);
  });
  it('折叠正在阅读的超高行时，偏移被限制在该行范围内', () => {
    const before = buildLogLayout(lines, new Map([[1, 1000]]), 24);
    const anchor = captureLogAnchor(before, 800);
    expect(restoreLogAnchor(buildLogLayout(lines, new Map(), 24), anchor)).toBe(23);
  });
});
