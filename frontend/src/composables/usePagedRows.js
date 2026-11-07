import { computed, ref, toValue, watch } from 'vue';

/** Bounded rendering for fetched history. Never mutate the source array. */
export function usePagedRows(source, fields, initialKey, size = 20) {
  const page = ref(1);
  const pageSize = ref(size);
  const sortKey = ref(initialKey);
  const descending = ref(true);
  const sorted = computed(() => [...(toValue(source) || [])].sort((a, b) => {
    const getter = fields[sortKey.value] || fields[initialKey];
    const x = getter(a) ?? ''; const y = getter(b) ?? '';
    const diff = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-CN', { numeric: true });
    return descending.value ? -diff : diff;
  }));
  const total = computed(() => sorted.value.length);
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
  const rows = computed(() => sorted.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
  watch([() => toValue(source), sortKey, descending, pageSize], () => { page.value = 1; });
  watch(pageCount, count => { page.value = Math.min(page.value, count); });
  function sortBy(key) { if (sortKey.value === key) descending.value = !descending.value; else { sortKey.value = key; descending.value = true; } }
  function ariaSort(key) { return sortKey.value !== key ? 'none' : descending.value ? 'descending' : 'ascending'; }
  return { page, pageSize, pageCount, rows, total, sortKey, descending, sortBy, ariaSort };
}
