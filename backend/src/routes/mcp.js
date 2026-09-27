/**
 * MCP(Model Context Protocol)Server:把 ComposeOps 的 Agent 工具暴露给
 * 外部 MCP 客户端(Claude Desktop / Cursor 等),让"面板里的运维能力"变成
 * 生态入口。
 *
 * 传输:SSE(经典传输,兼容面最广)
 *  - GET  /mcp/sse                建立 SSE 流,下发 endpoint 事件(message URL)
 *  - POST /mcp/message?sessionId= 接收 JSON-RPC 请求,响应经 SSE 推回
 *
 * 安全模型:
 *  - 独立 token(setting mcp.token)鉴权,与面板会话体系隔离;未启用时端点关闭;
 *  - mode=readonly(默认)只暴露低/中风险且不需确认的工具;mode=all 追加高风险;
 *    critical 工具(maintenance.clean / app.deploy)在任何模式下都不经 MCP 暴露
 *    ——MCP 调用方没有人工确认门,critical 必须 fail-closed;
 *  - 工具执行复用 agent 引擎的权限门/参数校验/操作锁/审计,与面板内一致。
 */

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { getSetting, setSetting } from '../lib/db.js';
import { getAgent } from '../services/agent.js';
import { assessRisk } from '../services/agent-tools.js';

const sessions = new Map(); // sessionId -> { write, heartbeat, agent }

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
function exportableTools(mode) {
  const agent = getAgent();
  return agent.listTools().filter((tool) => {
    if (tool.isMacro || tool.name.startsWith('macro.')) return false;
    if (assessRisk(tool.name, {}, {}) === 'critical') return false;
    if (mode === 'all') return true;
    return (tool.risk === 'low' || tool.risk === 'medium') && !tool.confirmationRequired;
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

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(agent, mode, message) {
  const { id, method, params } = message || {};
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'composeops', version: '1.2.2', title: 'ComposeOps Ops Tools' },
      },
    };
  }
  if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) {
    return null; // 通知无需响应
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0', id,
      result: {
        tools: exportableTools(mode).map((tool) => ({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.parameters || { type: 'object', properties: {} },
        })),
      },
    };
  }
  if (method === 'tools/call') {
    const name = String(params?.name || '');
    const allowed = exportableTools(mode).find((tool) => tool.name === name);
    if (!allowed) {
      return jsonRpcError(id, -32602, `工具 ${name} 不存在或未在当前 MCP 模式下暴露`);
    }
    try {
      const result = await agent.executeTool(name, params?.arguments || {}, { webSearchEnabled: false }, []);
      const text = JSON.stringify({ success: result.success, result: result.success ? result.result : null, error: result.error || undefined });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: !result.success } };
    } catch (error) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `执行失败:${error.message}` }], isError: true } };
    }
  }
  return jsonRpcError(id, -32601, `未知方法:${method}`);
}

export default async function mcpRoutes(fastify) {
  // ---- 管理面:配置读写挂在 /api/v1/system/mcp(受登录鉴权保护),见 system.js ----

  fastify.get('/sse', async (request, reply) => {
    const { enabled } = getConfig();
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, '') || request.query?.token || '';
    if (!enabled) return reply.code(403).send({ error: 'mcp_disabled', message: 'MCP 服务未启用(设置中开启)' });
    if (!checkToken(provided)) return reply.code(401).send({ error: 'invalid_token', message: 'MCP token 不匹配' });

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
    const { enabled, mode } = getConfig();
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, '') || request.query?.token || '';
    if (!enabled) return reply.code(403).send({ error: 'mcp_disabled', message: 'MCP 服务未启用' });
    if (!checkToken(provided)) return reply.code(401).send({ error: 'invalid_token', message: 'MCP token 不匹配' });
    const sessionId = String(request.query?.sessionId || '');
    const session = sessions.get(sessionId);
    if (!session) return reply.code(404).send({ error: 'session_not_found', message: 'MCP 会话不存在或已断开' });

    const message = request.body;
    if (!message || typeof message !== 'object') return reply.code(400).send({ error: 'invalid_request', message: '请求体必须是 JSON-RPC 对象' });

    const response = await handleRpc(session.agent, mode, message);
    if (response) sendToSession(session, response);
    return reply.code(202).send({ accepted: true });
  });
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
