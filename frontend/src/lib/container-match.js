import { searchCommands } from './command-search.js';

/**
 * 容器模糊匹配(借鉴 Dozzle 的 "Intelligent fuzzy search for container names")。
 * 复用命令面板的 searchCommands:英文允许跳字缩写(cmp → compose),中文保持整词匹配。
 */
export function filterContainers(containers, query) {
  const items = Array.isArray(containers) ? containers : [];
  const needle = String(query || '').trim();
  if (!needle) return items;
  return searchCommands(
    items.map((container) => ({
      container,
      label: container.name || container.id,
      description: container.id,
      category: `${container.state || ''} ${container.image || ''}`.trim(),
    })),
    needle
  ).map((item) => item.container);
}
