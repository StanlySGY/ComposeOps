/**
 * MCP(Model Context Protocol)Server:把 ComposeOps 的 Agent 工具暴露给
 * 外部 MCP 客户端(Claude Desktop / Claude Code / Cursor / Codex CLI /
 * Gemini CLI / 各类 agent harness 等),让"面板里的运维能力"变成生态入口。
 *
 * 三种传输,覆盖全部主流客户端:
 *  1. Streamable HTTP(2025-03-26 起引入,2026-07-28 起是唯一的 HTTP 形态):
 *     POST /mcp —— 单端点,无状态,请求即 JSON-RPC,响应即 application/json;
 *     通知(无 id)返回 202;GET/DELETE /mcp 返回 405(不提供服务端-initiated 流)。
 *  2. 经典 SSE(向后兼容,Claude Desktop/Cursor 早期配置沿用,2024-11-05 传输):
 *     GET /mcp/sse 建立 SSE 流 + POST /mcp/message?sessionId= 接收请求。
 *  3. stdio-only 客户端:仓库 mcp/stdio-bridge.mjs 把 stdio 转发到上面任一 HTTP 端点。
 *
 * 双协议时代(2026-07-28 起 MCP 取消 initialize 握手,版本改由每请求 _meta 声明):
 *  - modern:请求体 params._meta['io.modelcontextprotocol/protocolVersion'] 声明版本;
 *    服务器 MUST 实现 server/discover,未知版本回 -32022 并列出 supported;
 *  - legacy:继续支持 initialize 握手(2025-11-25 及更早),在支持列表内回显客户端版本;
 *  - 早期规范把工具名限制为 [a-zA-Z0-9_-],而 2026-07-28 明确允许点号(admin.tools.list),
 *    故清单只发规范名(compose.up),调用时同时接受 compose_up 这种下划线别名。
 *
 * 头一致性(防代理与服务器对"谁是真的"产生分歧):
 *  - MCP-Protocol-Version / Mcp-Method / Mcp-Name 与请求体不一致 → 400 + -32020
 *    HeaderMismatch(规范要求);缺失头只记日志不拒绝,兼容尚未补齐头的客户端。
 *
 * 安全模型:
 *  - 独立 token(setting mcp.token)鉴权,与面板会话体系隔离;未启用时端点关闭;
 *  - Origin 校验:浏览器型客户端必须同源(防 DNS rebinding),桌面客户端不带 Origin 直接放行;
 *  - mode=readonly(默认)只暴露低/中风险且不需确认的工具;mode=all 追加高风险;
 *    critical 工具(maintenance.clean / app.deploy)在任何模式下都不经 MCP 暴露
 *    ——MCP 调用方没有人工确认门,critical 必须 fail-closed;
 *  - 高危工具必须由调用方显式传 confirm:true 才执行(借鉴 fork composeops-hermes):
 *    面板侧靠确认弹窗,MCP 通道没有 UI,用显式开关代替,避免模型把破坏性调用
 *    当成普通查询顺手发出去;同时用 tool annotations(readOnlyHint/destructiveHint)
 *    把风险声明给客户端,让支持注解的客户端自己弹确认;
 *  - 工具结果先 redactValue 脱敏、再按 24K 保留首尾截断,防超长日志灌爆对方上下文;
 *  - 工具执行复用 agent 引擎的权限门/参数校验/操作锁/审计,与面板内一致。
 */

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { getSetting, setSetting } from '../lib/db.js';
import { getAgent } from '../services/agent.js';
import { assessRisk } from '../services/agent-tools.js';
import { redactValue } from '../lib/redaction.js';
import { validateOrigin } from '../lib/auth.js';
import { checkRateLimit } from '../lib/rate-limit.js';

const sessions = new Map(); // sessionId -> { write, heartbeat, agent }

/** 服务器实现的最新(modern)协议修订。 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
/** 支持协商的历史版本:modern 一个 + legacy 全部(含 2024-11-05 的 HTTP+SSE 传输)。 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05',
];
/** 客户端请求了不支持的版本时,回落到这个广泛兼容的 legacy 版本。 */
const LEGACY_FALLBACK_VERSION = '2025-06-18';
const CLIENT_META_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const SERVER_NAME = 'composeops';
const SERVER_VERSION = '1.3.0';
const SERVER_TITLE = 'ComposeOps Ops Tools';
const SERVER_INSTRUCTIONS = 'Docker Compose 运维工具集(状态/日志/指标/巡检/备份/GitOps 漂移)。'
  + '高危工具(重建容器、改 Compose、回滚配置等)必须显式传 confirm:true 才会执行;'
  + '清理与部署类 critical 工具不经此通道暴露,请到 ComposeOps 面板中操作。';

/** 单次工具结果返回给调用方的字符上限(保留首尾),防超长日志灌爆对方上下文。 */
export const TOOL_RESULT_MAX = 24000;

/** 结果命中"外部世界"的工具前缀:注解里用于 openWorldHint。 */
const OPEN_WORLD_PREFIXES = ['web.', 'marketplace.', 'image.'];

function getConfig() {
  return {
    enabled: getSetting('mcp.enabled', '0') === '1',
    mode: getSetting('mcp.mode', 'readonly') === 'all' ? 'all' : 'readonly',
    token: getSetting('mcp.token', ''),
  };
}

function checkToken(provided) {
  const { token } = getConfig();
  if (!token) return false;
  const a = createHash('sha256').update(String(provided || '')).digest();
  const b = createHash('sha256').update(token).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 按模式过滤可暴露的工具;critical 永不暴露(MCP 无人审门,fail-closed)。 */
export function exportableTools(mode) {
  const agent = getAgent();
  return agent.listTools().filter((tool) => {
    if (tool.isMacro || tool.name.startsWith('macro.')) return false;
    if (assessRisk(tool.name, {}, {}) === 'critical') return false;
    if (mode === 'all') return true;
    return (tool.risk === 'low' || tool.risk === 'medium') && !tool.confirmationRequired;
  });
}

/** 高危工具(声明需确认,或动态风险评估为 high)在 MCP 通道必须显式 confirm。 */
export function needsExplicitConfirm(tool) {
  return tool.confirmationRequired === true || assessRisk(tool.name, {}, {}) === 'high';
}

/**
 * 工具名解析:规范名优先,再试下划线别名。
 * 早期 MCP 客户端/网关会把点号换成下划线(2024-11-05 规范只允许 [a-zA-Z0-9_-]),
 * 这里兜住这类客户端,清单里始终只发规范名。
 */
export function resolveExposedTool(name, mode) {
  const raw = String(name || '');
  if (!raw) return null;
  const tools = exportableTools(mode);
  const exact = tools.find((tool) => tool.name === raw);
  if (exact) return exact;
  if (!raw.includes('_')) return null;
  // 兼容把点号整体替换成下划线的客户端:按同规则归一化后再比,
  // 这样 project.list_managed 的别名 project_list_managed 也能命中。
  return tools.find((tool) => tool.name.replace(/\./g, '_') === raw) || null;
}

/** 把风险声明成 MCP tool annotations,让客户端自己决定是否弹确认。 */
export function annotationsFor(tool) {
  const readOnly = !needsExplicitConfirm(tool);
  const annotations = {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    openWorldHint: OPEN_WORLD_PREFIXES.some((prefix) => tool.name.startsWith(prefix)),
  };
  // 只对只读工具声明确切的幂等性;写操作是否幂等因工具而异,不替它们宣称。
  if (readOnly) annotations.idempotentHint = true;
  return annotations;
}

/** 结果文本截断:保留首尾(头部通常是结论,尾部是错误细节)。 */
export function truncateMcpText(text, max = TOOL_RESULT_MAX) {
  if (typeof text !== 'string' || text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…[已截断 ${text.length - max} 字符,完整结果见 ComposeOps 面板执行历史]…\n${text.slice(-half)}`;
}

/** 统一结果包装:脱敏 → 截断 → 结构化内容(未被截断时才给 structuredContent)。 */
export function wrapToolResult(payload, failed = false) {
  const safe = redactValue(payload);
  let text;
  try {
    text = JSON.stringify(safe, null, 2) ?? String(safe);
  } catch {
    text = String(safe);
  }
  const truncated = text.length > TOOL_RESULT_MAX;
  const result = { content: [{ type: 'text', text: truncated ? truncateMcpText(text) : text }], isError: failed === true };
  if (!truncated && safe && typeof safe === 'object') result.structuredContent = safe;
  return result;
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

/** 协议版本:优先体 _meta(modern),回落 HTTP 头;都没有即 legacy 请求。 */
function requestProtocolVersion(message, headers = {}) {
  const meta = message?.params?._meta;
  const fromBody = meta && typeof meta === 'object' ? meta[CLIENT_META_VERSION_KEY] : undefined;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  const fromHeader = headers['mcp-protocol-version'];
  return typeof fromHeader === 'string' && fromHeader ? fromHeader : '';
}

/** Base64 sentinel 解码(规范里 Mcp-Name 可用 =?base64?xxx?= 承载非 ASCII 值)。 */
function decodeHeaderValue(value) {
  const raw = String(value ?? '');
  if (raw.startsWith('=?base64?') && raw.endsWith('?=')) {
    try {
      return Buffer.from(raw.slice(9, -2), 'base64').toString('utf8');
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * 头↔体一致性校验(规范 Server Validation):
 * 不一致 → -32020 HeaderMismatch;缺失 → 放行(兼容尚未补齐头的客户端)。
 * 理由:头不一致会让中间代理和服务器对同一请求产生两种理解(安全风险),
 * 而缺头只是客户端还没跟上 2026-07-28 的新要求,拒绝它没有收益。
 */
export function validateRequestHeaders(message, headers = {}) {
  const headerVersion = headers['mcp-protocol-version'];
  const bodyVersion = message?.params?._meta?.[CLIENT_META_VERSION_KEY];
  if (headerVersion && bodyVersion && headerVersion !== bodyVersion) {
    return `MCP-Protocol-Version 头(${headerVersion})与请求体版本(${bodyVersion})不一致`;
  }
  const headerMethod = headers['mcp-method'];
  if (headerMethod && message?.method && headerMethod !== message.method) {
    return `Mcp-Method 头(${headerMethod})与请求体方法(${message.method})不一致`;
  }
  const headerName = headers['mcp-name'];
  const bodyName = message?.params?.name;
  if (headerName && bodyName && decodeHeaderValue(headerName) !== String(bodyName)) {
    return `Mcp-Name 头(${headerName})与请求体工具名(${bodyName})不一致`;
  }
  return null;
}

function serverInfoMeta() {
  return { [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version: SERVER_VERSION, title: SERVER_TITLE } };
}

function discoverResult() {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: { tools: { listChanged: false } },
    instructions: SERVER_INSTRUCTIONS,
    _meta: serverInfoMeta(),
    ttlMs: 3600000,
    cacheScope: 'public',
  };
}

function listToolsResult(mode, id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      tools: exportableTools(mode).map((tool) => ({
        name: tool.name,
        title: tool.description ? String(tool.description).slice(0, 60) : tool.name,
        description: tool.description || '',
        inputSchema: tool.parameters || { type: 'object', properties: {} },
        annotations: annotationsFor(tool),
      })),
      ttlMs: 60000,
      cacheScope: 'private',
    },
  };
}

async function callToolResult(agent, mode, message) {
  const { id, params } = message;
  const requested = String(params?.name || '');
  const tool = resolveExposedTool(requested, mode);
  if (!tool) {
    return { status: 200, body: jsonRpcError(id, -32602, `工具 ${requested} 不存在或未在当前 MCP 模式下暴露`) };
  }
  const args = { ...(params?.arguments || {}) };
  const confirmed = args.confirm === true;
  delete args.confirm;
  if (needsExplicitConfirm(tool) && !confirmed) {
    // 用 isError 结果而非协议错误:这样模型能读到原因并带 confirm:true 重试。
    const reason = tool.confirmationRequired === true && assessRisk(tool.name, {}, {}) !== 'high'
      ? `工具 ${tool.name} 会改动系统状态(风险等级 ${tool.risk})`
      : `工具 ${tool.name} 风险等级为 ${tool.risk}`;
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: wrapToolResult({
          tool: tool.name,
          success: false,
          error: `${reason},MCP 通道没有确认弹窗:确认要执行请带 confirm=true 重新调用。`,
        }, true),
      },
    };
  }
  try {
    const outcome = await agent.executeTool(tool.name, args, { webSearchEnabled: false }, []);
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: wrapToolResult({
          tool: tool.name,
          success: outcome.success === true,
          durationMs: outcome.durationMs,
          result: outcome.result ?? null,
          error: outcome.error ?? null,
        }, outcome.success !== true),
      },
    };
  } catch (error) {
    return { status: 200, body: { jsonrpc: '2.0', id, result: wrapToolResult({ tool: tool.name, success: false, error: error.message }, true) } };
  }
}

/**
 * 处理单条 JSON-RPC 消息。
 * @returns {Promise<{status:number, body:object|null}>} body 为 null 表示通知(HTTP 202)。
 */
export async function handleRpc(agent, mode, message, { headers = {} } = {}) {
  const { id, method, params } = message || {};
  if (!method || typeof method !== 'string') {
    return { status: 400, body: jsonRpcError(id, -32600, '缺少 method 字段') };
  }
  if ((method || '').startsWith('notifications/')) return { status: 202, body: null };

  const version = requestProtocolVersion(message, headers);
  if (version && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return {
      status: 400,
      body: jsonRpcError(id, -32022, 'Unsupported protocol version', {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        requested: version,
      }),
    };
  }
  const mismatch = validateRequestHeaders(message, headers);
  if (mismatch) return { status: 400, body: jsonRpcError(id, -32020, `Header mismatch:${mismatch}`) };

  if (method === 'server/discover') return { status: 200, body: { jsonrpc: '2.0', id, result: discoverResult() } };

  if (method === 'initialize') {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LEGACY_FALLBACK_VERSION;
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: SERVER_TITLE },
          instructions: SERVER_INSTRUCTIONS,
        },
      },
    };
  }
  if (method === 'ping') return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  if (method === 'tools/list') return { status: 200, body: listToolsResult(mode, id) };
  if (method === 'tools/call') return callToolResult(agent, mode, message);
  // 未知方法统一回 -32601。版本不匹配的客户端(2026-07-28 规范要求 404 形态)
  // 不会被这里骗到:它读的是错误码,而 -32601 在历代 revision 里语义一致。
  return { status: 200, body: jsonRpcError(id, -32601, `未知方法:${method}`) };
}

export default async function mcpRoutes(fastify) {
  // ---- 管理面:配置读写挂在 /api/v1/system/mcp(受登录鉴权保护),见 system.js ----

  /** 三个端点共用的准入检查:限流 + 启用 + token + Origin。
   *  限流放在鉴权之前:无效 token 的请求同样计数,防止对 mcp.token 的穷举重放。 */
  function guard(request, reply) {
    const verdict = checkRateLimit(`mcp:${request.ip || 'local'}`, 120, 60000);
    if (!verdict.allowed) {
      reply.code(429).send({
        error: 'rate_limited',
        message: 'MCP 请求过于频繁,请稍后再试',
        retryAfterMs: verdict.retryAfterMs,
      });
      return false;
    }
    const { enabled } = getConfig();
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, '') || request.query?.token || '';
    if (!enabled) {
      reply.code(403).send({ error: 'mcp_disabled', message: 'MCP 服务未启用(设置中开启)' });
      return false;
    }
    if (!checkToken(provided)) {
      reply.code(401).send({ error: 'invalid_token', message: 'MCP token 不匹配' });
      return false;
    }
    // DNS rebinding 防护:浏览器型客户端一定带 Origin 且必须同源;
    // 桌面/CLI 客户端不带 Origin,直接放行(与面板 validateOrigin 同一取舍)。
    if (!validateOrigin(request)) {
      reply.code(403).send({ error: 'origin_mismatch', message: 'Origin 与服务主机不匹配' });
      return false;
    }
    return true;
  }

  // ---- Streamable HTTP(现行标准,无状态):POST /mcp ----
  fastify.post('/', async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const { mode } = getConfig();
    const message = request.body;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return reply.code(400).send({ error: 'invalid_request', message: '请求体必须是单个 JSON-RPC 对象' });
    }
    const { status, body } = await handleRpc(getAgent(), mode, message, { headers: request.headers });
    if (!body) return reply.code(202).send(); // 通知:无响应体
    return reply.code(status).header('Content-Type', 'application/json').send(body);
  });

  fastify.get('/', async (request, reply) => {
    // 本服务器不提供服务端-initiated 流;按规范返回 405 让客户端走 POST。
    return reply.code(405).send({ error: 'method_not_allowed', message: '本服务为无状态 Streamable HTTP,仅支持 POST /mcp' });
  });
  fastify.delete('/', async (request, reply) => {
    return reply.code(405).send({ error: 'method_not_allowed', message: '无状态模式无会话可终止' });
  });

  fastify.get('/sse', async (request, reply) => {
    if (!guard(request, reply)) return reply;
    // SSE 是长连接,单独收紧建立频率,防连接洪水拖垮进程。
    const sseVerdict = checkRateLimit(`mcp-sse:${request.ip || 'local'}`, 10, 60000);
    if (!sseVerdict.allowed) {
      return reply.code(429).send({ error: 'rate_limited', message: 'SSE 建立过于频繁,请稍后再试', retryAfterMs: sseVerdict.retryAfterMs });
    }

    const sessionId = randomBytes(12).toString('hex');
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: endpoint\ndata: /mcp/message?sessionId=${sessionId}\n\n`);
    const heartbeat = setInterval(() => {
      try { reply.raw.write(': ping\n\n'); } catch { /* 断连时由 close 清理 */ }
    }, 30000);
    heartbeat.unref?.();

    const agent = getAgent();
    // write 只负责落盘;SSE 帧的组装统一在 sendToSession,避免双重编码
    sessions.set(sessionId, { write: (payload) => reply.raw.write(payload), heartbeat, agent });
    request.log.info({ sessionId }, '[mcp] session connected');
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      sessions.delete(sessionId);
    });
    await new Promise(() => {}); // SSE 长连接:由 close 事件结束
  });

  fastify.post('/message', async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const { mode } = getConfig();
    const sessionId = String(request.query?.sessionId || '');
    const session = sessions.get(sessionId);
    if (!session) return reply.code(404).send({ error: 'session_not_found', message: 'MCP 会话不存在或已断开' });

    const message = request.body;
    if (!message || typeof message !== 'object') return reply.code(400).send({ error: 'invalid_request', message: '请求体必须是 JSON-RPC 对象' });

    const { body } = await handleRpc(session.agent, mode, message, { headers: request.headers });
    if (body) sendToSession(session, body);
    return reply.code(202).send({ accepted: true });
  });
}

function sendToSession(session, payload) {
  try {
    session.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** 供 system.js 管理路由使用:读取配置(token 掩码)。 */
export function getMcpStatus() {
  const config = getConfig();
  return {
    enabled: config.enabled,
    mode: config.mode,
    token: config.token ? '••••' + config.token.slice(-4) : '',
    configured: !!config.token,
    sseUrl: '/mcp/sse',
    httpUrl: '/mcp',
    protocolVersion: MCP_PROTOCOL_VERSION,
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    sessionCount: sessions.size,
    toolsExported: config.enabled ? exportableTools(config.mode).length : 0,
  };
}

export function saveMcpConfig({ enabled, mode, regenerateToken = false } = {}) {
  if (enabled !== undefined) setSetting('mcp.enabled', enabled ? '1' : '0');
  if (mode !== undefined) setSetting('mcp.mode', mode === 'all' ? 'all' : 'readonly');
  if (regenerateToken || !getSetting('mcp.token', '')) {
    setSetting('mcp.token', randomBytes(24).toString('hex'));
  }
  return getMcpStatus();
}

/** 暴露完整 token(仅管理端点本人读取一次,用于粘贴进 MCP 客户端)。 */
export function revealMcpToken() {
  const config = getConfig();
  if (!config.token) return { token: '' };
  return { token: config.token };
}
