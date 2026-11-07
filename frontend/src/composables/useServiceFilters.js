import { computed, reactive, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const FILTERS = ['all', 'attention', 'running', 'stopped', 'managed', 'unmanaged', 'favorites'];
const SORTS = ['priority', 'name', 'owner'];

export function readServiceFilters(query = {}) {
  return {
    q: typeof query.q === 'string' ? query.q : '',
    filter: FILTERS.includes(query.filter) ? query.filter : 'all',
    sort: SORTS.includes(query.sort) ? query.sort : 'priority',
  };
}

export function useServiceFilters() {
  const route = useRoute();
  const router = useRouter();
  const state = reactive(readServiceFilters(route.query));
  // A cached services page must not read another page's query or rewrite it.
  watch(() => route.fullPath, () => {
    if (route.name === 'services') Object.assign(state, readServiceFilters(route.query));
  });

  function setFilters(patch) {
    if (route.name !== 'services') return;
    Object.assign(state, patch);
    const query = { ...route.query };
    delete query.focus;
    for (const key of ['q', 'filter', 'sort']) {
      const value = state[key];
      if (!value || (key === 'filter' && value === 'all') || (key === 'sort' && value === 'priority')) delete query[key];
      else query[key] = value;
    }
    // Replace while refining a list; returning from a detail page restores the
    // complete view without adding an entry for every typed character.
    void router.replace({ query });
  }

  const field = key => computed({ get: () => state[key], set: value => setFilters({ [key]: value }) });
  return {
    searchQuery: field('q'), filter: field('filter'), sort: field('sort'),
    resetFilters: () => setFilters({ q: '', filter: 'all', sort: 'priority' }),
  };
}
