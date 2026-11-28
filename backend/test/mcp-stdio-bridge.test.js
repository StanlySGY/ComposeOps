import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgeFile = fileURLToPath(new URL('../../mcp/stdio-bridge.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error('等待桥接结果超时'); await sleep(10); }
};
async function fixture(t, respond, env = {}) {
  const requests = [], server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text); requests.push({ headers: request.headers, message });
    respond(message, response, request);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const child = spawn(process.execPath, [bridgeFile], { env: { ...process.env, COMPOSEOPS_URL: `http://127.0.0.1:${server.address().port}`, COMPOSEOPS_TOKEN: 'synthetic-bridge-token', COMPOSEOPS_MCP_TIMEOUT_MS: '200', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = []; let buffer = '', stderr = '';
  child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  return { child, messages, requests, send, stderr: () => stderr };
}
function reply(message, response, result = {}) {
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}

test('stdio bridge: 保存既有版本元数据，正常消息仅输出 JSON-RPC', async t => {
  const f = await fixture(t, (message, response) => reply(message, response, { echoed: message.params }));
  f.send({ id: 'one', method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } } });
  await until(() => f.messages.length);
  assert.equal(f.messages[0].id, 'one');
  assert.equal(f.requests[0].headers['mcp-protocol-version'], '2025-06-18');
  assert.equal(f.requests[0].headers['mcp-method'], 'tools/list');
  assert.equal(f.stderr(), '');
});

test('stdio bridge: 单次超时释放串行队列，不重放请求且后续请求可完成', async t => {
  const f = await fixture(t, (message, response) => { if (message.id !== 'hang') reply(message, response); });
  f.send({ id: 'hang', method: 'tools/call', params: { name: 'container.restart' } });
  await until(() => f.requests.length === 1);
  await sleep(250);
  f.send({ id: 'next', method: 'tools/list' });
  await until(() => f.messages.some(m => m.id === 'next'));
  assert.match(f.messages.find(m => m.id === 'hang').error.message, /超时/);
  assert.deepEqual(f.requests.map(r => r.message.id), ['hang', 'next']);
});

test('stdio bridge: 读取响应正文也受总期限约束', async t => {
  const f = await fixture(t, (_message, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"jsonrpc":'); });
  f.send({ id: 1, method: 'tools/list' });
  await until(() => f.messages.length);
  assert.match(f.messages[0].error.message, /超时/);
});

test('stdio bridge: 取消可越过挂起请求，既不返回迟到结果也不重放写入', async t => {
  const f = await fixture(t, (message, response) => { if (message.id !== 'cancel-me') reply(message, response); }, { COMPOSEOPS_MCP_TIMEOUT_MS: '2000' });
  f.send({ id: 'cancel-me', method: 'tools/call', params: { name: 'container.restart' } });
  await until(() => f.requests.length === 1);
  f.send({ method: 'notifications/cancelled', params: { requestId: 'cancel-me' } });
  f.send({ id: 'survives', method: 'tools/list' });
  await until(() => f.messages.some(m => m.id === 'survives'), 1000);
  assert.equal(f.messages.some(m => m.id === 'cancel-me'), false);
  assert.equal(f.requests.filter(r => r.message.id === 'cancel-me').length, 1);
});

test('stdio bridge: 响应超过上限时拒绝，保留请求身份', async t => {
  const f = await fixture(t, (message, response) => reply(message, response, { text: 'x'.repeat(3 * 1024 * 1024) }), { COMPOSEOPS_MCP_TIMEOUT_MS: '3000' });
  f.send({ id: 5, method: 'tools/list' });
  await until(() => f.messages.length);
  assert.equal(f.messages[0].id, 5); assert.match(f.messages[0].error?.message || '', /上限|过大/);
});

test('stdio bridge: 错误页面不能把 token 或原始 HTML 回显到输出', async t => {
  const f = await fixture(t, (_message, response) => { response.writeHead(500); response.end('<html>synthetic-bridge-token upstream secret</html>'); });
  f.send({ id: 6, method: 'tools/list' }); await until(() => f.messages.length);
  assert.match(f.messages[0].error.message, /HTTP 500/);
  assert.equal(JSON.stringify(f.messages).includes('synthetic-bridge-token'), false);
});

test('stdio bridge: 拒绝响应身份不匹配及不合法 JSON-RPC', async t => {
  const f = await fixture(t, (_message, response) => { response.setHeader('content-type', 'application/json'); response.end('{"jsonrpc":"2.0","id":"another","result":{}}'); });
  f.send({ id: 'expected', method: 'tools/list' }); await until(() => f.messages.length);
  assert.equal(f.messages[0].id, 'expected'); assert.ok(f.messages[0].error);
});

test('stdio bridge: 非 ASCII 资源名称使用规范编码，不因 header 抛错', async t => {
  const f = await fixture(t, (message, response) => reply(message, response));
  f.send({ id: 'unicode', method: 'resources/read', params: { uri: 'file:///项目/配置.yml' } });
  await until(() => f.messages.length);
  assert.equal(f.messages[0].error, undefined);
  const encoded = f.requests[0].headers['mcp-name'];
  assert.match(encoded || '', /^=\?base64\?.*\?=$/);
  assert.equal(Buffer.from(encoded.slice(9, -2), 'base64').toString(), 'file:///项目/配置.yml');
});

test('stdio bridge: 请求输入有界，拒绝超长行后仍能处理下一行', async t => {
  const f = await fixture(t, (message, response) => reply(message, response));
  f.send({ id: 'large', method: 'tools/call', params: { name: 'x', data: 'x'.repeat(300 * 1024) } });
  f.send({ id: 'small', method: 'tools/list' });
  await until(() => f.messages.some(m => m.id === 'small'));
  assert.equal(f.requests.some(r => r.message.id === 'large'), false);
  assert.ok(f.messages.some(m => m.error));
});

test('stdio bridge: 已排队请求取消与重复 ID 不会导致重复执行', async t => {
  let release;
  const f = await fixture(t, (message, response) => {
    if (message.id === 'first') release = () => reply(message, response);
    else reply(message, response);
  }, { COMPOSEOPS_MCP_TIMEOUT_MS: '2000' });
  f.send({ id: 'first', method: 'tools/call' });
  await until(() => release);
  f.send({ id: 'first', method: 'tools/call' });
  f.send({ id: 'queued', method: 'tools/call' });
  f.send({ method: 'notifications/cancelled', params: { requestId: 'queued' } });
  f.send({ id: 'last', method: 'tools/list' });
  await sleep(50); release();
  await until(() => f.messages.length === 2);
  assert.deepEqual(f.requests.map(r => r.message.id), ['first', 'last']);
  assert.deepEqual(f.messages.map(r => r.id), ['first', 'last']);
});

test('stdio bridge: 队列饱和时拒绝新请求，取消仍可立即处理', async t => {
  const f = await fixture(t, () => {}, { COMPOSEOPS_MCP_TIMEOUT_MS: '2000' });
  f.send({ id: 0, method: 'tools/call' }); await until(() => f.requests.length === 1);
  for (let id = 1; id <= 32; id++) f.send({ id, method: 'tools/call' });
  await until(() => f.messages.length);
  assert.equal(f.messages[0].id, 32);
  assert.equal(f.messages[0].error.data.sent, false);
  for (let requestId = 31; requestId >= 0; requestId--) f.send({ method: 'notifications/cancelled', params: { requestId } });
  await sleep(100);
  assert.equal(f.requests.length, 1);
});

test('stdio bridge: 分片 UTF-8 与同块多行保留文字和执行顺序', async t => {
  const f = await fixture(t, (message, response) => reply(message, response, message.params), { COMPOSEOPS_MCP_TIMEOUT_MS: '2000' });
  const data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'utf8', method: 'tools/call', params: { name: '中文' } }) + '\n');
  const split = data.indexOf(Buffer.from('中')) + 1;
  f.child.stdin.write(data.subarray(0, split)); await sleep(20);
  f.child.stdin.write(Buffer.concat([data.subarray(split), Buffer.from('{"jsonrpc":"2.0","id":"second","method":"tools/list"}\n')]));
  await until(() => f.messages.length === 2);
  assert.equal(f.messages[0].result.name, '中文');
  assert.deepEqual(f.requests.map(r => r.message.id), ['utf8', 'second']);
});

test('stdio bridge: 不跟随重定向，也不向其他 URL 转交凭据或写入', async t => {
  const f = await fixture(t, (_message, response) => { response.writeHead(307, { location: '/elsewhere' }); response.end(); });
  f.send({ id: 'redirect', method: 'tools/call' }); await until(() => f.messages.length);
  assert.match(f.messages[0].error.message, /HTTP 307/);
  assert.equal(f.requests.length, 1);
});

test('stdio bridge: 字面 base64 标记名称重新编码以避免误解码', async t => {
  const f = await fixture(t, (message, response) => reply(message, response));
  f.send({ id: 'sentinel', method: 'tools/call', params: { name: '=?base64?YWJj?=' } });
  await until(() => f.messages.length);
  assert.equal(Buffer.from(f.requests[0].headers['mcp-name'].slice(9, -2), 'base64').toString(), '=?base64?YWJj?=');
});

test('stdio bridge: 客户端关闭 stdin 时终止挂起读取且不再执行排队写入', async t => {
  const f = await fixture(t, () => {}, { COMPOSEOPS_MCP_TIMEOUT_MS: '10000' });
  f.send({ id: 'active', method: 'tools/call' }); await until(() => f.requests.length === 1);
  f.send({ id: 'queued', method: 'tools/call' });
  f.child.stdin.end();
  await until(() => f.child.exitCode !== null || f.child.signalCode !== null, 1500);
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.requests.length, 1);
});

test('stdio bridge: stdout 阻塞时 SIGTERM 仍可退出并停止后续写入', async t => {
  const f = await fixture(t, (message, response) => reply(message, response, { text: 'x'.repeat(1024 * 1024) }), { COMPOSEOPS_MCP_TIMEOUT_MS: '10000' });
  f.child.stdout.pause();
  f.send({ id: 'blocked', method: 'tools/list' }); await until(() => f.requests.length === 1);
  await sleep(100);
  f.child.kill('SIGTERM');
  await until(() => f.child.exitCode !== null || f.child.signalCode !== null, 1500);
  assert.equal(f.child.exitCode, 0);
});

test('stdio bridge: 无效 _meta 和版本类型在发送前拒绝', async t => {
  const f = await fixture(t, (message, response) => reply(message, response));
  for (const _meta of [[], 'text', { 'io.modelcontextprotocol/protocolVersion': {} }]) {
    f.send({ id: String(JSON.stringify(_meta)), method: 'tools/list', params: { _meta } });
  }
  await until(() => f.messages.length === 3);
  assert.equal(f.requests.length, 0);
  assert.ok(f.messages.every(m => m.error?.code === -32600));
});

test('stdio bridge: 超时包含排队时间，过期写入不会被发送', async t => {
  const f = await fixture(t, (message, response) => reply(message, response, { text: 'x'.repeat(1024 * 1024) }));
  f.child.stdout.pause();
  f.send({ id: 'active', method: 'tools/call' });
  f.send({ id: 'queued', method: 'tools/call' });
  await until(() => f.requests.length === 1);
  // Hold the first response past the queued request's absolute deadline.
  await sleep(350); f.child.stdout.resume();
  await until(() => f.messages.length === 2);
  assert.deepEqual(f.requests.map(r => r.message.id), ['active']);
  assert.equal(f.messages[1].id, 'queued');
  assert.equal(f.messages[1].error.data.sent, false);
});

test('stdio bridge: 版本协商保留规范错误码和日期，剔除上游任意文本', async t => {
  const f = await fixture(t, (message, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32022, message: 'synthetic-bridge-token', data: { supported: ['2026-07-28', '2025-06-18'], secret: 'synthetic-bridge-token' } } }));
  });
  f.send({ id: 'version', method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } });
  await until(() => f.messages.length);
  assert.equal(f.messages[0].error.code, -32022);
  assert.deepEqual(f.messages[0].error.data, { supported: ['2026-07-28', '2025-06-18'], requested: '2099-01-01' });
  assert.equal(JSON.stringify(f.messages).includes('synthetic-bridge-token'), false);
});

test('stdio bridge: stdout 断开后退出，不发出额外请求', async t => {
  const f = await fixture(t, (message, response) => reply(message, response), { COMPOSEOPS_MCP_TIMEOUT_MS: '10000' });
  f.child.stdout.destroy();
  f.send({ id: 1, method: 'tools/list' });
  await until(() => f.child.exitCode !== null || f.child.signalCode !== null, 1500);
  assert.equal(f.child.exitCode, 0);
  assert.ok(f.requests.length <= 1);
});

test('stdio bridge: 已取消请求的服务端迟到响应被丢弃', async t => {
  let late;
  const f = await fixture(t, (message, response) => {
    if (message.id === 'cancelled') late = () => reply(message, response, { late: true });
    else reply(message, response);
  }, { COMPOSEOPS_MCP_TIMEOUT_MS: '2000' });
  f.send({ id: 'cancelled', method: 'tools/call' }); await until(() => late);
  f.send({ method: 'notifications/cancelled', params: { requestId: 'cancelled' } });
  f.send({ id: 'next', method: 'tools/list' }); await until(() => f.messages.length);
  late(); await sleep(50);
  assert.deepEqual(f.messages.map(m => m.id), ['next']);
});

for (const [label, body, type] of [
  ['双重结果', '{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1,"message":"error"}}', 'application/json'],
  ['无效错误', '{"jsonrpc":"2.0","id":1,"error":{"code":"-1","message":"error"}}', 'application/json'],
  ['无效 JSON', '{', 'application/json'],
  ['SSE', 'data: {}\n\n', 'text/event-stream'],
]) test(`stdio bridge: 拒绝${label}响应`, async t => {
  const f = await fixture(t, (_message, response) => { response.writeHead(200, { 'content-type': type }); response.end(body); });
  f.send({ id: 1, method: 'tools/list' }); await until(() => f.messages.length);
  assert.equal(f.messages[0].id, 1);
  assert.equal(f.messages[0].error.code, -32000);
});
