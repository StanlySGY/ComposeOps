#!/usr/bin/env node
/**
 * ComposeOps MCP stdio 桥:把本地 stdio 的 JSON-RPC 消息转发到面板的
 * Streamable HTTP 端点(POST /mcp),让只支持 stdio 传输的 MCP 客户端
 * 也能接入面板工具。
 *
 * 客户端配置示例(Claude Desktop / 任意支持 stdio 的 harness):
 * {
 *   "mcpServers": {
 *     "composeops": {
 *       "command": "node",
 *       "args": ["/path/to/ComposeOps/mcp/stdio-bridge.mjs"],
 *       "env": {
 *         "COMPOSEOPS_URL": "http://192.168.1.10:28765",
 *         "COMPOSEOPS_TOKEN": "<在面板设置-MCP 中获取>"
 *       }
 *     }
 *   }
 * }
 *
 * 协议:MCP stdio 传输 = 逐行 JSON-RPC。通知(无 id)POST 后无回写;
 * 请求的响应按行写回 stdout。HTTP 错误转成 JSON-RPC error 响应,
 * 让客户端能直接看到失败原因(token 失效/服务未启用等)。
 *
 * 版本声明:modern MCP(2026-07-28 起)没有 initialize 握手,版本由每个请求的
 * params._meta 声明。桥接层替客户端补齐该字段(客户端自带的以客户端为准),
 * 并按规范同步 MCP-Protocol-Version / Mcp-Method / Mcp-Name 头,这样
 * 还没实现新头的旧客户端也能连上现代服务端。
 */

import { createInterface } from 'node:readline';

const BASE = (process.env.COMPOSEOPS_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.COMPOSEOPS_TOKEN || '';
const PROTOCOL_VERSION = process.env.COMPOSEOPS_MCP_VERSION || '2026-07-28';
const META_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';

if (!BASE || !TOKEN) {
  console.error('[composeops-bridge] 缺少环境变量:COMPOSEOPS_URL 与 COMPOSEOPS_TOKEN 必须同时提供');
  process.exit(1);
}

/** 按 2026-07-28 规范补齐请求元数据(已声明的字段不覆盖)。 */
function withRequestMeta(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  if (!message.method || String(message.method).startsWith('notifications/')) return message;
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? { ...message.params } : {};
  const meta = params._meta && typeof params._meta === 'object' ? { ...params._meta } : {};
  if (!meta[META_VERSION_KEY]) meta[META_VERSION_KEY] = PROTOCOL_VERSION;
  params._meta = meta;
  return { ...message, params };
}

/** 规范要求的标准头:与请求体保持一致,避免 -32020 HeaderMismatch。 */
function requestHeaders(message, body) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
    'MCP-Protocol-Version': message?.params?._meta?.[META_VERSION_KEY] || PROTOCOL_VERSION,
  };
  if (message?.method) headers['Mcp-Method'] = String(message.method);
  const name = message?.params?.name;
  if (name !== undefined && name !== null && String(name)) headers['Mcp-Name'] = String(name);
  return { headers, body };
}

const rl = createInterface({ input: process.stdin });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    console.error('[composeops-bridge] 忽略非 JSON 行');
    continue;
  }
  try {
    const prepared = withRequestMeta(message);
    const { headers, body } = requestHeaders(prepared, JSON.stringify(prepared));
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body });
    if (res.status === 202) continue; // 通知:无响应体
    const text = await res.text();
    if (!res.ok) {
      if (message?.id !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `HTTP ${res.status}: ${text.slice(0, 300)}` } })}\n`);
      }
      continue;
    }
    const data = JSON.parse(text);
    if (message?.id !== undefined) process.stdout.write(`${JSON.stringify(data)}\n`);
  } catch (error) {
    if (message?.id !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `桥接失败:${error.message}` } })}\n`);
    }
  }
}
