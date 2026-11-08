/** Copy literal text on HTTPS and locally deployed HTTP, restoring focus/selection. */
export async function copyText(value) {
  const text = String(value ?? '');
  if (globalThis.navigator?.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; }
    catch { /* Browser permission or embedding policy may still allow a user-triggered legacy copy. */ }
  }
  const previous = document.activeElement;
  const inputSelection = typeof previous?.selectionStart === 'number' ? [previous.selectionStart, previous.selectionEnd, previous.selectionDirection] : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const area = document.createElement('textarea');
  area.value = text; area.readOnly = true; area.tabIndex = -1;
  area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  document.body.appendChild(area);
  try {
    area.focus({ preventScroll: true }); area.select();
    if (!document.execCommand?.('copy')) throw new Error('剪贴板不可用');
  } finally {
    area.remove(); previous?.focus?.({ preventScroll: true });
    if (inputSelection) previous.setSelectionRange(...inputSelection);
    else if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}
