/**
 * MCP 协议端点测试:三传输的准入、协议协商(modern/legacy)、头一致性、
 * 工具清单与 confirm 门。不依赖 Docker:只走协议层与工具解析,真实工具执行
 * 用只读的 server.command 覆盖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-mcp-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { buildApp } = await import('../src/app.js');
const mcp = await import('../src/routes/mcp.js');
const { getSetting } = await import('../src/lib/db.js');
const { assessRisk } = await import('../src/services/agent-tools.js');

const app = await buildApp({ logger: false });
await app.ready();

const authHeaders = { origin: 'http://localhost:3001', host: 'localhost:3001' };

test.after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function login() {
  const status = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
  if (status.json().setupRequired) {
    await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: authHeaders, payload: { password: 'test-pass-123' } });
  }
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: authHeaders, payload: { password: 'test-pass-123' } });
  const raw = login.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw || '').split(';')[0];
}

let cookie = null;
let token = '';

test('mcp: 默认关闭时三种传输都拒绝', async () => {
  cookie = await login();
  for (const call of [
    { method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
    { method: 'GET', url: '/mcp/sse' },
    { method: 'POST', url: '/mcp/message?sessionId=x', payload: { jsonrpc: '2.0', id: 1, method: 'ping' } },
  ]) {
    const response = await app.inject(call);
    assert.equal(response.statusCode, 403, `${call.method} ${call.url} 未启用时应 403`);
    assert.equal(response.json().error, 'mcp_disabled');
  }
});

test('mcp: 启用后签发 token,token 只明文返回一次', async () => {
  const saved = await app.inject({
    method: 'POST',
    url: '/api/v1/system/mcp',
    headers: { cookie, ...authHeaders },
    payload: { enabled: true, mode: 'readonly' },
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json();
  assert.equal(body.enabled, true);
  assert.equal(body.configured, true);
  assert.equal(body.httpUrl, '/mcp');
  assert.equal(body.protocolVersion, '2026-07-28');
  assert.ok(Array.isArray(body.supportedVersions) && body.supportedVersions.includes('2026-07-28'));
  assert.ok(!body.token.includes(getSetting('mcp.token', '')), '状态接口只给掩码');

  const revealed = await app.inject({ method: 'POST', url: '/api/v1/system/mcp/reveal-token', headers: { cookie, ...authHeaders } });
  token = revealed.json().token;
  assert.ok(token.length >= 32);
});

test('mcp: 无 token / 错 token / 跨源 Origin 分别 401 与 403', async () => {
  const noToken = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(noToken.statusCode, 401);

  const badToken = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: 'Bearer not-the-token' },
    payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  assert.equal(badToken.statusCode, 401);

  const crossOrigin = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, origin: 'http://evil.example', host: 'localhost:3001' },
    payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(crossOrigin.json().error, 'origin_mismatch');

  const sameOrigin = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, origin: 'http://localhost:3001', host: 'localhost:3001' },
    payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
  });
  assert.equal(sameOrigin.statusCode, 200);
});

test('mcp: server/discover 返回支持版本与 serverInfo(modern 客户端入口)', async () => {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 'd1', method: 'server/discover' },
  });
  assert.equal(response.statusCode, 200);
  const result = response.json().result;
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, mcp.SUPPORTED_PROTOCOL_VERSIONS);
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'composeops');
  assert.ok(result.capabilities.tools);
});

test('mcp: 不支持的协议版本回 -32022 并列出 supported(400)', async () => {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      jsonrpc: '2.0', id: 2, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } },
    },
  });
  assert.equal(response.statusCode, 400);
  const error = response.json().error;
  assert.equal(error.code, -32022);
  assert.equal(error.data.requested, '1900-01-01');
  assert.ok(error.data.supported.includes('2026-07-28'));
});

test('mcp: 头与请求体不一致回 -32020 HeaderMismatch,缺失头放行', async () => {
  const mismatch = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'mcp-method': 'tools/list' },
    payload: { jsonrpc: '2.0', id: 3, method: 'ping' },
  });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json().error.code, -32020);

  const nameMismatch = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'mcp-name': 'compose_up' },
    payload: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'server.command', arguments: { command: 'uptime' } } },
  });
  assert.equal(nameMismatch.statusCode, 400);
  assert.equal(nameMismatch.json().error.code, -32020);

  // 客户端还没实现新头时不能被拒(否则 2025-06-18 客户端全挂)
  const noHeaders = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 5, method: 'ping' },
  });
  assert.equal(noHeaders.statusCode, 200);
});

test('mcp: 一致的头照常放行(Base64 sentinel 也解开比对)', async () => {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
    },
    payload: {
      jsonrpc: '2.0', id: 6, method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.json().result.tools));

  const encoded = Buffer.from('server.command', 'utf8').toString('base64');
  const encodedName = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'mcp-name': `=?base64?${encoded}?=` },
    payload: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'server.command', arguments: { command: 'uptime' } } },
  });
  assert.equal(encodedName.statusCode, 200);
});

test('mcp: 通知返回 202 无响应体', async () => {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.body, '');
});

test('mcp: legacy 客户端 initialize 握手在支持列表内回显版本', async () => {
  const supported = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 8, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  });
  assert.equal(supported.statusCode, 200);
  assert.equal(supported.json().result.protocolVersion, '2025-06-18');

  const unknown = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '1900-01-01' } },
  });
  assert.equal(unknown.statusCode, 200);

  const missing = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 10, method: 'initialize' },
  });
  assert.equal(missing.statusCode, 200);
  assert.ok(mcp.SUPPORTED_PROTOCOL_VERSIONS.includes(missing.json().result.protocolVersion));
});

test('mcp: GET/DELETE 端点回 405(无服务端-initiated 流)', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/mcp' })).statusCode, 405);
  assert.equal((await app.inject({ method: 'DELETE', url: '/mcp' })).statusCode, 405);
});

test('mcp: readonly 模式工具清单非空、含注解、不含 critical 与宏', async () => {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 11, method: 'tools/list' },
  });
  const tools = response.json().result.tools;
  assert.ok(tools.length > 0);
  const names = tools.map((tool) => tool.name);
  assert.ok(!names.includes('maintenance.clean'), 'critical 工具永不暴露');
  assert.ok(!names.includes('app.deploy'), 'critical 工具永不暴露');
  assert.ok(!names.some((name) => name.startsWith('macro.')), '宏不暴露');
  for (const tool of tools) {
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object');
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }
  // 只读工具的 readOnlyHint 与 destructiveHint 互斥
  const ping = tools.find((tool) => tool.name === 'server.command');
  assert.equal(ping.annotations.readOnlyHint, true);
});

test('mcp: all 模式下高危工具带 destructiveHint,且清单里出现需确认工具', async () => {
  await app.inject({
    method: 'POST', url: '/api/v1/system/mcp',
    headers: { cookie, ...authHeaders },
    payload: { enabled: true, mode: 'all' },
  });
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 12, method: 'tools/list' },
  });
  const tools = response.json().result.tools;
  const restart = tools.find((tool) => tool.name === 'compose.restart');
  assert.ok(restart, 'all 模式应包含 compose.restart');
  assert.equal(restart.annotations.readOnlyHint, false);
  assert.equal(restart.annotations.destructiveHint, true);
  assert.ok(!tool_names_includes(tools, 'maintenance.clean'), 'critical 在 all 模式下仍不暴露');
});

function tool_names_includes(tools, name) {
  return tools.some((tool) => tool.name === name);
}

test('mcp: 生产项目动态升为 critical 时 fail-closed,不允许 confirm 绕过', () => {
  const tool = { name: 'compose.exec', confirmationRequired: true };
  const production = { project: { tags: ['production'], projectName: 'payments-prod' } };
  assert.equal(assessRisk(tool.name, { projectId: 'prod' }, production), 'critical');
  assert.equal(mcp.isCriticalRisk(tool, { projectId: 'prod' }, production), true);
  assert.equal(mcp.needsExplicitConfirm(tool, { projectId: 'prod' }, production), true);
  assert.equal(mcp.isCriticalRisk(tool, { projectId: 'dev' }, { project: { projectName: 'dev' } }), false);
});

test('mcp: 高危工具不带 confirm 被拒(isError 且可重试)', async () => {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'compose.restart', arguments: { projectId: 'x' } } },
  });
  assert.equal(response.statusCode, 200);
  const result = response.json().result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /confirm=true/);
});

test('mcp: confirm 不进入工具参数(不会污染 schema 校验)', async () => {
  const agent = (await import('../src/services/agent.js')).getAgent();
  const seen = [];
  const original = agent.executeTool.bind(agent);
  agent.executeTool = async (name, params) => {
    seen.push({ name, params });
    return { success: true, result: { ok: true }, durationMs: 1 };
  };
  try {
    const response = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'compose.restart', arguments: { projectId: 'x', confirm: true } } },
    });
    assert.equal(response.json().result.isError, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, 'compose.restart');
    assert.ok(!('confirm' in seen[0].params), 'confirm 应在执行前剥离');
  } finally {
    agent.executeTool = original;
  }
});

test('mcp: 只读工具真实执行并回 structuredContent + 脱敏', async () => {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'server.command', arguments: { command: 'uptime' } } },
  });
  assert.equal(response.statusCode, 200);
  const result = response.json().result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.success, true);
  assert.match(result.content[0].text, /success/);
});

test('mcp: 下划线别名解析到规范名(早期客户端兼容)', async () => {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'server_command', arguments: { command: 'uptime' } } },
  });
  const result = response.json().result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.tool, 'server.command');
});

test('mcp: 未暴露/不存在的工具回 -32602', async () => {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'maintenance.clean', arguments: {} } },
  });
  assert.equal(response.json().error.code, -32602);
});

test('mcp: 未知方法与非法请求体分别回 -32601 与 400', async () => {
  const unknown = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 18, method: 'resources/list' },
  });
  assert.equal(unknown.json().error.code, -32601);

  const badBody = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: '[1,2,3]',
  });
  assert.equal(badBody.statusCode, 400);
});

test('mcp: 结果截断保留首尾并标注', () => {
  const long = 'A'.repeat(20000) + 'B'.repeat(20000);
  const text = mcp.truncateMcpText(long, 24000);
  assert.ok(text.length < long.length);
  assert.match(text, /已截断/);
  assert.ok(text.startsWith('A'));
  assert.ok(text.endsWith('B'));

  // 嵌套字段里的敏感键名被抹掉
  const wrapped = mcp.wrapToolResult({ tool: 'x', success: true, result: { DB_PASSWORD: 'hunter2', nested: { apiToken: 'abc' } } }, false);
  assert.ok(!wrapped.content[0].text.includes('hunter2'));
  assert.equal(wrapped.content[0].text.includes('[REDACTED]'), true);
});

test('mcp: SSE 传输会话化请求-响应仍可用(经典客户端)', async () => {
  // SSE 是长连接,inject 会等流结束;改用真实监听 + fetch,拿到首帧后主动断开。
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const controller = new AbortController();
  const sse = await fetch(`http://127.0.0.1:${port}/mcp/sse?token=${token}`, { signal: controller.signal });
  assert.equal(sse.status, 200);
  assert.equal(sse.headers.get('content-type'), 'text/event-stream');

  const reader = sse.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: endpoint/);
  const sessionId = first.match(/sessionId=([a-f0-9]+)/)[1];

  const posted = await fetch(`http://127.0.0.1:${port}/mcp/message?sessionId=${sessionId}&token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 19, method: 'ping' }),
  });
  assert.equal(posted.status, 202);

  // 202 之后响应帧经 SSE 流回写(而非 in-band 响应体)
  const second = new TextDecoder().decode((await reader.read()).value);
  assert.match(second, /"id":19/);

  const missing = await fetch(`http://127.0.0.1:${port}/mcp/message?sessionId=deadbeef&token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'ping' }),
  });
  assert.equal(missing.status, 404);
  controller.abort();
});
