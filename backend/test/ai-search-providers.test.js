import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-search-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { setSetting } = await import('../src/lib/db.js');
const { searchWeb, openWebPage, getSearchConfig, setSearchConfig, SEARCH_PROVIDERS } = await import('../src/services/ai.js');

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

test('search: 内置搜索网络不可达时返回可诊断错误,普通文档查询不误搜 GitHub 仓库', async () => {
  setSetting('ai.search.provider', 'builtin');
  const calls = stubFetch(async () => { throw new Error('connect ETIMEDOUT'); });
  const results = await searchWeb('Docker Compose official documentation');
  assert.deepEqual(results, []);
  assert.ok(calls.every((call) => !call.url.includes('api.github.com')), '普通文档问题不应被当作 GitHub 仓库发现');
  assert.ok(results.diagnostics.some((item) => item.includes('DuckDuckGo API') && item.includes('ETIMEDOUT')));
  assert.ok(results.diagnostics.some((item) => item.includes('DuckDuckGo HTML') && item.includes('ETIMEDOUT')));
  globalThis.fetch = originalFetch;
});

test('search: Bing 通用网页搜索解析标题、摘要并还原官方文档链接', async () => {
  setSetting('ai.search.provider', 'builtin');
  const target = 'https://docs.docker.com/compose/';
  const redirect = `https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64')}`;
  const calls = stubFetch(async (url) => {
    if (url.includes('bing.com/search')) return { ok: true, text: async () => `<ol><li class="b_algo"><h2><a href="${redirect}">Docker Compose docs</a></h2><p>Official Compose reference</p></li></ol>` };
    return { ok: true, json: async () => ({}) };
  });
  const results = await searchWeb('Docker Compose official documentation');
  assert.equal(results[0].title, 'Docker Compose docs');
  assert.equal(results[0].url, target);
  assert.equal(results[0].snippet, 'Official Compose reference');
  assert.ok(calls.some((call) => call.url.includes('bing.com/search')));
  globalThis.fetch = originalFetch;
});

test('search: 优先解析 Bing RSS，并为中文查询传递地区语言参数', async () => {
  setSetting('ai.search.provider', 'builtin');
  const calls = stubFetch(async (url) => {
    if (url.includes('format=rss')) return {
      ok: true,
      text: async () => '<?xml version="1.0"?><rss><channel><item><title>Docker Compose Watch | Docker Docs</title><link>https://docs.docker.com/compose/how-tos/file-watch/</link><description><![CDATA[Official Compose Watch documentation &amp; guide]]></description></item></channel></rss>',
    };
    return { ok: true, json: async () => ({}) };
  });
  const results = await searchWeb('Docker Compose Watch official documentation');
  assert.equal(results[0].title, 'Docker Compose Watch | Docker Docs');
  assert.equal(results[0].url, 'https://docs.docker.com/compose/how-tos/file-watch/');
  assert.match(results[0].snippet, /Official Compose Watch documentation/);
  assert.ok(calls.some((call) => call.url.includes('format=rss')));
  globalThis.fetch = originalFetch;

  const localeCalls = stubFetch(async () => {
    return { ok: true, text: async () => '<rss><channel><item><title>腾讯新闻</title><link>https://news.qq.com/</link><description>腾讯新闻最新资讯</description></item></channel></rss>' };
  });
  const localized = await searchWeb('腾讯新闻 最新资讯');
  assert.ok(localeCalls[0].url.includes('cc=CN'));
  assert.ok(localeCalls[0].url.includes('setlang=zh-CN'));
  assert.equal(localized.length, 0, '新闻检索不能把门户首页当成具体新闻结果');
  assert.ok(localized.diagnostics.some((item) => item.includes('门户首页')));
  globalThis.fetch = originalFetch;
});

test('search: Bing 缓存噪声时回退 DuckDuckGo Lite 真实结果卡片', async () => {
  setSetting('ai.search.provider', 'builtin');
  const target = 'https://docs.docker.com/compose/how-tos/file-watch/';
  const calls = stubFetch(async (url) => {
    if (url.includes('format=rss')) return { ok: true, text: async () => '<rss><channel><item><title>Google</title><link>https://www.google.com/</link><description>Search portal</description></item></channel></rss>' };
    if (url.includes('bing.com/search')) return { ok: true, text: async () => '<ol><li class="b_algo"><h2><a href="https://example.com/ship">Ship tracking</a></h2><p>Container ship tracking</p></li></ol>' };
    if (url.includes('lite.duckduckgo.com/lite/')) return { ok: true, text: async () => `<table><tr><td><a rel="nofollow" href="${target}" class='result-link'>Use Compose Watch | Docker Docs</a><br><span class='result-snippet'>The watch attribute automatically updates running Compose services.</span></td></tr></table>` };
    return { ok: true, json: async () => ({}) };
  });
  const results = await searchWeb('Docker Compose Watch official documentation');
  assert.ok(calls.some((call) => call.url.includes('lite.duckduckgo.com/lite/')));
  assert.equal(results[0].url, target);
  assert.equal(results[0].provider, 'duckduckgo_lite');
  globalThis.fetch = originalFetch;
});

test('search: 中文腾讯新闻只接受具体新闻文章，不把门户或视频页当新闻', async () => {
  setSetting('ai.search.provider', 'builtin');
  const article = 'https://news.qq.com/rain/a/20261118A01234';
  const calls = stubFetch(async (url) => {
    if (url.includes('format=rss')) return { ok: true, text: async () => `<rss><channel>
      <item><title>Tencent 腾讯</title><link>https://www.tencent.com/zh-cn/</link><description>腾讯公司介绍</description></item>
      <item><title>腾讯新闻：今日重要消息</title><link>${article}</link><description>腾讯新闻报道最新事件</description></item>
      <item><title>腾讯视频热门内容</title><link>https://v.qq.com/index.html</link><description>腾讯视频内容</description></item>
    </channel></rss>` };
    return { ok: true, text: async () => '' };
  });
  const results = await searchWeb('腾讯新闻 最新资讯');
  assert.ok(calls.some((call) => /2026年11月/.test(decodeURIComponent(call.url))));
  assert.equal(results.length, 1);
  assert.equal(results[0].url, article);
  globalThis.fetch = originalFetch;
});

test('search: 过滤完全不相关的搜索结果并提供诊断', async () => {
  setSetting('ai.search.provider', 'builtin');
  const calls = stubFetch(async (url) => {
    if (url.includes('bing.com/search')) return { ok: true, text: async () => '<ol><li class="b_algo"><h2><a href="https://social.msdn.microsoft.com/">MSDN Forums</a></h2><p>Microsoft community discussions</p></li><li class="b_algo"><h2><a href="https://www.docker.com/">Docker</a></h2><p>Docker platform overview</p></li></ol>' };
    return { ok: true, json: async () => ({}) };
  });
  const results = await searchWeb('latest linux.do posts');
  assert.equal(results.length, 0);
  assert.ok(results.diagnostics.some((item) => item.includes('无明显匹配')));
  assert.ok(calls.some((call) => call.url.includes('bing.com/search')));
  globalThis.fetch = originalFetch;
});

test('web.open: 提取网页标题、正文和可继续访问的公开链接', async () => {
  const html = '<html><head><title>Compose Guide</title><meta name="description" content="Official guide"></head><body><nav>menu</nav><main><h1>Getting started</h1><p>Run docker compose up to start services.</p><script>ignore this injected text</script><a href="/reference">API reference</a><a href="http://127.0.0.1/admin">unsafe link</a></main></body></html>';
  const calls = stubFetch(async () => ({ ok: true, status: 200, url: 'https://docs.example.com/guide', headers: { get: (name) => name === 'content-type' ? 'text/html; charset=utf-8' : null }, text: async () => html }));
  const page = await openWebPage('https://docs.example.com/guide');
  assert.equal(page.title, 'Compose Guide');
  assert.equal(page.description, 'Official guide');
  assert.match(page.text, /Getting started/);
  assert.match(page.text, /docker compose up/);
  assert.doesNotMatch(page.text, /ignore this injected text|menu/);
  assert.deepEqual(page.links, [{ title: 'API reference', url: 'https://docs.example.com/reference' }]);
  assert.equal(calls.length, 1);
  globalThis.fetch = originalFetch;
});

test('web.open: 支持 Markdown 正文与相对链接', async () => {
  const markdown = '# Docker Compose\n\nOfficial guide for Compose.\n\n[CLI reference](./cli/)';
  stubFetch(async () => ({ ok: true, status: 200, url: 'https://docs.docker.com/compose/', headers: { get: (name) => name === 'content-type' ? 'text/markdown; charset=utf-8' : null }, text: async () => markdown }));
  const page = await openWebPage('https://docs.docker.com/compose/');
  assert.equal(page.title, 'Docker Compose');
  assert.match(page.text, /Official guide for Compose/);
  assert.deepEqual(page.links, [{ title: 'CLI reference', url: 'https://docs.docker.com/compose/cli/' }]);
  globalThis.fetch = originalFetch;
});

test('web.open: 拒绝内网地址和重定向到内网的跳转', async () => {
  let calls = stubFetch(async () => ({ status: 302, ok: false, headers: { get: () => 'http://127.0.0.1/admin' } }));
  await assert.rejects(() => openWebPage('https://public.example.com/redirect'), /内网地址/);
  assert.equal(calls.length, 1);
  await assert.rejects(() => openWebPage('http://192.168.1.10/'), /内网地址/);
  assert.equal(calls.length, 1, '内网目标必须在发起请求前被拒绝');
  globalThis.fetch = originalFetch;
});

test('web.open: 拒绝 IPv6、本地保留地址与尾点本地域名', async () => {
  const calls = stubFetch(async () => { throw new Error('不应发出请求'); });
  for (const url of ['http://[::1]/', 'http://100.64.0.1/', 'http://198.18.0.1/', 'http://localhost./']) {
    await assert.rejects(() => openWebPage(url), /内网地址/);
  }
  assert.equal(calls.length, 0);
  globalThis.fetch = originalFetch;
});
