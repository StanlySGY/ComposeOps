import { describe, expect, it } from 'vitest';
import { computeTopologyLayout, assignLevels, TOPO_DEFAULTS } from '../src/lib/topology-layout.js';

const { nodeW, nodeH, minWidth, minHeight, padY } = TOPO_DEFAULTS;

/** 节点盒(以中心 x,y 与固定宽高计)必须整体落在画布内,否则会被 viewBox 裁掉。 */
function expectAllNodesInside(layout) {
  for (const node of layout.nodes) {
    const top = node.y - nodeH / 2;
    const bottom = node.y + nodeH / 2;
    const left = node.x - nodeW / 2;
    const right = node.x + nodeW / 2;
    expect(top, `节点 ${node.name} 顶部越出画布上沿`).toBeGreaterThanOrEqual(0);
    expect(bottom, `节点 ${node.name} 底部越出画布下沿`).toBeLessThanOrEqual(layout.height);
    expect(left, `节点 ${node.name} 左侧越出画布左沿`).toBeGreaterThanOrEqual(0);
    expect(right, `节点 ${node.name} 右侧越出画布右沿`).toBeLessThanOrEqual(layout.width);
  }
}

describe('computeTopologyLayout', () => {
  it('用户实测场景:1 个服务被 4 个依赖,共 7 节点,全部完整可见(旧算法顶部节点被裁)', () => {
    // 旧实现 y = 60 + (index-(count-1)/2)*90:同层 4 节点时顶部节点 y=-75,直接被 viewBox 裁掉
    const services = [
      { name: 'mineru-code-sync', dependsOn: [] },
      { name: 'mineru-api-3', dependsOn: ['mineru-code-sync'] },
      { name: 'mineru-api-4', dependsOn: ['mineru-code-sync'] },
      { name: 'mineru-router', dependsOn: ['mineru-code-sync'] },
      { name: 'mineru-ops', dependsOn: ['mineru-code-sync'] },
      { name: 'mineru-web', dependsOn: ['mineru-api-3', 'mineru-api-4'] },
      { name: 'mineru-worker', dependsOn: [] },
    ];
    const layout = computeTopologyLayout(services);
    expect(layout.nodes).toHaveLength(7);
    expectAllNodesInside(layout);
    // 同层节点以画布垂直中点对称展开
    const level1 = layout.nodes.filter((n) => n.level === 1);
    expect(level1).toHaveLength(4);
    const avg = level1.reduce((s, n) => s + n.y, 0) / level1.length;
    expect(avg).toBe(layout.height / 2);
  });

  it('单层节点越多画布越高,任何数量都不越界', () => {
    const { nodeGap } = TOPO_DEFAULTS;
    for (const count of [1, 2, 3, 5, 8, 12]) {
      const services = Array.from({ length: count }, (_, i) => ({ name: `svc-${i}`, dependsOn: [] }));
      const layout = computeTopologyLayout(services);
      expect(layout.nodes).toHaveLength(count);
      expectAllNodesInside(layout);
      // 画布高度必须容纳该层的实际展开跨度;超过最小高度后随节点数增长
      const required = (count - 1) * nodeGap + nodeH + padY * 2;
      expect(layout.height).toBe(Math.max(minHeight, required));
      if (required > minHeight) expect(layout.height).toBeGreaterThan(minHeight);
    }
  });

  it('单节点时画布不被拉伸放大(曾有 viewBox 放大数倍的问题)', () => {
    const layout = computeTopologyLayout([{ name: 'only', dependsOn: [] }]);
    expect(layout.width).toBe(minWidth);
    expect(layout.height).toBe(minHeight);
    expectAllNodesInside(layout);
  });

  it('依赖者层数更深(被依赖者在左)', () => {
    const layout = computeTopologyLayout([
      { name: 'db', dependsOn: [] },
      { name: 'cache', dependsOn: [] },
      { name: 'api', dependsOn: ['db', 'cache'] },
      { name: 'web', dependsOn: ['api'] },
    ]);
    const level = Object.fromEntries(layout.nodes.map((n) => [n.name, n.level]));
    expect(level.db).toBe(0);
    expect(level.cache).toBe(0);
    expect(level.api).toBe(1);
    expect(level.web).toBe(2);
    const api = layout.nodes.find((n) => n.name === 'api');
    const web = layout.nodes.find((n) => n.name === 'web');
    expect(api.x).toBeLessThan(web.x);
    expectAllNodesInside(layout);
  });

  it('环依赖不死循环且有完整布局', () => {
    const layout = computeTopologyLayout([
      { name: 'a', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'c', dependsOn: ['a'] },
    ]);
    expect(layout.nodes).toHaveLength(3);
    expectAllNodesInside(layout);
  });

  it('空服务清单返回最小画布,不抛错', () => {
    const layout = computeTopologyLayout([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.width).toBe(minWidth);
    expect(layout.height).toBe(minHeight);
  });

  it('assignLevels 给出层内索引与数量(供居中公式使用)', () => {
    const levels = assignLevels([
      { name: 'x', dependsOn: [] },
      { name: 'y', dependsOn: [] },
      { name: 'z', dependsOn: ['x', 'y'] },
    ]);
    const sameLevel = levels.filter((item) => item.level === 0);
    expect(sameLevel).toHaveLength(2);
    expect(sameLevel.map((item) => item.index)).toEqual([0, 1]);
    expect(sameLevel[0].count).toBe(2);
    expect(padY).toBeGreaterThan(0);
  });
});
