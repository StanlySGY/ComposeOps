import { computed, onBeforeUnmount, ref, watch } from 'vue';

// Snapshots stay in memory: settings may contain passwords and API keys.
export function useFormDraft(read, restore) {
  const saved = ref(null);
  const dirty = computed(() => saved.value !== null && JSON.stringify(read()) !== saved.value);
  function accept() { saved.value = JSON.stringify(read()); }
  function revert() { if (saved.value !== null) restore(JSON.parse(saved.value)); }
  return { dirty, accept, revert };
}

export function useUnsavedChanges(dirty) {
  function preventUnload(event) { event.preventDefault(); event.returnValue = ''; }
  watch(dirty, value => {
    if (value) window.addEventListener('beforeunload', preventUnload);
    else window.removeEventListener('beforeunload', preventUnload);
  }, { immediate: true, flush: 'sync' });
  // Keep protection while a cached settings page is inactive.
  onBeforeUnmount(() => window.removeEventListener('beforeunload', preventUnload));
}
