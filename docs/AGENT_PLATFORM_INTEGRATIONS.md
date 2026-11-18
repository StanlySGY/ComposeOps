# Agent 平台能力增强

## 本轮实现

- **页面上下文自动定位**：服务页为展开的唯一项目卡片、唯一展开的服务组和单容器暴露稳定 data attributes；页面快照只采集唯一上下文，服务端再对 project/container ID 做扫描核验。显式提到其他项目/服务时优先按用户原话解析。页面内容使用不可信定界块注入。

- **意图工具发现**：规划师/执行者只收到与本轮意图匹配的工具子集；角色白名单、服务端权限、持久化策略、风险评估和人工审批仍在执行端再次校验。
- **Browser Agent（受限模式）**：新增 web.interact，支持可访问性角色/标签定位、点击、普通字段填写、选择、勾选和快照。每次调用要求人工确认；浏览器每次使用全新隔离上下文，不保留 Cookie/登录态；拒绝提交按钮、表单内按钮、跨站链接和凭据字段，不提供任意脚本执行。
- **AG-UI 事件适配**：POST /api/v1/ai/agent/execute-stream 可通过 protocol: "ag-ui" 输出命名 SSE 事件，包括 RUN_STARTED、TEXT_MESSAGE_*、RUN_FINISHED、RUN_ERROR 和 ComposeOps CUSTOM 事件；默认 native 协议保持兼容。
- **受信结构化 UI**：新增 ui.present，通过固定组件目录渲染 notice/status/metrics/table/steps；不接受 HTML、CSS、JavaScript 或任意组件名，文本和值先脱敏、限长。
- **OpenTelemetry GenAI trace**：Agent 调用、LLM chat 轮次和工具执行生成 OTLP/HTTP JSON spans。仅记录模型名、角色、工具名、风险等级、耗时、token 用量和状态；不记录提示词、回复正文、工具参数、日志或凭据。

## OpenTelemetry 配置

默认关闭，不配置 endpoint 时不会发起网络请求。可在部署环境设置：

- OTEL_EXPORTER_OTLP_ENDPOINT：Collector OTLP/HTTP 基础地址（自动追加 /v1/traces）。
- OTEL_EXPORTER_OTLP_TRACES_ENDPOINT：可选，直接指定 traces endpoint，优先级更高。
- OTEL_EXPORTER_OTLP_HEADERS：可选，逗号分隔的 HTTP headers。
- OTEL_SERVICE_NAME：服务名，默认 composeops。

导出是 best-effort，超时/Collector 不可用不会阻断 Agent 任务。只导出 trace，不导出 prompt、completion 或原始工具参数。

## 协议边界与后续

- AG-UI 当前为兼容适配层，native SSE 仍是 ComposeOps 前端默认协议。
- 结构化 UI 是 A2UI 风格的受信组件子集，不声称实现 A2UI 1.0 全部 surface/data-model 协议；若未来需要与 A2UI 客户端互操作，再补齐标准消息 envelope 和 surface 生命周期。
- Browser Agent 目前不提供持久浏览器 profile、账号登录、下载文件或任意 Playwright 代码执行；这些能力需要单独的权限模型和安全评估。
- **任务恢复边界**：现有后台任务与工作流已持久化输出、心跳、尝试次数/幂等键和节点状态；进程重启或心跳超时后，执行中的任务/节点会被标记为 outcome_unknown，而不是自动重放。排查并确认 Docker 实际状态后再发起新任务，避免重复部署、重启或恢复。当前不提供跨进程自动续跑任意模型工具链；后续只能对具备幂等台账且已核验副作用的节点增加显式恢复。
