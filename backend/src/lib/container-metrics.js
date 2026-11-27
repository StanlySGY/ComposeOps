/** Docker CLI-compatible working set; cgroup v2, v1, then legacy Docker. */
export function containerMemory(raw = {}) {
  const value = key => Number.isFinite(Number(key)) ? Math.max(0, Number(key)) : 0;
  const usage = value(raw.usage);
  const cache = value(raw.stats?.inactive_file ?? raw.stats?.total_inactive_file ?? raw.stats?.cache);
  const used = usage - (cache < usage ? cache : 0);
  const limit = value(raw.limit);
  return { used, limit, percent: limit > 0 ? used / limit * 100 : null };
}
