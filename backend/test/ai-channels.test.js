import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-channels-'));
process.env.DB_PATH = path.join(directory, 'test.db');
const { default: db, setSetting, getSetting, exportUserData, importUserData } = await import('../src/lib/db.js');
const { callOpenAI, getAiConfig, getPublicAiConfig, setAiConfig, fetchAiModels } = await import('../src/services/ai.js');
const { publicAiChannels, requestWithAiChannels } = await import('../src/services/ai-channels.js');
const { buildApp } = await import('../src/app.js');
const app = await buildApp({ logger: false });
const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { password: 'channels-test-password' } });
const cookie = String(setup.headers['set-cookie']).split(';')[0];
let sequence = 0;
const channel = (name, extra = {}) => ({ id: `ch-${++sequence}`, name, baseUrl: `http://${name}.test/v1`, apiKey: `private-${name}-credential`, model: `${name}-model`, enabled: true, supportsTools: true, firstTokenTimeoutMs: 30000, ...extra });
const jsonReply = (content = '成功') => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const frame = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
const streamReply = (text = '备用回复') => new Response(frame({ content: text }, 'stop') + 'data: [DONE]\n\n');
test.beforeEach(() => { db.prepare("DELETE FROM settings WHERE key LIKE 'ai.%'").run(); });
test.after(async () => { await app.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('旧配置自动显示为默认渠道，保存列表后密钥保留且不回传明文', () => {
  setSetting('ai.base_url', 'http://legacy.test/v1'); setSetting('ai.api_key', 'legacy-secret'); setSetting('ai.model', 'legacy-model');
  const config = getPublicAiConfig();
  assert.equal(config.channels[0].id, 'legacy');
  assert.equal(getSetting('ai.channels'), null);
  assert.ok(!JSON.stringify(config).includes('legacy-secret'));
  setAiConfig({ channels: [{ ...config.channels[0], apiKey: '' }], failoverEnabled: false });
  assert.equal(getAiConfig().channels[0].apiKey, 'legacy-secret');
  assert.equal(getAiConfig().failoverEnabled, false);
  assert.equal(JSON.parse(getSetting('ai.channels')).length, 1);
});

test('列表保存原子校验、排序停用和删除生效，地址变更不能带走旧密钥', () => {
  const a = channel('a'), b = channel('b');
  setAiConfig({ channels: [a, b] });
  assert.throws(() => setAiConfig({ channels: [a, { ...b, name: '' }], systemPrompt: '不得写入' }));
  assert.equal(getAiConfig().channels[1].name, 'b');
  assert.notEqual(getAiConfig().systemPrompt, '不得写入');
  assert.throws(() => setAiConfig({ channels: [{ ...a, baseUrl: b.baseUrl, apiKey: '' }] }), /重新填写/);
  assert.throws(() => setAiConfig({ channels: [a, a] }), /重复/);
  assert.throws(() => setAiConfig({ channels: [{ ...a, baseUrl: 'http://169.254.169.254' }] }), /元数据/);
  setAiConfig({ channels: [{ ...b, apiKey: '' }, { ...a, apiKey: '', enabled: false }] });
  assert.equal(getAiConfig().model, b.model);
  assert.equal(getAiConfig().channels[0].apiKey, b.apiKey);
  setAiConfig({ channels: [] });
  assert.equal(getAiConfig().apiKey, '');
});

test('导出和导入不携带、覆盖渠道密钥', () => {
  const a = channel('a'); setAiConfig({ channels: [a] }); setSetting('ai.search.api_key', 'search-secret');
  const exported = exportUserData();
  assert.equal(exported.settings['ai.channels'], undefined);
  assert.ok(!JSON.stringify(exported).includes(a.apiKey));
  assert.ok(!JSON.stringify(exported).includes('search-secret'));
  importUserData({ settings: { 'ai.channels': '[]' } });
  assert.equal(getAiConfig().channels[0].apiKey, a.apiKey);
});

test('配置 API 脱敏且支持列表，未登录不能读取或测试渠道', async () => {
  const a = channel('api');
  const save = await app.inject({ method: 'POST', url: '/api/v1/ai/config', headers: { cookie }, payload: { channels: [a], failoverEnabled: true } });
  assert.equal(save.statusCode, 200, save.body);
  const get = await app.inject({ url: '/api/v1/ai/config', headers: { cookie } });
  assert.equal(get.json().channels[0].name, 'api'); assert.ok(!get.body.includes(a.apiKey));
  for (const [method, url] of [['GET', '/api/v1/ai/config'], ['POST', `/api/v1/ai/channels/${a.id}/test`]]) {
    assert.equal((await app.inject({ method, url })).statusCode, 401);
  }
});

test('模型列表按渠道选取密钥，地址变更无新密钥时不发请求', async t => {
  const a = channel('a'), b = channel('b'); setAiConfig({ channels: [a, b] });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, key: options.headers.Authorization }); return Response.json({ data: [{ id: 'm' }] }); });
  assert.deepEqual(await fetchAiModels({ channelId: b.id }), ['m']);
  assert.equal(requests[0].key, `Bearer ${b.apiKey}`);
  await assert.rejects(fetchAiModels({ channelId: b.id, baseUrl: a.baseUrl }), /地址已变更/);
  assert.equal(requests.length, 1);
});

test('503/429/401/网络失败能切换，备用使用自己的模型与密钥', async t => {
  for (const status of [503, 429, 401, 0]) {
    const a = channel('a'), b = channel('b'); const requests = [], events = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), key: options.headers.Authorization });
      if (url.includes('a.test')) { if (!status) throw new TypeError('fetch failed'); return new Response('upstream failure', { status }); }
      return jsonReply();
    });
    const result = await callOpenAI({ channels: [a, b], messages: [{ role: 'user', content: 'hi' }], onChannelEvent: e => events.push(e) });
    assert.equal(result.model, b.model); assert.equal(result.channelId, b.id);
    assert.equal(requests[1].key, `Bearer ${b.apiKey}`); assert.equal(requests[1].body.model, b.model);
    assert.ok(events.some(e => e.type === 'channel_failed'));
    assert.ok(!JSON.stringify(events).includes(a.apiKey));
    mock.mock.restore();
  }
});

test('关闭自动切换、请求格式错误和用户取消均不调用备用', async t => {
  for (const scenario of ['off', 'bad-request', 'cancel']) {
    const channels = [channel('a'), channel('b')]; let requests = 0; const controller = new AbortController();
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      if (scenario === 'cancel') { controller.abort(); throw controller.signal.reason; }
      return new Response('', { status: scenario === 'bad-request' ? 400 : 503 });
    });
    await assert.rejects(callOpenAI({ channels, messages: [], signal: controller.signal, failoverEnabled: scenario !== 'off' }));
    assert.equal(requests, 1);
    mock.mock.restore();
  }
});

test('首段超时可切换；总时间预算跨渠道共享', async () => {
  const channels = [channel('a', { firstTokenTimeoutMs: 10 }), channel('b')];
  const hang = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const seen = [];
    const result = await requestWithAiChannels({ channels, totalTimeoutMs: 100 }, async options => {
      seen.push(options.id); if (options.id === channels[0].id) return hang(options); return { content: 'ok' };
    });
    assert.equal(result.channelId, channels[1].id); assert.equal(seen.length, 2);
    const started = Date.now();
    await assert.rejects(requestWithAiChannels({ channels: [channel('slow')], totalTimeoutMs: 15 }, hang));
    assert.ok(Date.now() - started < 300);
  } finally { clearTimeout(keepAlive); }
});

test('连续失败进入冷却，跳过坏渠道，成功探测后恢复', async t => {
  const a = channel('a'), b = channel('b'); let failing = true; let callsA = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('a.test')) { callsA++; if (failing) return new Response('', { status: 503 }); }
    return jsonReply();
  });
  const opts = { channels: [a, b], messages: [] };
  await callOpenAI(opts); await callOpenAI(opts); await callOpenAI(opts);
  assert.equal(callsA, 2); assert.equal(publicAiChannels([a])[0].health.status, 'cooldown');
  failing = false;
  await callOpenAI({ channels: [a], messages: [], probe: true });
  assert.equal(publicAiChannels([a])[0].health.status, 'healthy');
  assert.equal((await callOpenAI(opts)).channelId, a.id);
});

test('冷却到期自动半开，探测中并发请求使用备用', async t => {
  const a = channel('a'), b = channel('b');
  const fail = async () => { throw Object.assign(new Error('failed'), { status: 503 }); };
  for (let i = 0; i < 2; i++) await assert.rejects(requestWithAiChannels({ channels: [a] }, fail));
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 61000);
  let resolveProbe;
  const probe = requestWithAiChannels({ channels: [a, b] }, () => new Promise(resolve => { resolveProbe = resolve; }));
  const parallel = await requestWithAiChannels({ channels: [a, b] }, async () => ({ content: 'ok' }));
  assert.equal(parallel.channelId, b.id);
  resolveProbe({ content: 'ok' });
  assert.equal((await probe).channelId, a.id);
  assert.equal(publicAiChannels([a])[0].health.status, 'healthy');
});

test('工具请求跳过纯聊天渠道，禁用渠道不参与任何请求', async t => {
  const channels = [channel('disabled', { enabled: false }), channel('chat', { supportsTools: false }), channel('tools')];
  const urls = []; t.mock.method(globalThis, 'fetch', async url => { urls.push(url); return jsonReply(); });
  await callOpenAI({ channels, messages: [], tools: [{ type: 'function', function: { name: 'probe' } }] });
  assert.deepEqual(urls, ['http://tools.test/v1/chat/completions']);
});

test('流式 EOF/非法工具参数在无外发内容时可切换，工具调用不泄漏', async t => {
  for (const bad of [frame({ tool_calls: [{ index: 0, id: 'partial', function: { name: 'danger', arguments: '{' } }] }),
    frame({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'danger', arguments: '{' } }] }, 'tool_calls') + 'data: [DONE]\n\n']) {
    const channels = [channel('a'), channel('b')]; const tokens = [];
    const mock = t.mock.method(globalThis, 'fetch', async url => url.includes('a.test') ? new Response(bad) : streamReply());
    const result = await callOpenAI({ channels, messages: [], stream: true, onToken: token => tokens.push(token) });
    assert.equal(result.channelId, channels[1].id); assert.equal(result.toolCalls.length, 0); assert.equal(tokens.join(''), '备用回复');
    mock.mock.restore();
  }
});

test('输出文字或推理后流中断不自动切换，不拼接不同渠道内容', async t => {
  for (const delta of [{ content: '已经输出' }, { reasoning_content: '正在推理' }]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(frame(delta)); });
    await assert.rejects(callOpenAI({ channels: [channel('a'), channel('b')], messages: [], stream: true, onToken: () => {}, onReasoning: () => {} }), /未自动切换/);
    assert.equal(calls, 1); mock.mock.restore();
  }
});

test('200 中的错误帧、无效 JSON 可以切换；DONE 无换行可正常完成', async t => {
  const replies = ['data: {"error":{"message":"private"}}\n\n', 'not json'];
  for (const bad of replies) {
    const channels = [channel('a'), channel('b')];
    const mock = t.mock.method(globalThis, 'fetch', async url => url.includes('a.test') ? new Response(bad) : streamReply());
    assert.equal((await callOpenAI({ channels, messages: [], stream: true })).channelId, channels[1].id);
    mock.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(frame({ content: '中文🙂' }) + 'data: [DONE]'));
  assert.equal((await callOpenAI({ channels: [channel('end')], messages: [], stream: true })).content, '中文🙂');
});

test('测试连接只访问指定渠道、验证工具协议，不借备用掩盖失败', async t => {
  const a = channel('a'), b = channel('b'); setAiConfig({ channels: [a, b] });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    requests++; assert.ok(url.includes('a.test'));
    return streamReply('不能调用工具');
  });
  const response = await app.inject({ method: 'POST', url: `/api/v1/ai/channels/${a.id}/test`, headers: { cookie } });
  assert.equal(response.statusCode, 200); assert.equal(requests, 1); assert.equal(response.json().ok, false); assert.match(response.json().checks[0].message, /工具调用/);
  assert.equal(publicAiChannels([a])[0].health.lastSuccessAt, null);
});

test('真实 HTTP 双上游：主渠道 503，备用流式中文与模型选择正确', async () => {
  const requests = [];
  const a = http.createServer((_req, res) => { res.writeHead(503); res.end('unavailable'); });
  const b = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const data = Buffer.from(frame({ content: '故障切换成功🙂' }, 'stop') + 'data: [DONE]\n\n');
    for (let i = 0; i < data.length; i += 3) res.write(data.subarray(i, i + 3));
    res.end();
  });
  await Promise.all([a, b].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  try {
    const channels = [channel('http-a', { baseUrl: `http://127.0.0.1:${a.address().port}/v1` }), channel('http-b', { baseUrl: `http://127.0.0.1:${b.address().port}/v1` })];
    const tokens = [];
    const result = await callOpenAI({ channels, messages: [{ role: 'user', content: '测试' }], stream: true, onToken: text => tokens.push(text) });
    assert.equal(result.content, '故障切换成功🙂'); assert.equal(tokens.join(''), result.content); assert.equal(requests[0].model, channels[1].model);
  } finally { await Promise.all([a, b].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }))); }
});


test('独立保存只修改目标渠道；过期版本及删除后保存不能覆盖配置', async () => {
  const a = channel('one'), b = channel('two'); setAiConfig({ channels: [a, b] });
  const [draftA, draftB] = getPublicAiConfig().channels;
  const put = (id, payload) => app.inject({ method: 'PUT', url: `/api/v1/ai/channels/${id}`, headers: { cookie }, payload });
  const first = await put(a.id, { ...draftA, name: '已更新', apiKey: '' });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().order, [a.id, b.id]);
  assert.ok(!first.body.includes(a.apiKey));
  assert.equal(getAiConfig().channels[1].apiKey, b.apiKey);
  assert.equal((await put(a.id, { ...draftA, name: '旧窗口' })).statusCode, 409);
  assert.equal((await put(b.id, { ...draftB, name: '独立更新', apiKey: '' })).statusCode, 200);
  const current = getPublicAiConfig().channels[0];
  const staleDelete = await app.inject({ method: 'DELETE', url: `/api/v1/ai/channels/${a.id}`, headers: { cookie }, payload: { revision: draftA.revision } });
  assert.equal(staleDelete.statusCode, 409);
  const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/ai/channels/${a.id}`, headers: { cookie }, payload: { revision: current.revision } });
  assert.equal(deleted.statusCode, 200);
  assert.equal((await put(a.id, current)).statusCode, 409);
  assert.equal(getAiConfig().channels.length, 1);
});

test('独立新增不受另一条无效草稿影响；顺序保存校验列表且保留密钥', async () => {
  const a = channel('order-a'), b = channel('order-b'); setAiConfig({ channels: [a] });
  const added = await app.inject({ method: 'PUT', url: `/api/v1/ai/channels/${b.id}`, headers: { cookie }, payload: { ...b, revision: null } });
  assert.equal(added.statusCode, 200, added.body);
  const order = (ids, previousIds) => app.inject({ method: 'POST', url: '/api/v1/ai/channels/order', headers: { cookie }, payload: { ids, previousIds } });
  assert.equal((await order([b.id, a.id], [a.id, b.id])).statusCode, 200);
  assert.equal(getAiConfig().channels[0].apiKey, b.apiKey);
  assert.equal((await order([a.id, b.id], [a.id, b.id])).statusCode, 409);
  assert.equal((await order([b.id, b.id], [b.id, a.id])).statusCode, 400);
  assert.equal((await order([b.id], [b.id, a.id])).statusCode, 400);
});

test('只有已登录管理员可显式查看密钥，跨站请求被拒绝，响应不缓存', async () => {
  const a = channel('reveal'); setAiConfig({ channels: [a] });
  const url = `/api/v1/ai/channels/${a.id}/reveal-key`;
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers: { cookie, origin: 'https://evil.test' } })).statusCode, 403);
  const revealed = await app.inject({ method: 'POST', url, headers: { cookie } });
  assert.equal(revealed.statusCode, 200); assert.equal(revealed.json().apiKey, a.apiKey);
  assert.equal(revealed.headers['cache-control'], 'no-store');
  assert.ok(!JSON.stringify(getPublicAiConfig()).includes(a.apiKey));
  assert.ok(!JSON.stringify(exportUserData()).includes(a.apiKey));
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await app.inject({ method, url: `/api/v1/ai/channels/${a.id}`, payload: {} })).statusCode, 401);
  }
});

test('工具兼容模式完整返回后发射正文；普通聊天保持流式，参数仍严格校验', async t => {
  const a = channel('compatible', { streamToolCalls: false });
  const requests = [], tokens = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return body.stream ? streamReply('流式聊天') : jsonReply('完整正文');
  });
  const tools = [{ type: 'function', function: { name: 'probe' } }];
  await callOpenAI({ channels: [a], messages: [], tools, stream: true, onToken: value => tokens.push(value) });
  assert.equal(requests[0].stream, false); assert.equal(requests[0].stream_options, undefined);
  assert.deepEqual(tokens, ['完整正文']);
  await callOpenAI({ channels: [a], messages: [], stream: true });
  assert.equal(requests[1].stream, true);
});

test('无外发回调的流式请求不会误报回复已开始，可以安全切换', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => ++count === 1 ? new Response(frame({ content: '内部缓冲' })) : streamReply('备用'));
  const response = await callOpenAI({ channels: [channel('buffered-a'), channel('buffered-b')], messages: [], stream: true });
  assert.equal(response.content, '备用'); assert.equal(count, 2);
});

const nativeTool = (args) => ({ id: 'synthetic-call', type: 'function', function: { name: 'connection_probe', arguments: args } });
function probeResponse(body, { brokenEmpty = false, wrongReceipt = false } = {}) {
  const toolResult = body.messages.find(item => item.role === 'tool');
  let content = '', calls = [];
  if (toolResult) content = wrongReceipt ? '未读取结果' : JSON.parse(toolResult.content).receipt;
  else {
    const nonce = body.tools[0].function.parameters.properties.nonce?.enum[0];
    calls = [nativeTool(nonce ? JSON.stringify({ nonce }) : brokenEmpty ? '{' : '{}')];
  }
  if (!body.stream) return Response.json({ choices: [{ message: { content, tool_calls: calls }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
  return new Response(frame({ content: '\n\n' }) + frame({ content, tool_calls: calls.map(item => ({ ...item, index: 0 })) }, calls.length ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
}

test('探针覆盖带参数、空参数与随机结果回传，流式和兼容模式均验证', async t => {
  for (const streamToolCalls of [true, false]) {
    const a = channel('probe-ok', { streamToolCalls }); setAiConfig({ channels: [a] });
    let count = 0;
    const mocked = t.mock.method(globalThis, 'fetch', async (_url, options) => { count++; return probeResponse(JSON.parse(options.body)); });
    const response = await app.inject({ method: 'POST', url: `/api/v1/ai/channels/${a.id}/test`, headers: { cookie } });
    assert.equal(response.json().ok, true, response.body); assert.equal(count, 3);
    assert.deepEqual(response.json().checks.map(item => item.status), ['passed', 'passed', 'passed']);
    assert.equal(publicAiChannels([a])[0].health.status, 'healthy');
    mocked.mock.restore();
  }
});

test('上游空参数流式截断明确定位兼容问题，不修补 JSON、不触发故障熔断', async t => {
  const a = channel('probe-broken'); setAiConfig({ channels: [a] });
  t.mock.method(globalThis, 'fetch', async (_url, options) => probeResponse(JSON.parse(options.body), { brokenEmpty: true }));
  const response = await app.inject({ method: 'POST', url: `/api/v1/ai/channels/${a.id}/test`, headers: { cookie } });
  const result = response.json();
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.map(item => item.status), ['passed', 'failed', 'skipped']);
  assert.match(result.checks[1].message, /完整 JSON/); assert.match(result.suggestion, /兼容模式/);
  assert.doesNotMatch(result.checks[1].message, /回复已开始/);
  const health = publicAiChannels([a])[0].health;
  assert.equal(health.failures, 0); assert.equal(health.cooldownUntil, 0); assert.equal(health.lastSuccessAt, null);
});

test('探针不把只返回工具名称或忽略工具结果算作通过', async t => {
  const a = channel('probe-receipt'); setAiConfig({ channels: [a] });
  t.mock.method(globalThis, 'fetch', async (_url, options) => probeResponse(JSON.parse(options.body), { wrongReceipt: true }));
  const result = (await app.inject({ method: 'POST', url: `/api/v1/ai/channels/${a.id}/test`, headers: { cookie } })).json();
  assert.equal(result.ok, false); assert.equal(result.checks[2].status, 'failed');
});

test('关闭故障切换时仍先按能力筛选，不让纯聊天渠道挡住工具渠道', async t => {
  const chat = channel('chat-only', { supportsTools: false }), agent = channel('agent-tools');
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); return jsonReply(); });
  const result = await callOpenAI({ channels: [chat, agent], failoverEnabled: false, messages: [], tools: [{ type: 'function', function: { name: 'probe' } }] });
  assert.equal(result.channelId, agent.id); assert.equal(urls.length, 1);
});

test('兼容模式也拒绝残缺工具参数，验证前不外发正文', async t => {
  const tokens = [];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: '未验证的正文', tool_calls: [nativeTool('{')] }, finish_reason: 'tool_calls' }] }));
  await assert.rejects(callOpenAI({ channels: [channel('strict-buffer', { streamToolCalls: false })], stream: true, probe: true, messages: [], tools: [{ type: 'function', function: { name: 'probe' } }], onToken: token => tokens.push(token) }), /完整 JSON/);
  assert.equal(tokens.length, 0);
});
