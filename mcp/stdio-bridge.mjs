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
 */

import { createInterface } from 'node:readline';

const BASE = (process.env.COMPOSEOPS_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.COMPOSEOPS_TOKEN || '';

if (!BASE || !TOKEN) {
  console.error('[composeops-bridge] 缺少环境变量:COMPOSEOPS_URL 与 COMPOSEOPS_TOKEN 必须同时提供');
  process.exit(1);
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
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: trimmed,
    });
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
