/**
 * Implements expected arrow/Home/End keyboard behavior for a tablist.
 * Each tab provides a stable data-tab value; the caller owns activation and state updates.
 */
export function handleTablistKeydown(event, onSelect) {
  const currentTab = event.target?.closest?.('[role="tab"]');
  const tablist = event.currentTarget;
  if (!currentTab || !tablist?.contains(currentTab)) return false;

  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const currentIndex = tabs.indexOf(currentTab);
  if (currentIndex < 0 || tabs.length === 0) return false;

  let nextIndex;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = tabs.length - 1;
  } else {
    return false;
  }

  const nextTab = tabs[nextIndex];
  if (!nextTab?.dataset.tab) return false;
  event.preventDefault();
  nextTab.focus();
  onSelect(nextTab.dataset.tab);
  return true;
}
