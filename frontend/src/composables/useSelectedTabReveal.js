import { nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from 'vue';

export function useSelectedTabReveal(navigation, selected) {
  let observer;
  let active = true;
  async function reveal() {
    await nextTick();
    if (!active) return;
    const nav = navigation.value;
    const item = nav?.querySelector('[aria-pressed="true"], [aria-current="page"]');
    if (!item) return;
    const bounds = nav.getBoundingClientRect();
    const current = item.getBoundingClientRect();
    if (current.left < bounds.left) nav.scrollLeft -= bounds.left - current.left + 6;
    else if (current.right > bounds.right) nav.scrollLeft += current.right - bounds.right + 6;
  }
  function start() {
    active = true;
    if (!observer && navigation.value && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(reveal);
      observer.observe(navigation.value);
    }
    void reveal();
  }
  function stop() { active = false; observer?.disconnect(); observer = null; }
  watch(selected, reveal);
  onMounted(start); onActivated(start); onDeactivated(stop); onBeforeUnmount(stop);
}
