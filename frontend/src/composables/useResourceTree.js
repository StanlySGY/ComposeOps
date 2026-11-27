import { ref, watch } from 'vue';

/** Persistent per-host tree state; search expands ancestors without mutating it. */
export function useResourceTree(hostId, scope) {
  const expanded = ref(new Set()), collapsedGroups = ref(new Set());
  const key = () => `composeops.tree.${scope}.${hostId.value}`;
  function read() {
    try { const value = JSON.parse(localStorage.getItem(key()) || '{}'); expanded.value = new Set(Array.isArray(value.expanded) ? value.expanded : []); collapsedGroups.value = new Set(Array.isArray(value.collapsedGroups) ? value.collapsedGroups : []); }
    catch { expanded.value = new Set(); collapsedGroups.value = new Set(); }
  }
  watch(hostId, read, { immediate: true });
  function persist() { try { localStorage.setItem(key(), JSON.stringify({ expanded: [...expanded.value], collapsedGroups: [...collapsedGroups.value] })); } catch { /* Storage may be disabled. */ } }
  function toggle(set, id) { const next = new Set(set.value); if (next.has(id)) next.delete(id); else next.add(id); set.value = next; persist(); }
  return { expanded, collapsedGroups, persist, toggleProject: id => toggle(expanded, id), toggleGroup: id => toggle(collapsedGroups, id) };
}
