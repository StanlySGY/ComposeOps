// A browser request belongs to the session in which it was started. This is
// client-side response ownership, never a substitute for server authorization.
let epoch = 0;
export const getAuthEpoch = () => epoch;
export function advanceAuthEpoch() { epoch += 1; }
export function assertAuthEpoch(expected) {
  if (expected !== epoch) throw new DOMException('登录状态已变化，请重新读取；已提交的操作需核对结果。', 'AbortError');
}
