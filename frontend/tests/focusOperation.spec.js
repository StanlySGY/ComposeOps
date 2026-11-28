import { expect, it, vi } from 'vitest';
import directive from '../src/directives/focusOperation.js';
it('focuses linked evidence once without stealing focus on every polling update', () => {
  const element = document.createElement('section'); document.body.append(element);
  element.scrollIntoView = vi.fn();
  directive.mounted(element, { value: true });
  expect(document.activeElement).toBe(element); expect(element.classList.contains('ring-2')).toBe(true);
  directive.updated(element, { value: true, oldValue: true });
  expect(element.scrollIntoView).toHaveBeenCalledTimes(1);
  directive.updated(element, { value: false, oldValue: true });
  expect(element.hasAttribute('tabindex')).toBe(false); expect(element.classList.contains('ring-2')).toBe(false);
  element.remove();
});
