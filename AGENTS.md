# ComposeOps 环境与操作备忘

单用户 Docker Compose 运维台(工作区名 `ComposeOps`,镜像/容器有时沿用旧名 `OpsDash`)。所有 UI 文案为中文,暗色工业风 + emerald 状态色系。

## 基本状态
- Monorepo:`frontend/`(Vue 3 + Vite 5 + Pinia + Tailwind + lucide-vue-next + monaco + xterm)与 `backend/`(Fastify + better-sqlite3 + dockerode + ssh2)。
- 前端 hash router(`/services /compose /logs /shell /ai /monitor /operations /settings`);后端 REST 前缀 `/api/v1`。
- 向量/弹层 z-index 阶梯:`z-0` 内容 → `z-40` Tab/Sidebar → `z-45` Header → `z-50` EventCenter → `z-[51]` 抽屉面板 → `z-[55]` Modal 背板 → `z-[60]` Cmd+K → `z-[70]` Toast。
- 弹层 Esc 统一由 `frontend/src/composables/useEscapeKey.js` 管理(modal > drawer > event > command,`lockBody` 计数锁滚动)。
- 端口映射 `0.0.0.0:28765:3001` 为用户明确配置,勿改。
- 敏感识别正则:`/(SECRET|TOKEN|PASSWORD|PASSWD|\bPASS\b|(?:API|PRIVATE|ACCESS|SECRET|AUTH|SIGNING)[_-]?KEY)/i`。
- 镜像必须保持字节一致:`backend/src/lib/dotenv.js` ⇄ `frontend/src/lib/dotenv.js`;`backend/src/lib/agent-protocol-core.js` ⇄ `frontend/src/lib/agent-protocol-core.js`(改一处就同步另一处,两侧 sync 测试会比对字节兜底)。

## AI Agent
- AI 助手已**单页化**到 `/agent`(原 `/ai` 页面已删除并重定向):会话、日志挂载(LogContextPicker → execute-stream `attachedLogs`)、确认门、长期记忆都在这一页;`/ai/chat` 与 `/ai/exec` 路由已删,`/ai/diagnose` 仍供日志页诊断弹窗使用。
- 执行路径收敛为 Tool Loop 单通道:`POST /ai/agent/execute-stream`(SSE)+ `POST /ai/agent/approve` 确认门;早期 plan/execute/confirm/feedback/export 等规划管线端点已删除,勿再引用。
- 会话历史单一通道:后端从 DB 读,前端不回传 `history`;token 分片由后端发射层保证干净,前端**原样追加,禁止逐分片清洗**(会吃掉分片边界空白,导致 Markdown 表格/代码块粘连)。
- 前端聊天逻辑在 `frontend/src/composables/useAgentChat.js`(工作台与全局抽屉共用);页面上下文采集在 `useAgentConsole.js`(抽屉关闭时不做快照)。
- 新增能力:数据卷备份(命名卷 tar,`ops/storage/volume-*` + cron 类型 `volume-backup`,目录 `backup.volume_dir`,每卷留 20 份);GitOps webhook(`POST /gitops/webhook/:id`,token=`gitops.webhook_token`,未配置即关闭,auth 豁免);市场 AI 找应用(`POST /marketplace/templates/ai-discover`,只出草稿,入库走 custom 模板);env 文件族(`GET /projects/:id/env/files`,支持 `*.env`/`.env.example`);Agent 聊天 token 120ms 节流 + 滚动跟随(`atBottom`)。
- Agent 引擎外围能力(借鉴 EnsoCode,全部不侵入 Tool Loop 主循环):`agent/runaway-guard.js` 死循环检测(相同动作/结果/错误族/轮询四条 streak,命中在工具结果前注入 system-reminder,每轮至多一次);`agent/approval-gate.js` 会话级审批门(模式 ask/allow_writes/full,critical 永远确认;`remember=call|tool` 记本会话,按 工具+projectId/containerId 指纹);确认门 UI 有"本会话不再询问(同参数)"按钮;`POST /ai/agent/approval-mode` 切换模式。工具结果回喂 LLM 前经 `truncateToolResult` 截断(24K 保首尾);`compose.restart` 有 runGate 后置验收(重启后必须检测到运行容器);Transcript 双视图:`ai_sessions.compacted_before_id`(迁移 v10)分界,模型只读分界后的 `getAiActiveHistory`,渲染仍读全量 `getAiHistory`。
- Agent 增强二批(借鉴 EnsoCode/OneSSH):**值级脱敏** `lib/secret-redactor.js`——工具结果/挂载日志/页面状态/用户消息先收割敏感值(KEY=VALUE 且键名命中敏感正则),出站文本统一 `redactSecrets`(已知值 + sk-/ghp_/xox/AKIA/Bearer 静态形态 → `[REDACTED]`);**后台任务** `agent/background-tasks.js`——`compose.up/pull` 支持 `background: true` 立即返回 taskId(后台路径超时放宽 15 分钟),`task.list/output/stop` 三工具,完成后同会话下一轮 LLM 调用前搭车注入 `<background-task-update>`(pre-call drain,无送达黑洞;compose 模式可真杀子进程,workspace 模式断流伪停止,containers 模式只标记);**静默轮次恢复**——模型空轮(无文本无工具)剔掉后 system 追加一次性 nudge 重跑,第二次静默按失败收场;**会话压缩** `agent/compaction.js`——确定性事实抽取为种子的固定格式摘要(模型失败回退纯事实),`POST /ai/agent/compact` 推进分界并落 `compact_summary`,引擎每轮把摘要注入 system,工作台会话菜单有"压缩历史"按钮;**记忆 OneSSH 式**——`listAiMemories` 按 importance×veracity 权重×72h 半衰期 recency 加权召回,`recordAiMemoryRecall` 只在 memory.search 显式检索时计数(被动注入不计数,防 recall_count 通胀),`sleepAiMemories` 去重/衰减(30 天未用 ×0.9)/清理(90 天未召回低价值),`memory.save` 支持 importance/veracity。
- 路由层:`router.js` 的 `preloadRouteChunks()` 在空闲时预取全部 chunk;App.vue 对 13 个无流式/轮询的页面做 keep-alive(**新增流式/定时轮询页面时务必排除**,否则 interval/ws 在后台保活泄漏);页面切换走 `page-fade` 过渡。

## 常用命令
- 前端构建: `cd frontend && npm run build`(零 Warning;`chunkSizeWarningLimit: 3000`)
- 前端单测: `cd frontend && npx vitest run`
- 后端单测: `cd backend && DB_PATH=/tmp/x.db npm test`(必须 `--test-concurrency=1`,并发会多进程抢同一 DB 偶发失败)
- 后端语法: `node --check <file>`
- 完整启动: `node backend/src/index.js`(`SERVE_FRONTEND=1 PORT=3001 ENABLE_SHELL=1`)

## 多节点 Docker 宿主
- `backend/src/services/docker-hosts.js` 管理 Local/TCP/SSH 节点;活跃节点通过 `setSetting('docker.active_host')` 持久化。
- SSH 节点在远端主机上读写 Compose/env(`mountState=remote_ssh`,`composeMode=workspace`,不在远端拉起本机镜像)。仅有 Docker API 的 TCP 节点仍是容器控制模式(`mountState=remote_api_only`,`editable=false`)。`compose-runner` 通过 `DOCKER_HOST` 在子进程内切换节点。
- 切换节点后前端广播 `composeops:host-changed`,各页面监听触发刷新。

## Git 操作经验
- 沙箱内 `.git` 只读:commit 需 `sandbox_permissions=require_escalated`,`prefix_rule:["git","commit","-m"]` 已批准。
- `git push origin main` HTTPS 在沙箱握手失败;直接提升权限走已批准 `["git","push"]` 即可成功;SSH 地址 `git@github.com:StanlySGY/ComposeOps.git` 沙箱内 DNS 解析失败,需同样提升权限。
- 提交信息用中文结构话术(标题 + `-` 分节)。

## CodeGraph

Use CodeGraph to understand or locate code BEFORE grep/find or reading files, when the repo is indexed (a `.codegraph/` directory exists at the repo root).

**Indexing lifecycle (handle this first):**
- If there is no `.codegraph/` directory at the repo root → run `codegraph init [path]` to initialize the project and build the initial index.
- If `.codegraph/` exists but may be out of date → run `codegraph status [path]` to check index freshness:
  - Run `codegraph sync [path]` for incremental updates since the last index (fast, preferred).
  - Run `codegraph index [path]` to rebuild the full index from scratch when a full rebuild is needed.
- If indexing is not possible (CLI missing, user declined), fall back to grep/reading files.

**Querying:**
- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it is listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

**Other useful commands:** `codegraph query` (symbol search), `codegraph node` (one symbol's source + caller/callee trail), `codegraph callers` / `codegraph callees` / `codegraph impact` (dependency analysis), `codegraph files` (project structure).
