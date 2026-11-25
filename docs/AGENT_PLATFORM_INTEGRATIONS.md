# Agent 平台能力增强

## 本轮实现

- **页面上下文自动定位**：服务页为展开的唯一项目卡片、唯一展开的服务组和单容器暴露稳定 data attributes；页面快照只采集唯一上下文，服务端再对 project/container ID 做扫描核验。显式提到其他项目/服务时优先按用户原话解析。页面内容使用不可信定界块注入。

- **意图工具发现**：规划师/执行者只收到与本轮意图匹配的工具子集；角色白名单、服务端权限、持久化策略、风险评估和人工审批仍在执行端再次校验。
- **Browser Agent（Microsoft Playwright MCP）**：web.open 与 web.interact 通过官方 Playwright MCP 的 Streamable HTTP 传输接入独立 playwright sidecar；不再维护自制 browser/server.py，也不复用 BettaFish 镜像。每次工具调用建立新的 MCP 会话并使用 --isolated 临时浏览器上下文；ComposeOps 不向模型暴露通用 MCP 工具目录，只提供受限网页操作，拒绝提交按钮/表单按钮、跨站链接、凭据字段与任意模型脚本；交互继续经过原有确认门与审计。截图上限 120 KB。
- **AG-UI 事件适配**：POST /api/v1/ai/agent/execute-stream 默认通过 AG-UI 1.0 输出命名 SSE 事件，覆盖 Run、Text Message、Tool Call/Args/Result、Step、Activity、Error/Finished 和 Custom 生命周期；前端将标准事件安全映射回现有聊天状态机，native 协议仍可显式兼容。
- **受信结构化 UI / A2UI**：新增 ui.present，通过固定组件目录渲染 notice/status/metrics/table/steps；AG-UI CUSTOM 同时携带 A2UI v1.0 createSurface Basic Catalog 消息。只允许 Column/Card/Text 组件树，不接受 HTML、CSS、JavaScript 或任意组件名，文本和值先脱敏、限长。
- **OpenTelemetry GenAI trace**：Agent 调用、LLM chat、工具策略判定、审批等待、工具执行和后置验证生成 OTLP/HTTP JSON spans。仅记录模型名、角色、工具名、风险等级、策略决策、审批结果、耗时、token 用量和状态；不记录提示词、回复正文、工具参数、日志或凭据。

## OpenTelemetry 配置

默认关闭，不配置 endpoint 时不会发起网络请求。可在部署环境设置：

- OTEL_EXPORTER_OTLP_ENDPOINT：Collector OTLP/HTTP 基础地址（自动追加 /v1/traces）。
- OTEL_EXPORTER_OTLP_TRACES_ENDPOINT：可选，直接指定 traces endpoint，优先级更高。
- OTEL_EXPORTER_OTLP_HEADERS：可选，逗号分隔的 HTTP headers。
- OTEL_SERVICE_NAME：服务名，默认 composeops。

导出是 best-effort，超时/Collector 不可用不会阻断 Agent 任务。只导出 trace，不导出 prompt、completion 或原始工具参数。

## 协议边界与后续

- AG-UI 1.0 作为 Agent 聊天的默认传输层，原生 SSE 仍可通过 `protocol: native` 兼容；已覆盖 Run、Text Message、Tool Call、Tool Result、Step、Activity、Custom 生命周期事件，并将审批、会话元数据和执行状态作为 ComposeOps 自定义事件传输。
- A2UI v1.0 `createSurface` 消息通过 AG-UI `CUSTOM` 事件输出，使用官方 Basic Catalog 的 `Column`、`Card`、`Text` 白名单；现有前端继续使用已校验的 ComposeOps 结构化组件渲染，不接受模型提供的组件名、HTML 或脚本。尚未实现 A2UI 双向 action/function RPC 与完整双向 data-model 同步。
- Browser Agent 使用 Microsoft Playwright MCP 官方容器；仅在 Compose 内部网络暴露 Streamable HTTP MCP 端点，不挂载 Docker Socket 或宿主机目录。每次调用使用临时隔离上下文，不提供持久 profile、账号登录、下载文件或任意 Playwright 代码执行。截图只发送给已登录面板渲染，不回灌模型上下文。目标 URL 在导航前做 DNS/IP 检查；Playwright MCP 的 blocked-origins 是纵深防护，不是完整网络安全边界，不能替代网络出口隔离。
- **任务恢复边界**：执行中的任务/节点在进程重启或心跳超时后标记为 `outcome_unknown`，不会自动重放；尚未开始的 queued 任务标记为 `failed` 并提示重新发起，避免队列永久挂起。对未知结果的 Docker 副作用必须先核对真实状态，再由用户决定是否重新执行。
