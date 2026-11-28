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

import { runBridge } from './stdio-transport.mjs';

const baseUrl = process.env.COMPOSEOPS_URL || '';
const token = process.env.COMPOSEOPS_TOKEN || '';
const protocolVersion = process.env.COMPOSEOPS_MCP_VERSION || '2026-07-28';
const timeoutMs = Number(process.env.COMPOSEOPS_MCP_TIMEOUT_MS || 120000);

try {
  await runBridge({ baseUrl, token, protocolVersion, timeoutMs });
  // Reaching here means the client closed the channel or requested shutdown.
  // Node's special stdout pipe can keep a blocked write alive after destroy();
  // there is no remaining response to flush to a disconnected client.
  process.exit(0);
} catch {
  // Transport failures may include credential-bearing URLs or upstream bodies.
  console.error('[composeops-bridge] 接入配置或通道无效，请检查 URL、Token 和超时设置');
  process.exitCode = 1;
}
