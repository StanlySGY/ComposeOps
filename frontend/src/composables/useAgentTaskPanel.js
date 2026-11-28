import { computed, ref, watch, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
import { DATA_CHANGED_EVENT } from '../lib/data-changes.js';

/** Own list reads and actions for one visible panel scope, independently of polling generations. */
export function useAgentTaskPanel({ scope = () => true, read, apply, interval, reset }) {
  const loading = ref(false), busy = ref(false), readError = ref(''), actionError = ref('');
  const error = computed(() => actionError.value || readError.value);
  let enabled = false, disposed = false, generation = 0, readGeneration = 0;
  let timer, readController, actionController;
  const canRead = () => enabled && !document.hidden && !!scope();

  function cancelRead() {
    readGeneration++;
    readController?.abort();
    clearTimeout(timer);
    loading.value = false;
  }
  function cancelActionRead() { actionController?.abort(); }
  function invalidate() {
    generation++;
    cancelRead();
    cancelActionRead();
    busy.value = false;
    readError.value = '';
    actionError.value = '';
    reset();
  }
  async function reload() {
    if (!canRead()) return;
    cancelRead();
    const current = readGeneration, owner = scope();
    const isCurrent = () => canRead() && current === readGeneration && owner === scope();
    readController = new AbortController();
    loading.value = true;
    try {
      const result = await read(readController.signal);
      if (isCurrent()) { apply(result); readError.value = ''; }
    } catch (cause) {
      if (isCurrent() && cause.name !== 'AbortError') readError.value = cause.message || '任务状态暂不可用，请刷新核对。';
    } finally {
      if (isCurrent()) {
        loading.value = false;
        const delay = readError.value ? 5000 : interval();
        if (delay > 0) timer = setTimeout(reload, delay);
      }
    }
  }
  async function action(work) {
    if (!enabled || !scope() || busy.value) return;
    const current = generation, owner = scope();
    const isCurrent = () => enabled && current === generation && owner === scope();
    actionController = new AbortController();
    busy.value = true;
    actionError.value = '';
    try {
      // The signal is only for follow-up reads. A submitted mutation is never
      // cancelled or retried merely because its panel/session has gone away.
      await work({ isCurrent, signal: actionController.signal });
      if (isCurrent()) await reload();
    } catch (cause) {
      if (isCurrent() && cause.name !== 'AbortError') actionError.value = cause.message || '操作结果暂不可用，请核对任务记录。';
    } finally {
      if (isCurrent()) busy.value = false;
    }
  }
  function visibilityChanged() {
    if (document.hidden) cancelRead();
    else void reload();
  }
  function start() {
    if (enabled || disposed) return;
    enabled = true;
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener(DATA_CHANGED_EVENT, reload);
    void reload();
  }
  function stop() {
    enabled = false;
    document.removeEventListener('visibilitychange', visibilityChanged);
    window.removeEventListener(DATA_CHANGED_EVENT, reload);
    invalidate();
  }
  watch(scope, () => { invalidate(); void reload(); }, { flush: 'sync' });
  onMounted(start);
  onActivated(start);
  onDeactivated(stop);
  onBeforeUnmount(() => { disposed = true; stop(); });
  return { loading, busy, error, reload, action, cancelActionRead };
}
