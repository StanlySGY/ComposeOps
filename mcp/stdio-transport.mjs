/** Bounded, serial JSON-RPC transport for ComposeOps' JSON HTTP endpoint. */
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const INPUT_MAX_BYTES = 256 * 1024;
export const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_PENDING = 32;
const hasId = message => Object.hasOwn(message, 'id');
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
const transportError = message => Object.assign(new Error(message), { safe: true });
const validVersion = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

function validResponse(result, id) {
  return result && !Array.isArray(result) && result.jsonrpc === '2.0' && result.id === id
    && Object.hasOwn(result, 'result') !== Object.hasOwn(result, 'error')
    && (!Object.hasOwn(result, 'error') || (result.error && Number.isInteger(result.error.code) && typeof result.error.message === 'string'));
}

function headerValue(value) {
  const text = String(value);
  return /^[\x20-\x7e]*$/.test(text) && text.trim() === text && !/^=\?base64\?.*\?=$/.test(text)
    ? text : `=?base64?${Buffer.from(text).toString('base64')}?=`;
}
function prepare(message, token, version) {
  let body = message;
  if (!message.method.startsWith('notifications/')) {
    const params = { ...message.params }, meta = { ...params._meta };
    if (!meta[META_VERSION]) meta[META_VERSION] = version;
    body = { ...message, params: { ...params, _meta: meta } };
  }
  const headers = {
    'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}`,
    'MCP-Protocol-Version': body.params?._meta?.[META_VERSION] || version, 'Mcp-Method': message.method,
  };
  const name = message.params?.name ?? message.params?.uri;
  if (name !== undefined && name !== null && String(name)) headers['Mcp-Name'] = headerValue(name);
  return { body: JSON.stringify(body), headers };
}

/** Split bytes before UTF-8 decoding, retaining at most one bounded line. */
async function* lines(input) {
  let pieces = [], size = 0, oversized = false;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      size += piece.length;
      if (size > INPUT_MAX_BYTES) { oversized = true; pieces = []; }
      else if (!oversized) pieces.push(piece);
      if (newline < 0) break;
      yield oversized ? null : Buffer.concat(pieces, size).toString('utf8').trim();
      pieces = []; size = 0; oversized = false; start = newline + 1;
    }
  }
  if (size || oversized) yield oversized ? null : Buffer.concat(pieces, size).toString('utf8').trim();
}

async function readResponse(response) {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > RESPONSE_MAX_BYTES) {
    await response.body?.cancel();
    throw transportError('响应超过读取上限');
  }
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = [];
  let size = 0, done = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { done = true; break; }
      size += next.value.byteLength;
      if (size > RESPONSE_MAX_BYTES) throw transportError('响应超过读取上限');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function runBridge({ baseUrl, token, protocolVersion = '2026-07-28', timeoutMs = 120000,
  input = process.stdin, output = process.stdout } = {}) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !token
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900000 || !validVersion(protocolVersion)) {
    throw new Error('Invalid bridge configuration');
  }
  const endpoint = url.href.replace(/\/+$/, '') + '/mcp';
  const queue = [], pending = new Map();
  let worker, active, cancelWrite, stopped = false, outputChain = Promise.resolve();
  function stop() {
    if (stopped) return;
    stopped = true;
    cancelWrite?.();
    active?.controller.abort();
    queue.length = 0;
    pending.clear();
    input.destroy();
    output.destroy();
  }
  function send(message, shouldSend = () => true) {
    // Await callbacks as well as queueing complete lines: a slow/disconnected
    // stdout consumer cannot accumulate unbounded serialized responses.
    outputChain = outputChain.then(() => stopped || !shouldSend() ? undefined : new Promise((resolve, reject) => {
      let settled = false;
      const finish = cause => {
        if (settled) return;
        settled = true; cancelWrite = null;
        if (cause) reject(cause); else resolve();
      };
      // Only the currently blocked write retains a shutdown callback; racing
      // every response against one unresolved promise would retain all races.
      cancelWrite = () => finish();
      output.write(JSON.stringify(message) + '\n', finish);
    })).catch(() => { stop(); });
    return outputChain;
  }
  async function execute(entry) {
    const { message } = entry;
    const remaining = entry.deadline - Date.now();
    if (remaining <= 0) {
      if (hasId(message)) await send(rpcError(message.id, -32000, '请求排队超时，未发送到服务端', { sent: false, retryable: false }), () => !entry.cancelled);
      return;
    }
    let timedOut = false, sent = false;
    const timer = setTimeout(() => { timedOut = true; entry.controller.abort(); }, remaining);
    try {
      const prepared = prepare(message, token, protocolVersion);
      sent = true;
      const response = await fetch(endpoint, { method: 'POST', ...prepared, redirect: 'manual', signal: entry.controller.signal });
      if (!hasId(message)) { await response.body?.cancel(); return; }
      if (!response.ok) {
        // Protocol negotiation needs the supported version list, but arbitrary
        // HTTP error bodies may contain proxy diagnostics or credentials.
        if (response.status === 400 && /^application\/json\s*(?:;|$)/i.test(response.headers.get('content-type') || '')) {
          const raw = await readResponse(response);
          let failure;
          try { failure = JSON.parse(raw); } catch { /* Use safe status-only error below. */ }
          const supported = failure?.error?.data?.supported;
          if (validResponse(failure, message.id) && failure.error?.code === -32022 && Array.isArray(supported)
            && supported.length > 0 && supported.length <= 16 && supported.every(validVersion)) {
            await send(rpcError(message.id, -32022, 'Unsupported protocol version', { supported,
              requested: prepared.headers['MCP-Protocol-Version'] }), () => !entry.cancelled);
            return;
          }
        }
        await response.body?.cancel();
        throw transportError(`HTTP ${response.status}，请检查接入配置与任务记录`);
      }
      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel();
        throw transportError('请求未返回执行结果，请到面板核对');
      }
      if (!/^application\/json\s*(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw transportError('响应不是支持的 JSON 格式');
      }
      const raw = await readResponse(response);
      let result;
      try { result = JSON.parse(raw); } catch { throw transportError('响应 JSON 无法解析'); }
      if (!validResponse(result, message.id)) {
        throw transportError('响应身份或 JSON-RPC 格式不匹配');
      }
      if (!entry.cancelled && !stopped) await send(result, () => !entry.cancelled);
    } catch (cause) {
      if (entry.cancelled || stopped || !hasId(message)) return;
      const description = timedOut ? '请求超时，请到面板核对结果；不会自动重试'
        : cause.safe ? cause.message : '桥接连接失败，请到面板核对结果；不会自动重试';
      await send(rpcError(message.id, -32000, description, { sent, outcomeUnknown: sent, retryable: false }), () => !entry.cancelled);
    } finally { clearTimeout(timer); }
  }
  function startWorker() {
    if (worker || stopped) return;
    worker = (async () => {
      while (queue.length && !stopped) {
        const entry = queue.shift();
        active = entry;
        try { if (!entry.cancelled) await execute(entry); }
        finally { if (hasId(entry.message)) pending.delete(entry.message.id); active = null; }
      }
    })().finally(() => { worker = null; if (queue.length && !stopped) startWorker(); });
  }
  async function accept(line) {
    if (line === '') return;
    if (line === null) { await send(rpcError(null, -32600, '请求行超过 256 KiB 上限')); return; }
    let message;
    try { message = JSON.parse(line); } catch { await send(rpcError(null, -32700, '请求 JSON 无法解析')); return; }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || !/^[\w./-]{1,128}$/.test(message.method)
      || (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)))
      || (message.params?._meta !== undefined && (!message.params._meta || typeof message.params._meta !== 'object' || Array.isArray(message.params._meta)))
      || (message.params?._meta?.[META_VERSION] !== undefined && !validVersion(message.params._meta[META_VERSION]))
      || (hasId(message) && !(typeof message.id === 'string' || Number.isSafeInteger(message.id)))) {
      await send(rpcError(null, -32600, '请求 JSON-RPC 格式无效')); return;
    }
    if (message.method === 'notifications/cancelled' && !hasId(message)) {
      const entry = pending.get(message.params?.requestId);
      if (entry) {
        entry.cancelled = true; entry.controller.abort();
        const index = queue.indexOf(entry);
        if (index >= 0) { queue.splice(index, 1); pending.delete(message.params.requestId); }
      }
      return;
    }
    if (hasId(message) && pending.has(message.id)) {
      // A second reply for this ID would be ambiguous; never dispatch twice.
      return;
    }
    if (queue.length + (active ? 1 : 0) >= MAX_PENDING) {
      if (hasId(message)) await send(rpcError(message.id, -32000, '待处理请求超过 32 项上限，未发送', { sent: false, retryable: false }));
      return;
    }
    const entry = { message, controller: new AbortController(), deadline: Date.now() + timeoutMs, cancelled: false };
    if (hasId(message)) pending.set(message.id, entry);
    queue.push(entry); startWorker();
  }
  output.on('error', stop);
  output.on('close', stop);
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    for await (const line of lines(input)) { if (stopped) break; await accept(line); }
    // MCP clients close stdin to shut down. Queued operations must not outlive
    // their client, and an in-flight HTTP abort does not roll back server work.
    stop();
    while (worker) await worker;
    await outputChain;
  } catch (cause) { if (!stopped) throw cause; }
  finally {
    stop();
    const removeOutputListeners = () => { output.removeListener('error', stop); output.removeListener('close', stop); };
    if (output.closed) removeOutputListeners();
    else output.once('close', removeOutputListeners);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
