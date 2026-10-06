# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- GitHub Pages 预览改为复用正式应用的 App、路由、页面与样式，以离线示例适配器提供数据；移除独立宣传页式控制台。
- 增加真实页面、AI 审批、渠道独立保存与网络隔离的桌面/移动端回归验证。

### Fixed
- 配置页随条件渲染的编辑器容器创建/销毁 Monaco，修复带项目参数直达页面与代码/可视化来回切换后的空白编辑器。

## [1.5.1] - 2026-10-06

### Added
- 拓扑中心与资产中心知识图谱升级为双模式关系图：分层架构按依赖深度排列，自由拓扑为力导向气泡，支持拖拽、缩放平移、悬停高亮上下游链路与依赖流向动画。
- 跨域嵌入开关 EMBED_MODE：放宽 CSP 与会话 Cookie 策略用于 iframe/Cloud Run 场景，默认保持严格安全姿态。

### Changed
- 全站界面按 iOS 风格打磨：胶囊分段控制器、毛玻璃浮层材质、按压弹簧手感、连续圆角（支持的浏览器）。
- SQLite 存储迁移到 Node 22 内置 node:sqlite，移除 better-sqlite3 原生依赖，镜像构建不再需要编译器。
- 仓库切换为 npm workspaces，根 lockfile 统一管理依赖。

## [1.5.0] - 2026-10-01

### Added
- 多个 OpenAI 兼容渠道、按优先级故障切换与冷却恢复；每渠道独立保存，管理员可按需查看已保存密钥。
- 工具调用测试区分基础工具能力与流式兼容性，支持关闭流式工具调用以适配部分上游。
- GitHub Pages 离线交互预览：服务、日志、审批修复与备份演练；示例数据不连接 Docker 或 AI。
- SQLite 在线备份与完整性校验 CLI，包含 WAL 数据，拒绝覆盖已有备份；补充停止服务后的恢复操作说明。
- 发布质量门：单测、lint、构建、桌面/移动浏览器测试，以及隔离镜像首次安装、1.4.0 升级与备份恢复验收。

### Changed
- 入门指南支持重新打开，区分已发现与已纳管项目，明确 AI 可选；导航分组可折叠并记住偏好。
- 镜像成功发布后再创建 GitHub Release；提供固定版本的纯镜像安装清单。
- 收敛文档中的竞品比较、无中断升级与备份保证，明确实际验证边界。
- 更新存在公开漏洞的传递依赖。

## [1.4.0] - 2026-09-30

### Added
- **Agent 输出侧护栏**: LLM 生成的命令进入容器执行前做灾难模式静态拦截(rm -rf /、mkfs、fork 炸弹、curl|sh 等);AI 端点挂进程内限流(execute-stream/approve/logs/diagnose 宽配额固定窗口),防失控循环刷爆上游
- **联网检索多后端**: 内置 GitHub+DuckDuckGo 之外支持 Tavily / Brave / 自托管 SearXNG,失败自动回退内置;设置页新增检索配置区
- **运行环境快照注入**: 引擎系统提示注入活跃主机与纳管项目状态(10s 缓存,只读事实),模型开局即知现状,不必每轮先 list
- **告警规则库统一**: alert.configure 与 /metrics/alerts 曾写独立存储而评估引擎只读另一份,规则永不生效;收敛到单一模块,指标口径对齐,旧 restart 动作归一化 auto_restart
- **Agent 工具扩容**: 新增 volume.backup/restore/verify/list_backups(restore 为 critical 永远走确认门)与 event.list/update/diagnose(可读事件流、触发守护诊断、事件中心一键生成修复计划)
- **长会话自动压缩**: 活跃区超阈值(默认 60 轮消息)自动压缩并向前端发提示,也可在工作台手动压缩;token 用量跨轮累计并带轮数
- **Agent 可观测性**: 执行历史页展示 30 天 token 用量/模型用量分布/每轮工具轨迹,新增用量与反馈接口、受限 SKILL.md 加载器与离线工具轨迹评测
- **关于页**: 带版本号、作者与项目仓库链接
- **MCP 端点限流**: /mcp 120/min、SSE 建立 10/min,置于鉴权前防 token 穷举

### Changed
- **链路稳定性专项**: 日志流分片与行解码、Web 终端连接、多节点切换竞态、仪表盘/监控页自动刷新、命令面板搜索、工作流响应性与请求缓存整体重构,补一轮流/生命周期回归测试
- cron.create 枚举补齐 volume-backup/inspection,对齐调度器 7 类

### Fixed
- **卷备份在 dockerode 5 下必然失败**: helper 容器日志在 follow:false 时返回 Buffer 而非流,.pipe 直接报错"备份自证"不可用;改经 collectDockerOutput 统一兼容,顺带修复超限清理的错误吞没
- **工具参数解析失败污染会话历史**: 模型吐出非法 JSON 参数时坏参数原样留在 tool_calls 历史,部分上游校验后整请求 400,Tool Loop 后续每轮都死在同一处;现在落历史前归位为 '{}' 并提示模型重试
- release notes 提取改用字面量状态机,根治 awk 区间起止同线恒空
- 快照缓存读写收进同步助手,消除 require-atomic-updates 告警

## [1.3.1] - 2026-09-28

### Fixed
- **拓扑页节点被裁切**: 依赖关系图的层内节点以固定 y=60 为中心展开,同层节点较多时
  顶部节点纵坐标变负,整体被 SVG viewBox 上沿裁掉——用户看到"节点被面板盖住",
  7 个服务只显示 5 个。现在每层以画布垂直中点居中展开,画布高度按层内最多节点数
  实算(计入节点自身高度与上下边距),任何层数的首尾节点都完整可见
- 布局计算抽为纯函数 `lib/topology-layout.js` 并补 7 例单测(含用户实测的
  1 依赖 4 共 7 节点场景、12 节点单层、环依赖、单节点不放大画布)

## [1.3.0] - 2026-09-28

### Added
- **守护模式(半自动自愈)**: 告警入库后自动触发 AI 诊断(读容器状态/日志 → 根因假设 + 风险标注的处置建议),结果落事件中心;事件级 10 分钟冷却,AI 侧只读 fail-closed
- **部署预言**: `up` 之前对照宿主实况推演——新建/重建/不动/孤儿容器、需拉取镜像、端口冲突、卷与 bind 路径就绪度 + AI 三句话解读
- **备份自证(还原演练)**: 卷备份 tar 全量完整性校验 + 解进一次性临时卷统计文件数,备份可信度随记录持久化,全程不碰原卷
- **舰队视图**: 节点组页新增多宿主聚合总览卡、全节点并行探测与真实批量动作(巡检/全局镜像检查)
- **通知渠道补齐**: 钉钉、飞书 webhook(与 bark/telegram/企业微信/email/通用 webhook 同一多渠道架构)
- **MCP Server(三传输)**: 把 50 个 Agent 工具暴露给外部 MCP 客户端——Streamable HTTP(`POST /mcp`)、经典 SSE(`/mcp/sse`)、stdio 桥(`mcp/stdio-bridge.mjs`);独立 token 鉴权,默认只读白名单,critical 工具任何模式不暴露
- **MCP 双时代协议(2026-07-28)**: modern 按每请求 `_meta` 协商版本、实现强制的 `server/discover`、不支持的版本回 `-32022`、头↔体一致性校验(`-32020`)、工具注解(`readOnlyHint`/`destructiveHint`)与 `structuredContent`;legacy `initialize` 握手 2024-11-05 → 2025-11-25 全线支持
- **MCP 确认门与防泄漏**: 高危工具必须显式 `confirm: true` 才执行;工具结果先值级脱敏再截断(24K 保留首尾);旧式客户端的下划线工具名别名兼容
- **PWA 手机远控**: manifest(standalone + 桌面快捷方式)、PWA 192/512/maskable 图标、iOS meta;手机"添加到主屏幕"即全屏 App 化
- **审批模式接入工作台**: 逐次确认 / 放行非高危 / 仅极高危确认三档模式此前是后端孤岛,现工作台页头可直接切换并以 `approval_mode` 事件同步
- **镜像手动发布工作流**: Actions 手动触发产出 `edge` + `sha-<7位>` 标签,不动 `latest`(版本可追)

### Changed
- **依赖全量升级到当代版本**: 后端 fastify 4→5、@fastify/static 7→10、@fastify/websocket 10→11、better-sqlite3 11→13、dockerode 4→5、nodemailer 7→10、tar-stream 2→3;前端 vite 5→7、vitest 3→5、pinia 2→4、vue-router 4→5、@xterm/xterm 5→6、lucide-vue-next 0.468→1.0
- **Tailwind CSS 3→4**: 配置迁入 CSS-first `@theme`(surface 色阶/状态光晕/字体保留),scoped style 的 `@apply` 上下文补 `@reference`
- CI actions 升级(checkout@v5 / setup-node@v5 / build-push-action@v7 / setup-qemu@v4 / action-gh-release@v3),消除 Node 20 弃用警告
- monaco-editor 刻意保持在 0.52(0.57 改了 exports 结构,编辑器为核心编辑面,待专项验证后单独升级)

### Fixed
- **平滑升级回滚失效**: `rollbackProject` 引用列表查询中不存在的 `content` 列,写入 `undefined` 被空 catch 吞掉,回滚恒 409;改经 `getComposeBackup` 取正文
- **审批门"本会话不再询问"可越过 critical**: 记忆授权集合命中即放行,现在 critical 风险先于授权集合判定,任何模式都强制确认;匿名流使用独立 gateKey 防授权泄漏
- **设置导出泄露 SSH 私钥/密码**: `docker.hosts` 整键排除出导出文件(脱敏导出再导入反而会用无凭据条目覆盖真实凭据)
- **非数字会话 id 撞库**: 路由允许字符串 `sessionId`,`Number('abc')` 为 NaN 被 better-sqlite3 绑成 NULL,抛 `NOT NULL constraint failed: agent_plans.session_id`;现在统一归一到匿名会话 0
- **达到 20 轮上限前端无感知**: `max_loops_reached` 事件此前被公共事件层丢弃,前端只见流关闭;现在明确提示并可"继续"接续
- 数据库迁移扩展至 v15(备份演练字段 / 告警 AI 诊断)

## [1.2.2] - 2026-09-18

### Changed
- **Docker Hub 镜像名更正为 `stanly1997/opsdash`**: 此前 `composeops` 命名空间不属于作者账号,
  导致 release 工作流 push 一直 `insufficient_scope` 失败;同步更新 docker-compose.yml、
  release.yml、README(中英)、CONTRIBUTING、架构文档中的全部引用

## [1.2.1] - 2026-09-18

### Fixed
- **任意未知静态路径返回 500**: `@fastify/static` 以 `decorateReply: false` 注册,
  导致 SPA fallback 里的 `reply.sendFile('index.html')` 永远抛
  `TypeError: reply.sendFile is not a function`(浏览器每次自动请求 `/favicon.ico` 都会触发)。
  现恢复默认装饰使 fallback 正常工作,未知路径返回 SPA 入口
- **新增 favicon**: 之前页面没有图标声明,浏览器默认请求 `/favicon.ico` 必然 404;
  现添加 `favicon.svg` 并在 `index.html` 声明

## [1.2.0] - 2026-09-18

### Added
- **统一资产模型 (CMDB)**: Host/Project/Container/Volume/Network 收敛为统一 `assets` 实体
  - 资产同步从 Docker 扫描重建,支持 `asset_relations` 依赖关系与拓扑查询
  - 新增 `/cmdb/*` API 与「资产中心」页面(`/cmdb`),作为知识图谱与事件中心的单一事实来源
- **统一事件中心 (Event Center 2.0)**: 告警/巡检/部署/回滚/Agent/GitOps/工作流全部收敛为 `event_records`
  - 新增 `/events/*` API 与「事件中心」页面(`/events`),支持按类型/级别/状态过滤与状态流转
  - 事件统计聚合,作为时间线的单一事实来源
- **工作流引擎 (Workflow Engine)**: 轻量编排引擎,节点类型 trigger/condition/agent/approval/action/verify
  - 新增 `/workflows/*` API 与「工作流中心」页面(`/workflows`)
  - 支持手动/定时/事件触发,approval 节点进入等待审批,Agent 作为工作流节点实现编排解耦
- **知识图谱升级**: 支持切换「实时数据 / 资产中心数据」两种数据源,直接读取 CMDB 统一资产模型
- **工作流 Agent 节点真正接入 Agent 引擎**: `agent` 节点调用真实 Tool Loop 引擎(validator 只读角色)做诊断分析,
  `action` 节点执行真实 Compose 项目操作(up/stop/restart/pull),`verify` 节点只读验证项目状态
  - 失败节点自动标记 failed 并终止工作流,不再停留在 running

### Changed
- 数据库迁移扩展至 v9(统一资产模型 / 事件中心 / 工作流引擎)
- 侧边栏新增「资产中心」「事件中心」「工作流」入口

### Fixed
- **首次运行(空巡检数据)时服务总览页崩溃**: `ServicesView` 模板在 `inspection` 为 null 时直接读取 `.latest`,触发全局错误横幅;现改为可选链守卫,并在错误边界输出堆栈便于排查
- Agent streaming corruption from per-chunk text sanitization (protocol stripping now stateful at the emission layer with prefix hold-back)
- Missing `stripAgentProtocol` import crashing the page-agent drawer on first token
- Flaky backend tests caused by concurrent SQLite access (tests now serialized)
- **国内网络下 `docker compose up -d --build` 必然失败**: 原 Dockerfile 依赖 `deb.debian.org`
  (12MB 的 `Packages.gz` 在国内常超时)与 `download.docker.com` 的 GPG key。现改为
  apt 默认走清华镜像(`ARG APT_MIRROR`,传空可回官方源)、`better-sqlite3` 优先走
  npmmirror 预编译产物(无需 python3/make/g++,整条 apt 分支可跳过)、
  docker CLI 与 compose 插件直接从官方 `docker:cli` 镜像 COPY 进来
  (不再访问 `download.docker.com`),并在构建期断言 `docker / docker compose / git / ssh` 全部可用
- **镜像里缺失 `git` / `ssh`**: `backend/src/services/gitops.js` 通过 `execFileSync('git', ...)`
  执行 clone/pull,容器内 GitOps 此前直接 ENOENT。runtime 阶段改装
  `ca-certificates curl gnupg git openssh-client`(体积远小于原来的 docker-ce-cli)

## [1.0.0] - 2026-09-04

### Added
- **Core Features**
  - Automatic Docker Compose project discovery via container labels
  - Project grouping by `myops.owner` label with favorites and notes
  - Real-time container logs with search, filtering, and ERROR/WARN highlighting
  - Multi-file Compose editor with YAML formatting and validation
  - **Visual Compose Editor**: Dual-mode editing (code/visual) for docker-compose files with service card view and form-based editing
  - Automatic backup (last 20 revisions) with line-by-line diff and restore
  - Change preview showing containers to be recreated/restarted before save
  - Web shell (sh/bash only) scoped to managed project containers
  - Container CPU, memory, network, and Docker storage metrics
  - Trend charts with localStorage persistence and alert threshold lines
  - Event center with alert prioritization, read/unread states, and muting
  - Operations history tracking with audit trail export
  - **InteractiveChart Component**: Multi-metric comparison with export functionality (Phase 2 completed)

- **AI Features**
  - AI diagnosis assistant with automatic context (Compose config + 200 lines logs)
  - Container read-only probe and internet search capabilities
  - Session-isolated context with conversation history
  - AI Agent workflow automation (31 tools: start/stop/scale/config/env/network/volume/security/diagnostics/alerts/scheduling/maintenance/metrics)
  - Risk-level classification with step-by-step confirmation
  - Multi-role collaboration (planner/executor/validator/incident_responder) with rollback capability
  - Real-time alert evaluation with execution history and feedback export
  - Streaming execution with live thought process display and step-by-step confirmation

- **Monitoring & Alerts**
  - Service cards with status timestamps and Compose dependency visualization
  - Environment variable preview (sensitive values masked)
  - Health score calculation on overview page
  - WebSocket real-time event push
  - Notification channels: Bark, Telegram, WeCom, SMTP email, generic webhooks
  - Alert types: container exit, memory threshold, Docker storage threshold

- **Operations**
  - Allowlisted Compose operations: up/stop/restart/pull/ps with real-time output
  - Template insertion for common services (PostgreSQL, Redis, Nginx, healthchecks)
  - Scheduled image pull with update notifications
  - Docker cleanup preview: unused images, build cache, stopped containers, volumes
  - Explicit project management: auto-discovery with manual approval required
  - Project-scoped Compose workspace containers (on-demand directory mounting)

- **Security**
  - Single admin authentication with scrypt password hashing
  - 30-day server-side sessions with HttpOnly, SameSite=Strict cookies
  - REST and WebSocket authentication enforcement
  - Origin validation for modification requests
  - Realpath and Docker-reported file manifest validation for Compose files
  - API key storage in SQLite (excluded from settings export)
  - Managed project access control (logs, shell, AI restricted to approved projects)

- **Development**
  - Backend: Node.js 22 + Fastify + Dockerode + better-sqlite3
  - Frontend: Vue 3 + Vite + Tailwind CSS + Xterm.js + Monaco Editor
  - Test suite: 59 passing tests (Vitest for frontend, Node.js test runner for backend)
  - Real-time features: SSE streaming, WebSocket
  - SWR caching pattern with 12s TTL

### Changed
- Default port binding to `0.0.0.0:28765` (was 127.0.0.1:3001 in early versions)
- Workspace container idle time configurable via `COMPOSEOPS_WORKSPACE_IDLE_MS` (default 90s)
- Maximum cached workspace containers via `COMPOSEOPS_WORKSPACE_CACHE_MAX` (default 8)

### Security
- Docker socket access equivalent to root (documented in SECURITY.md)
- Recommend localhost-only deployment with Tailscale or reverse proxy for remote access
- HTTPS/TLS enforcement via reverse proxy with `TRUST_PROXY=1` flag
- Single-user design (not suitable for multi-tenant deployments)

## [0.x.x] - Pre-release

Early development versions (not publicly released).

---

## Release Notes

### [1.0.0] - Initial Open Source Release

ComposeOps 1.0.0 is the first production-ready release, designed for personal server administrators who want a lightweight Docker Compose management panel with AI-powered automation.

**Key Highlights:**
- ⚡ **Lightweight**: 3.5MB gzipped frontend build
- 🤖 **AI-First**: Native Claude/OpenAI integration for diagnostics and workflow automation
- 🔒 **Security-Focused**: Explicit project approval, scoped operations, audit trail
- 📊 **Real-time**: SSE streaming, WebSocket push, live metrics
- 🧪 **Well-tested**: 59 tests covering core functionality

**Migration from 0.x:**
No breaking changes. Existing SQLite databases are compatible.

**Known Limitations:**
- Single-user only (no multi-tenant support)
- No built-in 2FA (use reverse proxy authentication)
- English UI via i18n not yet implemented (planned for v1.1)

**Getting Started:**
See [README.en.md](./README.en.md) for installation and [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup.

---

[Unreleased]: https://github.com/StanlySGY/ComposeOps/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/StanlySGY/ComposeOps/releases/tag/v1.2.0
[1.0.0]: https://github.com/StanlySGY/ComposeOps/releases/tag/v1.0.0
