function normalize(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase(); }

function matchScore(text, query) {
  if (text === query) return 100;
  if (text.startsWith(query)) return 80;
  const index = text.indexOf(query);
  if (index >= 0) return 60 - Math.min(index, 20);
  // 英文缩写允许跳字匹配(如 cmp → compose);中文保持词语匹配,减少误命中。
  if (!/^[a-z0-9_-]{2,}$/.test(query)) return 0;
  let cursor = 0;
  let first = -1;
  for (const char of query) {
    const found = text.indexOf(char, cursor);
    if (found < 0) return 0;
    if (first < 0) first = found;
    cursor = found + 1;
  }
  return Math.max(1, 25 - (cursor - first - query.length));
}

/** 多个关键词可跨名称、描述和分类匹配;名称更相关的结果优先,同分保持原顺序。 */
export function searchCommands(commands, query) {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return commands;
  return commands.map((command, index) => {
    const fields = [[normalize(command.label), 3], [normalize(command.description), 2], [normalize(command.category), 1]];
    const scores = tokens.map(token => Math.max(...fields.map(([text, weight]) => matchScore(text, token) * weight)));
    return { command, index, score: scores.every(score => score > 0) ? scores.reduce((sum, score) => sum + score, 0) : 0 };
  }).filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(result => result.command);
}
