const STORAGE_KEY = 'composeops:recent-pages';
const LIMIT = 5;

// Keep only IDs from the current static page catalogue, never query text,
// project/container identifiers, node switches or executable actions.
function sanitize(ids, allowedIds) {
  const allowed = new Set(allowedIds);
  return [...new Set(Array.isArray(ids) ? ids : [])].filter(id => typeof id === 'string' && allowed.has(id)).slice(0, LIMIT);
}

export function readRecentPages(allowedIds) {
  try { return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY)), allowedIds); }
  catch { return []; }
}

export function rememberPage(ids, id, allowedIds) {
  const next = sanitize([id, ...ids], allowedIds);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Navigation still works with storage disabled. */ }
  return next;
}

export function clearRecentPages() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* In-memory clearing remains available. */ }
  return [];
}
