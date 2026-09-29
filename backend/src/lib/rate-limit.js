/**
 * 进程内固定窗口限流(单用户场景,不需要 Redis)。
 * AI 端点防手滑重放/失控循环刷爆上游 API;窗口与配额都取得较宽,正常使用无感。
 */

const buckets = new Map();
const MAX_KEYS = 2000;

/**
 * 检查并消耗一次配额。
 * @param {string} key 维度键(如 `ai:${ip}:chat`)
 * @param {number} limit 窗口内允许次数
 * @param {number} windowMs 窗口时长
 * @returns {{ allowed: boolean, remaining: number, retryAfterMs?: number }}
 */
export function checkRateLimit(key, limit, windowMs = 60000) {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const safeWindow = Math.max(10, Math.floor(Number(windowMs) || 60000));
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now - entry.start >= safeWindow) {
    if (buckets.size >= MAX_KEYS) {
      for (const [k, v] of buckets) {
        if (now - v.start >= safeWindow) buckets.delete(k);
      }
      if (buckets.size >= MAX_KEYS) buckets.clear();
    }
    buckets.set(key, { start: now, count: 1 });
    return { allowed: true, remaining: safeLimit - 1 };
  }
  entry.count += 1;
  if (entry.count > safeLimit) {
    return { allowed: false, remaining: 0, retryAfterMs: safeWindow - (now - entry.start) };
  }
  return { allowed: true, remaining: safeLimit - entry.count };
}

/** 清空全部窗口(测试用)。 */
export function resetRateLimits() {
  buckets.clear();
}
