# ComposeOps 实测报告:UI / 交互 / 功能联动(2026-11)

> 定位:本报告是 `docs/IMPROVEMENT_PLAN_2026-11.md` 的**证据层**。改进项本体(B-/L-/U- 编号)以方案文档为准,此处不重复;本文提供 28765 运行实例上的实测验证矩阵、两处判定修正、六项方案外新发现,以及开源对标到方案条目的映射,供执行 agent 直接引用。

## 0. 环境与实测方法

- 实例:`127.0.0.1:28765`,仓库当前代码 docker compose 部署(双 compose 文件 + 外置数据库密钥,即 AGENTS 规定的发版形态),纳管 4 个真实项目:composeops / axonhub / content-factory / wechat-ai。
- 工具:Playwright headless Chromium(1440×900)+ 复用登录态;脚本与截图在仓外 `/home/sgy/cops-uxtest/`(`helper2.mjs`、`scan2765.mjs`、`timing2765.mjs`、`inter2*`–`inter6*`,截图目录 `shots2765/`)。
- 纪律:运行实例只做只读操作与只读问答;容器停启等写操作在前一轮已单独验证过,本轮不复现破坏性路径。
- 审计来源:前端设计系统审计(18 项)、功能关联性审计(18 项)、后端产品成熟度审计(17 项)、开源对标调研(Coolify / Dokploy / Komodo / Portainer / Uptime Kuma / Beszel / CasaOS / lazydocker),已合并进方案文档。

## 1. 全局健康基线(27 路由 + 7 条重定向实测)

- **全路由 0 console 错误、0 HTTP≥400**。当前版本运行面干净,无可见劣化。
- 重定向全部符合预期:`/operations→/events`、`/timeline→/events`、`/metrics→/monitor`、`/ai→/agent`、`/blueprints→/marketplace`、`/knowledge→/cmdb`、`/rollback→/review?tab=rollback`。
- 首屏时序(采样 main 文本长度 + skeleton 节点数,见 `timing2765.mjs`):

| 页面 | 0.4s | 1.2s | 2.5s | 5s |
|---|---|---|---|---|
| dashboard | 28 个 skeleton | skeleton | **内容就绪** | — |
| resources | 21 个 skeleton | skeleton | **内容就绪** | — |
| monitor | 21 个 skeleton | skeleton | skeleton | **内容就绪(全站最慢)** |
| events | 0 skeleton,直接可见短文本 | 同 | 同 | 同 |

- 可访问名扫描(无 aria-label/title/placeholder/文本 且无 `label[for]` 的 input/select/textarea):**settings 6 个;services 2 个;logs、monitor、agent、topology、inspection、marketplace 各 1 个**;全站按钮与链接 0 个无名。→ 这是 U-12 的按页计数证据,执行时可直接当回归基线。
- Cmd+K 命令面板:打开、中文检索("巡检"命中 2 条带描述的结果)、回车导航到 `/inspection`,全链路正常。
- compose 页功能密度实测:项目选择(4 项)+ 模板插入 + 可视化 / 语义校验 / 格式化 / 转换 / 备份 / 保存俱全;**但初始选中值为空,即使仅有一个纳管可编辑项目也不预选**(见 N-3)。

## 2. 审计条目实测验证矩阵

状态口径:**实测** = 在 28765 实例复现; **静态** = 审计的 file:line 与本次 grep/代码核对一致; **未测** = 需写操作,本轮回避。

| 方案条目 | 状态 | 实测/核对证据 |
|---|---|---|
| L-03 事件 deep-link 错路由与 Tab | **实测坐实** | `/#/events?tab=jobs&job=abc123` → `aria-selected=true` 落在"告警事件"tab(URL 参数保留但被忽略);`?tab=operations` 正确进入"操作与任务"(操作记录 51 + 后台任务)。`EventCenter.vue:185,209` 的 `tab=jobs`/`status=failed` 应统一为 `/events?tab=operations&job=` |
| L-08 "交给 Agent"两套机制割裂 | **实测坐实(判定有修正,见 §3.1)** | 在 `/agent` 页 dispatch `composeops:agent-prompt` → 抽屉不弹、主聊天输入为空;全仓仅此抽屉监听(`AgentDrawer.vue:182`) |
| L-06 keep-alive 半实现 | **静态核对** | 白名单(`App.vue:61-66`)中 SettingsView/TopologyView/ComposeView 均 0 个 `onActivated`;AutonomousOpsView 有 2 个 hook 却不在白名单(死代码);GitOps/CostAnalysis/Resources 两者齐备是正例 |
| L-18 冷页无预取 | **实测印证** | compose、monitor 恰为冷进入最慢页(monitor 5s 首屏),与 preload 排除名单吻合 |
| U-12 可访问名缺失 | **实测坐实** | 服务页容器动作图标链只有 `title`(`aria-label=null`);无名 input 按页计数见 §1 |
| U-18 英文页头 | **实测坐实** | ops-center 页 `<h1>` 实测为 "Autonomous Ops" |
| U-19 巡检明细裸 `0/2/3` | 实测(前轮已录,已在方案内) | — |
| L-01 / L-02(Agent 写后不刷新;compose 保存/备份恢复无跨页感知) | 静态 + **未测(写路径)** | 派发点仅 `cron_created`(`useAgentChat.js:274`);`ComposeView.vue:663-673,737` 无广播。执行修复后用 §5 脚本做验收 |
| L-04/L-05/L-09…L-17、U-01…U-11、U-13…U-16、B-01…B-08 | 静态 | 与审计 file:line 一致,未见反例 |
| 日志 from 返回链(正例) | **实测通过** | services 卡展开 → 日志图标 → `#/logs?…&from=services` → 出现"返回服务列表" → 回 `#/services`,上下文预填正确。全站联动体验最好的一条链,修复其它深链时以它为模板 |
| Agent 只读问答(正例) | **实测通过** | `/agent` 提交只读问题,4s 内出现工具卡片(名称/状态/耗时),只读场景不触发确认门;引擎注入了"只允许只读查询"护栏(见 N-4) |

## 3. 两处判定修正(相对审计原文)

1. **L-08 的病灶比"两套并存"更具体**:五个发射点(EventCenter/Inspection×3/Services/Marketplace)都正确 `openAgent()`+dispatch 成对调用,普通页面的抽屉预填是好的。真正的断裂只有两处:① 预填只在抽屉 open 瞬间被消费(`pendingPrompt` 于 `startFreshSession` 消费,`AgentDrawer.vue:141-147`),单独 dispatch 不开抽屉时**静默丢弃、无任何提示**;② `/agent` 整页无监听,抽屉与整页会话是两套状态。修法应保持 L-08 的统一方向,并顺手加"dispatch 必配对 openAgent"的约束(或让 pendingPrompt 自行触发 open)。
2. **服务页"日志入口看不到"不是坏链,是折叠门槛**:未展开项目卡时 `main` 内不存在任何日志链接(冷进入 7s 实测);点击卡头展开后"实时日志/聚合日志"出现且深链完全正常。审计中"容器级入口不可发现"的印象应归入新发现 N-1,而非深链 bug。

## 4. 新发现(方案未收录,建议并入对应批次)

| # | 发现 | 证据 | 建议 | 参考 |
|---|---|---|---|---|
| N-1 | 容器级动作(日志/终端/AI)完全藏在折叠卡内,每个容器都要先展开卡才见到入口 | 冷进入 services 无 `a[href*=logs]`;展开后 3 图标出现、其中 1 个 `visible:false` | 卡头常设三动作摘要条(聚合日志直达);单容器项目自动展开 | Portainer 容器行动作栏;lazydocker 快捷面板 |
| N-2 | monitor 首屏 5s 全站最慢;events 页无 skeleton(空白等待) | §1 时序表 | monitor 先渲染 servicesStore 已有的项目/容器静态信息,指标异步补;events 补 Skeleton 规范 | Uptime Kuma 先出列表再上色 |
| N-3 | compose 页仅一个可编辑项目也不预选 select,首次进入必须多一次选择 | 实测 select `value=""`,4 选项 | 单项目自动预选;多项目记住上次选择(sessionStorage) | Portainer stack 默认选中 |
| N-4 | `/agent` 页只读护栏整段文本出现在正文消息流中(`"请只查询…只允许使用只读查询工具…"`可在 body 文本里 grep 到) | inter3 实测 | 若为系统注入提醒,应视觉分级(如 task-notice/AgentThinking 层级),避免被当成助手输出;需产品确认是否有意展示 | — |
| N-5 | settings 6 个、services 2 个无名表单控件(其余 6 页各 1 个) | §1 扫描 | 并入 U-12 清单,按页清零作为验收 | — |
| N-6 | Agent 工具卡片 4s 内渲染出状态与耗时,只读不触发确认门 | inter3 实测 | 作为 L-01 修复后的验收基线:mutation 型 `action_completed` 后其它页应可见刷新 | — |

## 5. 开源对标 → 方案条目映射(执行 agent 速查)

- **Portainer**(栈编辑器):Version 历史下拉、"Prune services" 显式确认、Git 栈只给"拉 commit + Re-pull"复选 → 支撑 L-02 保存流与 U-05 弹层收编。
- **Uptime Kuma**:同 key 告警折叠成一行(count + first/last)、20s 间隔状态条、公开 status page → 支撑 L-03 深链修复后的事件流密度、L-17 告警直达;`guardian.js` 的 key 冷却可直接复用做折叠键。
- **Komodo**:Sync Resources(desired-state 收敛,挂确认门后面最省安全)、Procedures 按标签批量操作、schedule `failure_alert` 开关 → 支撑 L-04(任务统一中心)与 cron 能力扩展。
- **Coolify / Dokploy**:安装收尾三件套(访问 URL 卡片 + 自动生成的强密码 + 首启健康检查)、部署队列可取消、S3 异地备份、digest pin 回滚"发布点" → 支撑 Marketplace 体验、B-03、第三波发布点。
- **Beszel**:一屏多宿主节点卡片墙、一行 curl 加节点 → 支撑 L-14 节点分组共享化、B-02 多宿主失明修复后的信息呈现。
- **lazydocker**:prune dry-run 可回收清单(按类别 MB)、祖先层分析 → 支撑 U-10 ResourcesView。
- **差异化红线(改进时不得改没)**:确认门 + 策略组 + 会话审批、7 个通知渠道(bark/wecom/dingtalk/feishu)、`verifyVolumeBackup` + `recovery:drill`、compose/env 双栏 diff 预览、容器状态转换推算可用率。

## 6. 执行建议(与方案 §E 批次交织)

1. **批次 1(方案 A 后端 P0)不变**。附加验收:`scan2765.mjs` 口径(全路由 0 console 错误 / 0 HTTP≥400 / 无名控件计数不回升)纳入回归。
2. **批次 2(方案 B 联动闭环)**照做,并追加三件小事:修 L-03 时统一深链参数生成器;L-08 修复时加"dispatch 必配对 openAgent"约束 + `AgentWorkflowView` 监听 `agent-prompt`;按 N-1 给服务卡加卡头动作条。
3. **批次 3(方案 C UI 债)**照做,U-12 验收目标直接用 §1 的按页计数;新增 N-2(events skeleton、monitor 首屏静态先行)与 N-3(compose 预选)。
4. **e2e 资产沉淀**:把 `scan2765.mjs` 与 `timing2765.mjs` 的口径移植进 `frontend/e2e`(现有仅 `preview.e2e.js`),作为"全站健康 + 首屏性能预算(monitor ≤ 3s)"CI 守卫。
5. 写路径联动验证(L-01/L-02 的端到端效果)建议在测试环境做一次:Agent 执行一次 `compose.pull`(background 模式)→ 断言 monitor/resources 页数据在下一轮轮询前已变化。

## 附:本轮截图索引(`shots2765/`)

`services_expanded.png`(卡展开后三图标)、`logs_from_services_ok.png`(from 返回链)、`events_tab_operations.png`(正确 tab 深链)、`agent_prompt_event.png`(/agent 页事件无响应)、`agent_sent_4s.png`、`agent_answer.png`(只读问答与护栏)、`cmdk_open.png`(命令面板)、`compose_page.png`(初始空选择)、`dash_at2500.png`(2.5s 骨架→内容)。
