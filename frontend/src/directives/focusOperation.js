/** Focus a linked durable record once; polling updates must not steal focus. */
function focusOperation(element, binding) {
  const selected = binding.value === true;
  element.classList.toggle('ring-2', selected);
  element.classList.toggle('ring-emerald-500/60', selected);
  if (selected && !binding.oldValue) {
    element.setAttribute('tabindex', '-1');
    element.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    element.focus({ preventScroll: true });
  } else if (!selected && binding.oldValue) element.removeAttribute('tabindex');
}
export default { mounted: focusOperation, updated: focusOperation };
