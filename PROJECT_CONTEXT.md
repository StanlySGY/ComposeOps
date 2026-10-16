# 📌 ComposeOps - PROJECT_CONTEXT.md
> **上次更新时间**:2026-10-16 (Asia/Shanghai)
> **当前版本/阶段**:仓库 package version 1.5.1；当前基线以 package.json、CHANGELOG 与 GitHub Actions 为准。

## 1. 核心概述 (Executive Summary)
- **项目目标**:单用户 Docker Compose 运维控制台(工作区名 `ComposeOps`,镜像/容器沿用旧名 `OpsDash`)。通过 Docker Socket 自动发现带 `com.docker.compose.project` 标签的 Compose 项目,以"先发现、后显式纳管"的权限模型提供服务启停、Compose 配置编辑、环境变量文件族管理、实时日志、容器终端、数据卷备份、GitOps 同步、应用市场、定时任务、多 Docker 节点纳管、资源监控与 AI 运维 Agent 能力。
- **技术栈**:前端 Vue 3 + Vite + Pinia + Vue Router(hash) + Tailwind + Monaco + xterm + marked/DOMPurify;后端 Node.js 22、Fastify 5、Node 内置 `node:sqlite`（默认）及可选 `better-sqlite3-multiple-ciphers` 静态加密、dockerode、ssh2、tar-stream、yaml。依赖版本以 package.json/lockfile 为准。
- **核心架构约定**:REST 前缀 `/api/v1`(路由按域拆分 `backend/src/routes/`);SSE 用于 Compose 操作、env 应用、Agent 执行流与指标;WebSocket(`/ws/logs`、`/ws/exec`、`/ws/jobs`、`/ws/aggregated-logs`、`/ws/events`);前端 `views / components / stores / composables / lib / api`;弹层 `useEscapeKey` 栈 + z-index 阶梯(modal > drawer > event > command);路由层 keep-alive 白名单(流式/轮询页排除)+ 空闲 chunk 预取 + page-fade 过渡。
- **AI 架构**:单页 Agent(`/agent`,原 `/ai` 已 301)。执行通道唯一:`POST /ai/agent/execute-stream`(Tool Loop,SSE)+ `/ai/agent/approve` 确认门;`/ai/diagnose` 保留给日志页诊断弹窗;`/ai/chat`、`/ai/exec` 已删除。协议剥离只在 `ai.js` 发射层(全量有状态 + 前缀持回),前端 token 原样追加(120ms 节流);聊天逻辑共享于 `useAgentChat.js`(滚动跟随/atBottom、工具轨迹、富内容放大浮层);富渲染 `agent-markdown.js`(marked + DOMPurify 白名单,svg/table 富内容代码块启发式渲染 + 源码折叠 + 放大包裹)。
- **字节一致副本**:`backend/src/lib/dotenv.js` ⇄ `frontend/src/lib/dotenv.js`;`backend/src/lib/agent-protocol-core.js` ⇄ `frontend/src/lib/agent-protocol-core.js`(两侧 sync 测试兜底)。

## 2. 当前状态快照 (Current Status)
- **已交付的完整能力面**(细节见 README.md 与 CHANGELOG.md):
  - 项目纳管/挂载模型、多宿主(Local/TCP/SSH)、Compose 多文件编辑(Monaco + 语义校验 + 变更预览 + 20 份备份/回滚)、env 文件族(`GET /projects/:id/env/files`,`*.env`/`.env.example`)。
  - AI 运维 Agent:工具注册表(按域拆 `services/tools/`)、动态风险与确认门(10 分钟兜底)、持久化策略组/规则（迁移 v17，deny-first、按项目/工具/参数子集精确匹配）、追加式审计事件（工具执行 ID 关联策略判定、审批、执行与后置检查）、日志挂载(`attachedLogs` 不可信定界块)、长期记忆、联网检索、富渲染与放大浮层、工具轨迹、页面 Agent 抽屉。critical、宏工具及声明硬确认的工具不能被持久 allow 或会话记忆放行；规则参数禁止保存敏感字段和值。
  - 数据保护:Compose 备份(20 份/diff/回滚)、**数据卷备份**(`services/volume-backup.js` helper 容器 tar,cron 类型 `volume-backup`,目录 `backup.volume_dir`,每卷 20 份)、数据库 Dump、保留策略(`pruneAiData`,setting `retention.ai_days` 默认 90 天,metrics-collector 每日触发)。
  - GitOps(轮询 + webhook `POST /gitops/webhook/:id`,token=`gitops.webhook_token`,app.js auth 豁免)、应用市场(蓝图 + 自定义模板 + AI 找应用 `POST /marketplace/templates/ai-discover`,只出草稿)、定时任务(5 段 cron 解析,JSON 持久化)、告警通知(Bark/Telegram/企微/邮件/Webhook)、操作审计、多渠道事件中心。
  - 基础设施:登录锁定(5 次/15 分钟)、Cookie SameSite=Strict、CSP(含 img-src https)、SWR 缓存、骨架屏、日志虚拟滚动、键盘导航(j/k + `?` 帮助)、Cmd+K 命令面板。
- **验证基线（2026-10-16）**:提交 `9bd91cd` 本地全量验证：后端 431 项中 430 项通过、1 项既有预期跳过；前端 63 个测试文件、381 项通过；双端 lint、正式/预览构建通过；Playwright 预览检查 30 项通过、2 项既有预期跳过。最新提交 `0701185` 的 GitHub Actions [run 38857039469](https://github.com/StanlySGY/ComposeOps/actions/runs/38857039469) 全部成功，含常规测试、桌面/移动浏览器、amd64 安装/升级/恢复和 ARM64 安装/在线备份恢复。本轮另跑通知/SSH/TLS/多节点专项测试 18/18、真实 Docker Redis 恢复 smoke 通过；真实模型在隔离数据库和临时 Redis/PostgreSQL 项目上通过 Agent 工具循环与审批门修复演练，Redis `PONG`、PostgreSQL ready，临时资源清理通过。正式四小时 SSE soak 因本机/WSL 关机中断，没有最终报告，按未完成/不通过验收处理且不自动重跑；后续需要时改为 5–10 分钟分段压测。当前运行容器数据库状态为 plaintext，且当前环境找不到可用外置密钥/加密快照，详见 `docs/public/ROADMAP.md`。
- **2026-10-16 本轮改进已验证**：Agent 阈值告警连续采样防抖、工具失败摘要和确认卡错误反馈已通过专项/全量测试；只读数据库迁移前审计命令 `npm run recovery:audit` 已添加并经隔离测试验证。后端 437 项中 436 项通过、1 项既有跳过；前端 63 个测试文件、382 项通过；双端 Lint、正式/预览构建通过；Playwright 预览 30 项通过、2 项既有预期跳过。数据库当前实例未迁移，因真实外置密钥/备份仍未核实。
- **容器镜像**:`runtime` 阶段内置 docker CLI / compose / buildx(从官方 `docker:cli` COPY)+ git / openssh-client;
  apt 默认走 `ARG APT_MIRROR=mirrors.tuna.tsinghua.edu.cn`,npm 走 npmmirror。默认数据库适配器使用 `node:sqlite`；启用静态加密时依赖 `better-sqlite3-multiple-ciphers` 原生 addon，由构建阶段安装编译工具链。
  国内网络下 `docker compose up -d --build` 可直接跑通,构建期会断言四个二进制全部可用。

## 3. 已知取舍与候选改进 (Next Ideas)
- [x] 卷备份:远程宿主已支持 helper cat 流式下载;bind mount 仍不纳入。
- [ ] 日志挂载面板可记住上次选择。Agent 工具结果摘要与确认卡内的审批/拒绝错误反馈已通过前后端专项及全量测试验证。
- [x] 通知渠道分组:当前通知为单渠道模型(type 单选),分组的前提是多渠道并存——需先把通知升级为多渠道列表再做分组,暂缓。
- [x] Agent 阈值告警改为连续采样确认的事件状态机，持续超限只告警一次，恢复后重新武装。
- [ ] 远程节点 Compose/env 编辑经 SSH 通道(当前 403 guard)。
- [ ] 成本分析疑超前:已降权至系统组,观察使用率再定去留。
- [x] SQLite 静态加密可选启用；新安装默认仍为明文。密钥需保存在数据卷外；同主机恢复演练已做，独立 KMS/异地灾备仍待验证。

## 4. 关键操作备忘
- 后端单测必须串行:`DB_PATH=/tmp/x.db npm test`(package.json 已带 `--test-concurrency=1`),并发会多进程抢同一 DB 偶发失败。
- 前后端共享代码改动须同步两份副本并跑 sync 测试;`dotenv.js` 同理(无测试,人工对齐)。
- 真机冒烟模板:拷贝 `backend/data/opsdash.db` 副本 + scrypt 重置密码 → `ENABLE_SHELL=1 SERVE_FRONTEND=1 PORT=3101 DB_PATH=<副本> node src/index.js`。
