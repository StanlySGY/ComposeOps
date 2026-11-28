# 流式接收的身份与生命周期（2026-11-29）

## 复现与影响

任务中心的任务流直接 fetch、解析 JSON 时包住了消费者回调，消费者抛错也被当作坏帧忽略；没有 reader 清理和缓冲上限。Compose 控制流虽已有大小限制，但未绑定认证世代。部署任务轮询在两次请求之间更换身份后，会拿新 Cookie 继续读取旧任务。

新增 12 项真实 ReadableStream 回归中，旧实现 11 项失败。项目指标另新增 3 项身份测试，旧实现全部失败：退出后旧订阅重连、密码轮换仍使用旧连接、401 不通知登录失效。

## 修复

- AI、Compose 控制和任务订阅共享 `api/sse.js`，在响应头、错误体、每次 read 与逐帧派发检查身份，退出立即关闭安静连接。
- 取消或消费者异常时 cancel reader，所有出口 releaseLock；移除认证和 AbortSignal 监听。旧流不能失效新身份的缓存。
- 每个完整帧与未完成缓冲均有上限；消费者异常向调用方报告，不再假装流正常结束。逐字节 UTF-8、跨片 CRLF、CR 和多行 data 保留。
- 部署跟踪固定整段操作的身份，中断轮询等待并清理监听；不会重新 POST 部署或停止服务器持久任务。
- 项目指标身份变更时取消全部旧订阅；本人密码轮换只重建连接并保留订阅；当前 401 停止重连并通知登录失效。

官方 WHATWG SSE 规范要求 EOF 时丢弃未由空行结束的事件。Compose 控制与任务流沿用此语义；AI 原有兼容测试明确允许合法 JSON 尾帧，故只给 AI 通道启用 `acceptFinalFrame`，没有将该兼容扩散到操作成功状态。

官方资料：`https://html.spec.whatwg.org/multipage/server-sent-events.html`，当次抓取位于证据目录 `whatwg-sse.html`。搜索工具未返回内容，直接读取官方规范核对。

## 验证

- 初轮流式针对性 52 项通过，前端全量 163 文件、1281 项通过，lint 和生产构建通过。
- 补充 EOF 边界后相关 22 项通过。
- Chromium/WebKit 桌面与手机浏览器：242 项通过、6 项按设备能力跳过、0 失败。最终 EOF 与回调归属修正后，相关 43 项单测和 lint 通过，重新构建后的 16 项浏览器测试通过。

证据位于 `~/.local/state/composeops/overnight-20261128/operation-stream-auth-*`、`stats-stream-auth-*` 和 `streams-auth-*`。原始失败保留，生产未重启。
