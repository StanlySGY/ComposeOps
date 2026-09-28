/**
 * 服务拓扑分层布局(纯函数):供 TopologyView 渲染与单测覆盖。
 *
 * 这里修掉过一个用户可见的布局 bug:层内节点此前以固定 y=60 为中心展开,
 * 同层节点一多,最顶上的节点纵坐标变成负值,整体被 SVG viewBox 裁掉——
 * 页面上看就是"节点被上面的面板盖住了",7 个服务只显示 5 个。
 * 现在的规则:
 *  - 每层节点列以画布垂直中点居中展开;
 *  - 画布高度按"层内最多节点数"实算,计入节点自身高度与上下边距,
 *    保证任何层的首尾节点都完整落在画布内;
 *  - 画布宽度有下限,节点少时 viewBox 不被拉伸放大。
 */

export const TOPO_DEFAULTS = Object.freeze({
  nodeW: 150,
  nodeH: 52,
  levelGap: 220,
  nodeGap: 90,
  minWidth: 720,
  minHeight: 420,
  padX: 80,
  padY: 40,
});

/**
 * 依赖深度分层:被依赖者层数小(在左),依赖者层数大(在右)。
 * 环依赖用访问栈兜底(环内成员按 0 层计),保证有结果不死循环。
 */
export function assignLevels(serviceList) {
  const levelMap = new Map();
  const visit = (name, visiting) => {
    if (levelMap.has(name)) return levelMap.get(name);
    if (visiting.has(name)) return 0;
    visiting.add(name);
    const svc = serviceList.find((s) => s.name === name);
    let level = 0;
    if (svc) {
      for (const dep of svc.dependsOn) {
        level = Math.max(level, visit(dep, visiting) + 1);
      }
    }
    visiting.delete(name);
    levelMap.set(name, level);
    return level;
  };
  for (const svc of serviceList) visit(svc.name, new Set());

  const byLevel = new Map();
  for (const [name, level] of levelMap) {
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(name);
  }
  const result = [];
  for (const [level, names] of byLevel) {
    names.forEach((name, index) => result.push({ name, level, index, count: names.length }));
  }
  return result;
}

/**
 * 计算整图布局。
 * @param {Array<{name:string, dependsOn:string[]}>} serviceList 服务清单
 * @param {object} [options] 覆盖 TOPO_DEFAULTS 中的几何参数
 * @returns {{ nodes: Array<{name:string,x:number,y:number,level:number}>, width:number, height:number }}
 */
export function computeTopologyLayout(serviceList, options = {}) {
  const opts = { ...TOPO_DEFAULTS, ...options };
  const levels = assignLevels(serviceList);
  const maxCount = Math.max(0, ...levels.map((item) => item.count));
  const maxLevel = Math.max(0, ...levels.map((item) => item.level));

  // 首尾节点完整可见:(count-1)*nodeGap(层内展开跨度) + nodeH(节点自身) + 上下边距
  const height = Math.max(opts.minHeight, (Math.max(maxCount, 1) - 1) * opts.nodeGap + opts.nodeH + opts.padY * 2);
  // 水平与旧版一致:80 起点 + 层间距,留出节点宽度
  const width = Math.max(opts.minWidth, 160 + maxLevel * opts.levelGap + opts.nodeW);

  const nodes = levels.map((item) => ({
    name: item.name,
    level: item.level,
    x: opts.padX + item.level * opts.levelGap,
    y: height / 2 + (item.index - (item.count - 1) / 2) * opts.nodeGap,
  }));
  return { nodes, width, height };
}
