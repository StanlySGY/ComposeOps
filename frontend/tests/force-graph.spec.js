import { describe, expect, it } from 'vitest';
import { applySeedPositions, createGraphModel, nodeRadius, settleModel, tickModel, FORCE_DEFAULTS } from '../src/lib/force-graph.js';

function makeGraph(nodeKeys, links, options) {
  return createGraphModel(nodeKeys.map((key) => ({ key })), links, options);
}

describe('createGraphModel', () => {
  it('黄金角螺旋播种是确定性的:同一输入两次构建坐标一致', () => {
    const a = makeGraph(['a', 'b', 'c', 'd'], [{ source: 'a', target: 'b' }]);
    const b = makeGraph(['a', 'b', 'c', 'd'], [{ source: 'a', target: 'b' }]);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
  });

  it('节点半径随依赖度增长并封顶,hub 气泡更大', () => {
    expect(nodeRadius(0)).toBe(FORCE_DEFAULTS.baseRadius);
    expect(nodeRadius(5)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(99)).toBe(FORCE_DEFAULTS.maxRadius);
  });

  it('引用不存在节点的边被丢弃,不会让模拟崩溃', () => {
    const model = makeGraph(['a', 'b'], [{ source: 'a', target: 'ghost' }]);
    expect(model.links).toHaveLength(0);
  });

  it('播种位置落在画布边界内', () => {
    const model = makeGraph(['a', 'b', 'c'], []);
    for (const node of model.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(FORCE_DEFAULTS.boundsPad);
      expect(node.x).toBeLessThanOrEqual(FORCE_DEFAULTS.width - FORCE_DEFAULTS.boundsPad);
      expect(node.y).toBeGreaterThanOrEqual(FORCE_DEFAULTS.boundsPad);
      expect(node.y).toBeLessThanOrEqual(FORCE_DEFAULTS.height - FORCE_DEFAULTS.boundsPad);
    }
  });
});

describe('tickModel / settleModel', () => {
  it('冷却后返回 false,总步数收敛(不会永远抖动)', () => {
    const model = makeGraph(
      ['web', 'api', 'db', 'cache'],
      [{ source: 'web', target: 'api' }, { source: 'api', target: 'db' }, { source: 'api', target: 'cache' }]
    );
    let ticks = 0;
    while (tickModel(model)) ticks++;
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThan(1000);
  });

  it('收敛后气泡互不重叠(含碰撞边距)', () => {
    const keys = ['web', 'api', 'db', 'cache', 'worker', 'redis', 'nginx', 'mailer'];
    const links = [
      { source: 'web', target: 'api' },
      { source: 'web', target: 'worker' },
      { source: 'api', target: 'db' },
      { source: 'api', target: 'cache' },
      { source: 'worker', target: 'db' },
      { source: 'worker', target: 'redis' },
      { source: 'nginx', target: 'web' },
      { source: 'mailer', target: 'db' },
    ];
    const model = settleModel(makeGraph(keys, links));
    for (let i = 0; i < model.nodes.length; i++) {
      for (let j = i + 1; j < model.nodes.length; j++) {
        const a = model.nodes[i];
        const b = model.nodes[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        expect(d, `${a.key} 与 ${b.key} 重叠`).toBeGreaterThanOrEqual(a.r + b.r + FORCE_DEFAULTS.collisionPad - 0.5);
      }
    }
  });

  it('收敛后每条边被拉到接近理想长度(结构可读)', () => {
    const model = makeGraph(
      ['a', 'b', 'c'],
      [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }]
    );
    settleModel(model);
    for (const link of model.links) {
      const d = Math.hypot(link.target.x - link.source.x, link.target.y - link.source.y);
      expect(d).toBeGreaterThan(FORCE_DEFAULTS.springLength * 0.5);
      expect(d).toBeLessThan(FORCE_DEFAULTS.springLength * 2.2);
    }
  });

  it('节点始终留在画布内(边界回弹)', () => {
    const model = makeGraph(['a', 'b', 'c', 'd', 'e'], [{ source: 'a', target: 'b' }]);
    settleModel(model);
    for (const node of model.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(FORCE_DEFAULTS.boundsPad - 0.5);
      expect(node.x).toBeLessThanOrEqual(FORCE_DEFAULTS.width - FORCE_DEFAULTS.boundsPad + 0.5);
      expect(node.y).toBeGreaterThanOrEqual(FORCE_DEFAULTS.boundsPad - 0.5);
      expect(node.y).toBeLessThanOrEqual(FORCE_DEFAULTS.height - FORCE_DEFAULTS.boundsPad + 0.5);
    }
  });

  it('固定节点(fixed)在 tick 中保持不动', () => {
    const model = makeGraph(['a', 'b', 'c'], [{ source: 'a', target: 'b' }]);
    const pinned = model.nodes[0];
    pinned.fixed = true;
    pinned.x = 600;
    pinned.y = 350;
    settleModel(model);
    expect(pinned.x).toBe(600);
    expect(pinned.y).toBe(350);
  });
});

describe('applySeedPositions', () => {
  it('覆盖种子坐标并夹回边界内', () => {
    const model = makeGraph(['a', 'b'], [{ source: 'a', target: 'b' }]);
    applySeedPositions(model, { a: { x: -9999, y: 200 }, b: { x: 9999, y: 500 } });
    expect(model.nodes[0].x).toBe(FORCE_DEFAULTS.boundsPad);
    expect(model.nodes[1].x).toBe(FORCE_DEFAULTS.width - FORCE_DEFAULTS.boundsPad);
  });
});
