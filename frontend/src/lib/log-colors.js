/**
 * 容器徽章配色:按名字哈希取色,保证同一个容器在聚合流、分栏、pane 标题里拿到同一个颜色。
 * 聚合模式与分栏模式共用一份,否则同一个容器在两种视图里会换色。
 */
const PALETTES = [
  'text-sky-300 border-sky-500/40 bg-sky-500/10',
  'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
  'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  'text-violet-300 border-violet-500/40 bg-violet-500/10',
  'text-amber-300 border-amber-500/40 bg-amber-500/10',
  'text-rose-300 border-rose-500/40 bg-rose-500/10',
];

export function hashColor(name = '') {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PALETTES[Math.abs(hash) % PALETTES.length];
}
