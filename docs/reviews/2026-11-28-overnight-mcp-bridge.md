# 夜间改进：MCP stdio 桥接边界

日期：2026-11-28，Asia/Shanghai。生产仍运行 c40fb287916d45a6376df1d8369941a4e6e29d92；本批只提交与推送，不打断正在进行的 24 小时观测。

## 发现与修复

旧桥接在 readline 循环中串行等待无期限 HTTP 请求，取消通知必须排在挂起请求之后，输入行与响应正文都没有大小界限。错误响应体会回显原始代理文本，中文资源 URI 没有正确映射到 Mcp-Name。

初始 9 项子进程黑盒回归中 8 项失败。新增有界传输模块后全部通过；再补充生命周期测试，复现关闭 stdin 后继续等待、stdout 阻塞时无法及时退出、非法 _meta 类型转发三个问题，并修复。客户端退出会终止本地传输并丢弃排队操作，不声称撤销已经送达服务端的副作用。

最终保留串行执行顺序，取消不再受排队阻塞；支持请求总期限、32 项队列、256 KiB 输入和 2 MiB 响应限额、版本头及 URI 编码、响应身份校验、错误页面抑制和重定向拒绝。不自动重放任何请求。版本协商仅透传固定错误与校验后的日期列表，避免将任意 HTTP 错误正文交给模型。

## 官方资料

实时核对 MCP 官方 latest 指向 2026-07-28，项目已经使用该版本，因此无需为了“最新”重复迁移协议或引入新依赖。资料保存在仓库外 overnight-20261128 证据目录。

- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation.md

采用请求超时、取消通知、Mcp-Name 编码和干净 stdout 等与现有架构直接相关的约定。本桥只支持 ComposeOps 的 JSON HTTP 通道，不将关闭本地 HTTP 连接等同于服务端 Docker 任务取消。

## 验证

- 实际启动桥接子进程，对本地合成 HTTP 服务进行 25 项测试：超时、挂起正文、取消及迟到响应、串行顺序、队列饱和、重复 ID、UTF-8 分片、超大消息、非法响应、重定向、HTTP 错误与协议协商、stdin/stdout 关闭、阻塞输出时 SIGTERM、参数校验。
- 连同既有 MCP 服务端集成测试，共 **47 通过，0 失败**。
- 后端 lint、桥接模块单独 ESLint、Node 语法检查、git diff --check 通过。
- 排队超时测试最初没有保证排队项实际过期，出现一次失败；改用阻塞首个响应到超过排队期限，明确控制该前提后通过。保留原日志，没有放宽断言。
- 本批没有改 UI，无需浏览器验收；没有改后端业务执行器，未重复执行刚通过的全量后端套件。

证据：`~/.local/state/composeops/overnight-20261128/bridge-before.log`、`bridge-lifecycle-before.log`、`bridge-lifecycle-after.log`、`bridge-shutdown.log`、`bridge-mcp-final.log`、`bridge-mcp-final-2.log`、`bridge-mcp-final-3.log`、`bridge-lint.log`。日志中的失败保留用于还原问题。
