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

describe('矩形节点碰撞(卡片 w/h)', () => {
  function makeCardGraph(keys, links, pos) {
    const model = createGraphModel(keys.map((key) => ({ key })), links, { alphaDecay: 0.05 });
    applySeedPositions(model, pos);
    for (const node of model.nodes) { node.w = 220; node.h = 92; node.r = 110; }
    return model;
  }

  it('矩形卡片视觉压叠时也会被推开(圆形碰撞低估卡片占位的回归用例)', () => {
    // 中心距 120:卡片 220 宽,视觉已压叠;圆形 r=34 的旧实现完全不会触发
    const model = makeCardGraph(['a', 'b'], [], { a: { x: 600, y: 350 }, b: { x: 720, y: 350 } });
    settleModel(model);
    const [a, b] = model.nodes;
    const overlapX = 220 - Math.abs(b.x - a.x);
    const overlapY = 92 - Math.abs(b.y - a.y);
    expect(overlapX > 0 && overlapY > 0).toBe(false);
  });

  it('完全重合的出生点(跨项目同层同序)也会被确定性分离', () => {
    const model = makeCardGraph(['p1/web', 'p2/web'], [], { 'p1/web': { x: 600, y: 350 }, 'p2/web': { x: 600, y: 350 } });
    settleModel(model);
    const [a, b] = model.nodes;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    expect(dx >= 220 || dy >= 92).toBe(true);
  });

  it('矩形分离后互不压叠(AABB)', () => {
    const model = makeCardGraph(
      ['a', 'b', 'c', 'd'],
      [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'a', target: 'd' }],
      null
    );
    settleModel(model);
    for (let i = 0; i < model.nodes.length; i++) {
      for (let j = i + 1; j < model.nodes.length; j++) {
        const a = model.nodes[i];
        const b = model.nodes[j];
        const overlapX = (a.w + b.w) / 2 - Math.abs(b.x - a.x);
        const overlapY = (a.h + b.h) / 2 - Math.abs(b.y - a.y);
        expect(overlapX > 0 && overlapY > 0, `${a.key} 与 ${b.key} 压叠`).toBe(false);
      }
    }
  });
});
