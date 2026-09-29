import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-search-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { setSetting } = await import('../src/lib/db.js');
const { searchWeb, getSearchConfig, setSearchConfig, SEARCH_PROVIDERS } = await import('../src/services/ai.js');

const originalFetch = globalThis.fetch;

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  return calls;
}

test('search: 配置读写与非法 provider 拒绝', () => {
  assert.deepEqual(SEARCH_PROVIDERS.includes('tavily'), true);
  assert.deepEqual(SEARCH_PROVIDERS.includes('builtin'), true);
  setSearchConfig({ provider: 'brave', apiKey: 'brave-key-1', baseUrl: '' });
  const cfg = getSearchConfig();
  assert.equal(cfg.provider, 'brave');
  assert.equal(cfg.apiKey, 'brave-key-1');
  assert.throws(() => setSearchConfig({ provider: 'bing' }), /不支持的检索后端/);
});

test('search: tavily 后端携带 Key 并解析结果', async () => {
  setSetting('ai.search.provider', 'tavily');
  setSetting('ai.search.api_key', 'tvly-1');
  const calls = stubFetch(async () => ({
    ok: true,
    json: async () => ({ results: [{ title: 'T1', url: 'https://a', content: '片段A' }] }),
  }));
  const results = await searchWeb('docker oom');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'T1');
  assert.equal(results[0].snippet, '片段A');
  assert.match(calls[0].url, /api\.tavily\.com/);
  assert.match(calls[0].options.body, /tvly-1/);
  globalThis.fetch = originalFetch;
});

test('search: brave 后端走订阅头,searxng 走自托管 JSON', async () => {
  setSetting('ai.search.provider', 'brave');
  setSetting('ai.search.api_key', 'bsk-1');
  let calls = stubFetch(async () => ({
    ok: true,
    json: async () => ({ web: { results: [{ title: 'B1', url: 'https://b', description: 'desc' }] } }),
  }));
  let results = await searchWeb('q');
  assert.equal(results[0].title, 'B1');
  assert.equal(calls[0].options.headers['X-Subscription-Token'], 'bsk-1');
  globalThis.fetch = originalFetch;

  setSetting('ai.search.provider', 'searxng');
  setSetting('ai.search.base_url', 'https://searx.local');
  calls = stubFetch(async () => ({
    ok: true,
    json: async () => ({ results: [{ title: 'S1', url: 'https://s', content: 'c' }] }),
  }));
  results = await searchWeb('q');
  assert.equal(results[0].title, 'S1');
  assert.match(calls[0].url, /searx\.local\/search/);
  globalThis.fetch = originalFetch;
});

test('search: 配置的后端失败时回退 DuckDuckGo,最终绝不抛错', async () => {
  setSetting('ai.search.provider', 'tavily');
  setSetting('ai.search.api_key', 'bad-key');
  const calls = stubFetch(async (url) => {
    if (url.includes('tavily.com')) return { ok: false, status: 401 };
    // DuckDuckGo 回退:无摘要也返回空
    return { ok: true, json: async () => ({}) };
  });
  const results = await searchWeb('anything');
  assert.deepEqual(results, []);
  assert.ok(calls.some((c) => c.url.includes('duckduckgo.com')), '应回退到 DuckDuckGo');
  globalThis.fetch = originalFetch;
});
