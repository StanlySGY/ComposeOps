// A browser request belongs to the session in which it was started. This is
// client-side response ownership, never a substitute for server authorization.
let epoch = 0;
const listeners = new Set();
export const getAuthEpoch = () => epoch;
export function onAuthEpochChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function advanceAuthEpoch() {
  epoch += 1;
  for (const listener of listeners) listener(epoch);
}
export function assertAuthEpoch(expected) {
  if (expected !== epoch) throw new DOMException('登录状态已变化，请重新读取；已提交的操作需核对结果。', 'AbortError');
}
