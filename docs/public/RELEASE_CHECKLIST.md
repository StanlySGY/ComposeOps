# Release Checklist

每次稳定版发布均重新核验；未勾选项不表示已经验证。

## 自动门禁

- [x] 版本、锁文件、CHANGELOG 与安装清单一致
- [x] 后端串行测试、前端测试与 lint 通过
- [x] 正式应用与静态预览构建通过
- [x] 预览桌面/移动浏览器交互与资源子路径通过
- [x] 镜像首次安装、认证与重启持久化通过
- [x] 从支持基线 1.4.0 升级通过
- [x] 在线 SQLite 快照恢复到新卷后可登录并读取配置
- [x] Agent 工具风险登记完整；新工具缺少风险元数据时测试应失败
- [x] Agent 持久化策略回归：deny-first、项目/工具/参数匹配、停用规则/策略组、审批编辑参数后的拒绝规则重新校验（真实 SSE 集成测试）
- [x] Agent allow 规则不得绕过 high/critical 或宏工具确认；critical 在 full 模式与“本会话记住”下仍逐次确认
- [x] Agent 审计链覆盖策略决策/原因、审批、执行成功/失败与后置检查；敏感参数不落库，执行与后置检查参数指纹关联一致（真实 SSE 集成测试）
- [x] 完整的嵌套 JSON、自由文本、Agent 执行历史/审计及 MCP/SSE 流式输出秘密脱敏回归；模型 content/reasoning 跨 chunk 与 EOF 截断均验证静态 token、Bearer、已收割密钥不泄露
- [x] SSH 主机指纹接受正确值并拒绝错误值的本地隔离测试通过
- [x] 通知 5xx/网络故障有界重试与 4xx 不重试测试通过
- [x] Agent SSE 慢客户端背压限制与取消清理测试通过
- [x] SQLite 静态加密迁移、错误密钥拒绝、加密备份恢复与密钥轮换测试通过
- [x] Redis/PostgreSQL 真实隔离容器健康探测、停止/恢复与数据持久化验收通过
- [x] 本机真实 HTTP Webhook 接收 JSON 并验证 503 重试通过
- [x] 隔离 Docker 命名卷备份/还原与 SHA-256 内容核验通过
- [ ] amd64/arm64 镜像发布成功后创建 GitHub Release
- [ ] 在 amd64 与 arm64 上分别完成原生 SQLite 依赖构建、镜像启动和数据库加密读写/恢复冒烟；单架构 CI 成功不能替代双架构验收

以上由 Quality checks / Release 执行，以对应 Actions run 为证据。

## 人工复核

- [ ] 文档链接、安装命令和备份恢复步骤
- [ ] 提交中无真实凭据或用户数据库
- [ ] 桌面和手机视觉复核
- [ ] 使用已认证管理员 Session 完成生产环境核心 UI 操作链路（服务管理、Compose 编辑/校验/保存、环境变量备份/恢复、AI 渠道设置与探针、Agent 审批）；静态预览不替代此项
- [ ] GitHub Pages 公网可访问，明确标注示例数据

## 尚需扩展的验证

- [ ] Redis/PostgreSQL 的外部模型驱动根因分析与经用户审批的真实修复闭环（需要模型渠道）
- [ ] SSH/TLS 多节点真实部署故障矩阵、真实证书轮换与 WAN 断线恢复
- [ ] 通知渠道真实送达（需要第三方渠道凭据/测试端点）
- [x] 数小时级运行的内存/CPU/文件描述符 soak test（2026-10-21 四小时隔离压测通过；报告保存在本机受限权限目录）
- [ ] 生产密钥托管、异地加密备份恢复演练与灾难恢复耗时验收（`npm run recovery:drill` 已通过本机快照测试；另一主机/KMS/异地恢复仍未验收）

本地假服务测试不等于第三方服务送达或生产环境验收；静态预览和本地镜像冒烟测试同样不能替代上述项目。

## 2026-11-04 GitOps 与代理安全专项

- [x] 隔离 HTTP Git 仓库真实克隆、无变化重复同步、远端新增提交同步、提交历史读取与无效分支失败保护通过；测试使用本地 loopback Git 服务和临时目录，不接触业务仓库。
- [x] 同仓库同步/回滚/修改/删除互斥返回 409；同步过程并行新增的其他仓库配置不会被旧状态快照覆盖。
- [x] GitOps URL 用户名/密码、查询串和片段凭据拦截回归通过。
- [x] 默认关闭 Fastify 代理头信任；伪造的 `X-Forwarded-Host` 不能绕过 Origin 校验，未受信任的 `X-Forwarded-Proto` 不能影响 Secure Cookie；显式信任代理后 HTTPS Cookie 正确设置与清除。
- [x] 隔离 API 并发测试：32 并发、640 请求、0 失败；P50 11.63 ms / P95 40.05 ms / P99 96.07 ms，进程 RSS 增量约 21.25 MiB。测试只使用独立 Fastify 实例和临时 SQLite 数据库。
- [x] 本轮后端测试 469 通过、1 跳过、0 失败；前端 65 个测试文件 / 393 项通过；Lint、正式前端构建和静态预览构建通过。
- [x] 已用本机 WSL Browser Harness 登录态完成 GitOps 页面空态、添加仓库、公共仓库真实克隆、首次同步基线提示、切换远端分支后的新提交提示、提交历史查看与删除确认；测试配置及容器 `/tmp` 工作区均已清理。
- [x] Agent 真实 SSE 安全回归：审批编辑后的参数再次命中持久化 deny 时工具不执行；成功/失败执行均记录 postcondition；失败原因写入审计且 token 形态凭据被脱敏。
- [x] 公共 Agent SSE 事件对工具错误、完成消息和嵌套结果执行 token/已收割秘密值脱敏；MCP text 与 structuredContent 均验证静态 token 和敏感键不泄露。
- [x] 原始模型 content/reasoning 流使用有状态尾片段暂存与值级脱敏；真实 SSE 集成测试覆盖跨 chunk 的静态 token、Bearer、已收割密钥、成功 EOF 截断及中文/空格/换行保真。

## 2026-11-04 GitHub CI 证据

- GitHub Actions `41755524753`（提交 `c08e614`）全部 3 个 Job 成功：代码质量/测试/构建及桌面和移动预览浏览器检查；amd64 镜像首次安装、认证、重启持久化、1.4.0 升级和新卷在线数据库恢复；ARM64 镜像构建、首次启动和备份恢复。详见 [CI run](https://github.com/StanlySGY/ComposeOps/actions/runs/41755524753)。
- 新鲜安装镜像门禁同时执行隔离 Redis/PostgreSQL Agent 健康探测、停止/恢复及数据持久化集成，以及命名卷备份/还原和两个文件的 SHA-256 核验；本机回环 HTTP Webhook 503 重试由 `backend/test/notifications.test.js` 覆盖。
- ARM64 门禁使用 GitHub Actions QEMU/Buildx 模拟构建和运行，不等同于原生 ARM64 硬件验收；因此“双架构原生 SQLite 加密构建/读写/恢复”仍未勾选。

## 2026-10-21 验收进展与剩余阻塞

- 已通过用户提供的 Demo 密码登录本机 UI。实际浏览器验收已覆盖：总览数据呈现；Compose 项目/文件选择；代码与可视化模式切换；语义校验入口可点击；选择 composeops 项目中的 opsdash 容器后，实时日志连接成功并显示 JSON 日志，随后主动断开。
- 已从 AI 助手发送只读项目状态请求，界面触发 project.list_managed 工具调用，默认渠道显示为 qwen3.8-flash-next-iq3_xxs。本轮没有把它当作上游模型完整验收通过：最终回答内容和错误/超时状态仍需进一步确认。完整核心 UI 检查清单保持未勾选，直到服务管理、Compose 保存/备份恢复、AI 渠道探针与 Agent 审批链路完成。
- 先前对本机 zai-openai 与 axonhub 的无凭据 /v1/models 探测返回 HTTP 401 Invalid API key；这仅说明探测没有有效授权，不足以证明上游不可用。需在 UI 中使用已获授权的测试 channel 做真实探针，不要把密钥写入文档或聊天。
- 当前无可用真实 SSH/TLS 测试节点；在登记非生产节点前，远程故障矩阵保持未勾选。数据库密钥仍仅存本机；异地/另一主机恢复保持未勾选。
## 2026-11-05 仓库维护审计

- [x] 当前主分支 `main` 提交 `2d1b9aa4050a3e696f00d3c8ff64f14e562184cf` 的 CI 全部 3 个 Job 成功：[run 41840504764](https://github.com/StanlySGY/ComposeOps/actions/runs/41840504764)。包括代码质量/测试/构建与 Playwright 预览、amd64 镜像安装/升级/恢复、ARM64 QEMU 安装/恢复。
- [x] 同一提交的 Pages 预览工作流成功：[run 41841947965](https://github.com/StanlySGY/ComposeOps/actions/runs/41841947965)。
- [ ] 六个 Dependabot PR（#18、#19、#20、#21、#23、#32）均须同步最新 main 并重新取得 CI 证据；旧分支 CI 不作为合并依据。依赖安装失败的 PR 必须更新根目录 `package-lock.json`，不得生成子目录 lockfile。详见 [维护审计记录](audits/2026-11-05-maintenance-audit.md)。
- [ ] 原生 ARM64 硬件验收仍未完成；上面的 ARM64 CI 使用 QEMU/Buildx，不替代真机验收。
- 本次只核对仓库与 GitHub 记录，没有执行生产环境操作；生产 UI、真实模型/通知、SSH/TLS 远程节点、独立密钥托管和异地恢复仍按本清单其他未勾选项管理。

## 2026-11-05 本地依赖维护回归（非远端 CI）

- [x] 根目录 npm ci 干净安装通过，且仅维护根 package-lock.json。
- [x] Vite 8.3.5 正式构建与静态预览构建通过。
- [x] 后端 489 pass / 1 skip；前端 420 pass；Playwright 桌面/移动预览 E2E 35 pass / 3 skip。
- [x] Playwright 1.64.1 对应 Chromium 已安装并完成预览 E2E；这不替代 GitHub Actions 新 CI。
- [x] Monaco 0.52.2 与 monaco-yaml 去重为单一实例；真实编辑器预览链路通过。Monaco 0.57 的 Worker RPC 不兼容已被实测，PR #23 暂缓。
- [ ] 将本地维护分支提交并推送；同步 Dependabot #18/#19/#20/#21/#32 后取得新 CI 结果。#23 需单独解决 Worker 兼容性，不应与其他 PR 一起合并。

上述为本地工作区验证，不代表代码已推送、GitHub PR 已更新或生产环境已部署。
