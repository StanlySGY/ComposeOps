/**
 * 轻量力导向图物理引擎(纯函数、确定性、零依赖)。
 *
 * 与 d3-force 的取舍:节点规模 ≤ 几十,直接 O(n²) 斥力 + 弹簧 + 碰撞即可,
 * 换来零依赖与可单测。tick 按经典力模拟组合:
 *   1. 库伦斥力(所有点对,防粘连)
 *   2. 边弹簧(depends_on 拉成舒适间距)
 *   3. 向画布中心的弱引力(防止整体飘散)
 *   4. 阻尼积分 + 碰撞分离 + 画布边界回弹
 * alpha(温度)随时间衰减,冷下来后循环停止,拖拽/数据变化时重新加热。
 */

export const FORCE_DEFAULTS = {
  width: 1200,
  height: 700,
  repulsion: 26000,
  springLength: 175,
  springStiffness: 0.04,
  gravity: 0.025,
  damping: 0.85,
  alphaStart: 1,
  alphaDecay: 0.026,
  alphaMin: 0.02,
  baseRadius: 34,
  radiusPerDegree: 2.4,
  maxRadius: 54,
  collisionPad: 12,
  boundsPad: 64,
};

/** 节点半径随连接度增长(hub 服务是更大的气泡)。 */
export function nodeRadius(degree, options = {}) {
  const o = { ...FORCE_DEFAULTS, ...options };
  return Math.min(o.maxRadius, o.baseRadius + degree * o.radiusPerDegree);
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * 构建图模型。nodes: [{key, ...}], links: [{source, target}](key 引用)。
 * 位置用黄金角螺旋确定性播种,避免每次进入页面气泡乱跳。
 */
export function createGraphModel(nodes, links, options = {}) {
  const o = { ...FORCE_DEFAULTS, ...options };
  const degree = new Map();
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) || 0) + 1);
    degree.set(link.target, (degree.get(link.target) || 0) + 1);
  }
  const cx = o.width / 2;
  const cy = o.height / 2;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const modelNodes = nodes.map((node, i) => {
    // 黄金角螺旋:均匀铺满画布,确定性
    const rr = 90 + i * 34;
    const angle = i * golden;
    const x = clamp(cx + Math.cos(angle) * rr, o.boundsPad, o.width - o.boundsPad);
    const y = clamp(cy + Math.sin(angle) * rr * 0.62, o.boundsPad, o.height - o.boundsPad);
    return {
      key: node.key,
      x,
      y,
      vx: 0,
      vy: 0,
      r: nodeRadius(degree.get(node.key) || 0, o),
      fixed: false,
    };
  });
  const byKey = new Map(modelNodes.map((n) => [n.key, n]));
  const modelLinks = links
    .filter((l) => byKey.has(l.source) && byKey.has(l.target))
    .map((l) => ({ source: byKey.get(l.source), target: byKey.get(l.target) }));
  return {
    width: o.width,
    height: o.height,
    options: o,
    nodes: modelNodes,
    links: modelLinks,
    alpha: o.alphaStart,
  };
}

/** 用外部坐标(如分层布局)覆盖种子位置,力模拟从该布局继续松弛。 */
export function applySeedPositions(model, positions) {
  if (!positions) return model;
  const o = model.options;
  for (const node of model.nodes) {
    const pos = positions.get ? positions.get(node.key) : positions[node.key];
    if (!pos) continue;
    node.x = clamp(pos.x, o.boundsPad, o.width - o.boundsPad);
    node.y = clamp(pos.y, o.boundsPad, o.height - o.boundsPad);
  }
  return model;
}

/** 推进一个物理步,返回是否仍有活动(alpha 未冷却)。原地修改 model。 */
export function tickModel(model) {
  const o = model.options;
  const alpha = model.alpha;
  if (alpha < o.alphaMin) return false;
  const nodes = model.nodes;
  const n = nodes.length;
  const cx = o.width / 2;
  const cy = o.height / 2;

  // 1. 库伦斥力(O(n²),规模小无所谓)
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        // 完全重合时给一个确定性方向,避免死锁
        dx = (i - j) * 0.7 || 0.7;
        dy = (j - i) * 0.7 || 0.7;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const force = (o.repulsion * alpha) / d2;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // 2. 边弹簧
  for (const link of model.links) {
    const a = link.source;
    const b = link.target;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (d - o.springLength) * o.springStiffness * alpha;
    const fx = (dx / d) * force;
    const fy = (dy / d) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // 3. 向中心弱引力 + 4. 阻尼积分 + 边界
  const minX = o.boundsPad;
  const maxX = o.width - o.boundsPad;
  const minY = o.boundsPad;
  const maxY = o.height - o.boundsPad;
  for (const node of nodes) {
    node.vx += (cx - node.x) * o.gravity * alpha;
    node.vy += (cy - node.y) * o.gravity * alpha;
    if (node.fixed) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= o.damping;
    node.vy *= o.damping;
    node.x += node.vx;
    node.y += node.vy;
    if (node.x < minX) {
      node.x = minX;
      node.vx *= -0.4;
    } else if (node.x > maxX) {
      node.x = maxX;
      node.vx *= -0.4;
    }
    if (node.y < minY) {
      node.y = minY;
      node.vy *= -0.4;
    } else if (node.y > maxY) {
      node.y = maxY;
      node.vy *= -0.4;
    }
  }

  // 5. 碰撞分离(位置直接校正,视觉上气泡永不重叠)
  //    节点带 w/h 时按矩形(AABB)处理——卡片类节点用圆形碰撞会低估实际占位,
  //    两张 196x68 的卡片中心距 100 时视觉已经压叠,圆形判定却完全不触发。
  //    成对修正会互相打架,每 tick 跑两遍收敛得更干净。
  resolveCollisions(nodes, o.collisionPad);
  resolveCollisions(nodes, o.collisionPad);

  model.alpha = alpha * (1 - o.alphaDecay);
  return model.alpha >= o.alphaMin;
}

/** 一遍成对碰撞校正(位置直接修正)。矩形优先,无 w/h 退回圆形。 */
function resolveCollisions(nodes, pad = 12) {
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let ux, uy, push;
      if (a.w && a.h && b.w && b.h) {
        const overlapX = (a.w + b.w) / 2 - Math.abs(dx);
        const overlapY = (a.h + b.h) / 2 - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (dx === 0 && dy === 0) {
          // 完全重合:给一个确定性的分离方向,避免死锁
          ux = 1; uy = (i - j) * 0.5 || 0.5;
        } else if (overlapX < overlapY) {
          ux = Math.sign(dx) || 1; uy = 0;
        } else {
          ux = 0; uy = Math.sign(dy) || 1;
        }
        push = Math.min(overlapX, overlapY) / 2;
      } else {
        const min = a.r + b.r + pad;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 === 0) continue;
        const d = Math.sqrt(d2);
        push = (min - d) / 2;
        ux = dx / d;
        uy = dy / d;
      }
      if (!a.fixed) {
        a.x -= ux * push;
        a.y -= uy * push;
      }
      if (!b.fixed) {
        b.x += ux * push;
        b.y += uy * push;
      }
    }
  }
}

/** 无重叠收尾:物理冷却后纯碰撞校正,直到互不压叠(弹簧/斥力已不再捣乱)。 */
function deOverlap(nodes, maxIterations = 60) {
  for (let i = 0; i < maxIterations; i++) {
    const before = nodes.map((n) => `${n.x},${n.y}`).join('|');
    resolveCollisions(nodes);
    if (nodes.map((n) => `${n.x},${n.y}`).join('|') === before) return;
  }
}

/** 连续推进直到冷却(测试/一次性布局用);冷却后做纯解重叠收尾。 */
export function settleModel(model, maxTicks = 600) {
  for (let i = 0; i < maxTicks; i++) {
    if (!tickModel(model)) break;
  }
  deOverlap(model.nodes);
  return model;
}
