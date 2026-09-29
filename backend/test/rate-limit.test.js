import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRateLimit, resetRateLimits } from '../src/lib/rate-limit.js';

test('limit: 窗口内超过配额被拒并返回重试时间', () => {
  resetRateLimits();
  const key = 'test:a';
  assert.equal(checkRateLimit(key, 2, 60000).allowed, true);
  assert.equal(checkRateLimit(key, 2, 60000).allowed, true);
  const third = checkRateLimit(key, 2, 60000);
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterMs > 0 && third.retryAfterMs <= 60000);
});

test('limit: 窗口过期后重新计数', () => {
  resetRateLimits();
  const key = 'test:b';
  assert.equal(checkRateLimit(key, 1, 50).allowed, true);
  assert.equal(checkRateLimit(key, 1, 50).allowed, false);
  // 等 60ms 让窗口过期
  return new Promise((resolve) => setTimeout(resolve, 60)).then(() => {
    const next = checkRateLimit(key, 1, 50);
    assert.equal(next.allowed, true);
  });
});

test('limit: 不同 key 互不影响,reset 清空', () => {
  resetRateLimits();
  assert.equal(checkRateLimit('test:c', 1, 60000).allowed, true);
  assert.equal(checkRateLimit('test:d', 1, 60000).allowed, true);
  assert.equal(checkRateLimit('test:c', 1, 60000).allowed, false);
  resetRateLimits();
  assert.equal(checkRateLimit('test:c', 1, 60000).allowed, true);
});
