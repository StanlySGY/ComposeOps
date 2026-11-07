/** Capture only the bounded, retained buffer. Docker's second-granularity query
 * deliberately overlaps one second; full timestamp strings preserve nanoseconds
 * when matching replayed lines. Counts preserve genuinely repeated messages. */
export function createLogResume(lines) {
  const since = Object.create(null);
  const seen = new Map();
  const key = line => JSON.stringify([line.containerId, line.type, line.ts, line.data]);
  for (const line of lines) {
    const at = Date.parse(line.ts);
    if (!line.containerId || !Number.isFinite(at) || at <= 0) continue;
    since[line.containerId] = Math.max(since[line.containerId] || 0, Math.floor(at / 1000) - 1);
  }
  // Keep the handshake small, including when a project has many containers.
  if (Object.keys(since).length > 64) return { query: '', accept: () => true };
  for (const line of lines) {
    if (!Object.hasOwn(since, line.containerId) || Date.parse(line.ts) < since[line.containerId] * 1000 || !line.ts) continue;
    const id = key(line);
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  const query = Object.keys(since).length ? `&resume=${encodeURIComponent(JSON.stringify(since))}` : '';
  return {
    query,
    accept(line) {
      const id = key(line);
      const remaining = seen.get(id) || 0;
      if (!remaining) return true;
      if (remaining === 1) seen.delete(id);
      else seen.set(id, remaining - 1);
      return false;
    },
  };
}
