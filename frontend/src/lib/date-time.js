/** API timestamps may be SQLite UTC strings, ISO values with offsets, or epoch milliseconds. */
export function parseTimestamp(value) {
  if (value == null || value === '') return null;
  let normalized = value;
  if (typeof value === 'string') {
    normalized = value.trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)) normalized = normalized.replace(' ', 'T') + 'Z';
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTimestamp(value) {
  return parseTimestamp(value)?.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) || '—';
}
