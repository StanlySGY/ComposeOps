# ComposeOps 改进方案(2026-11 全量审计版)

> 交付物说明:本方案基于三路代码审计(前端设计系统 / 功能关联性 / 后端健壮性)+ 一轮真实浏览器回归测试 + 外部同类产品对标,可直接拆给多个 agent 并行执行。
> 每条都带 证据(file:line)→ 改法 → 验收标准。执行前先读 AGENTS.md(命令、z-index 阶梯、字节一致镜像约束、workspaces 安装规则)。
> 仓库根:`/home/sgy/workspace/ComposeOps`。后端证据路径以 `backend/src` 为根,前端以 `frontend/src` 为根。

## 0. 现状基线(2026-11-06 实测)

**已验证修复**(本轮浏览器回归实测通过,勿重复修):
- Compose 保存预览不再出现伪"将被移除的服务"(新增服务只报 added);
- 备份弹窗在有备份时不再误显示"暂无配置备份";
- 通知测试按钮语义正确:"通知未发送:通知功能或所有通知渠道均未启用";
- 巡检报告列表/评分/明细正常渲染。

**测试基线**:前端 vitest 423/423 全绿(此前一次 422/423 为 flaky);后端需按 AGENTS.md `DB_PATH=/tmp/x.db npm test --workspace backend` 串行跑。
**浏览器回归资产**:`/home/sgy/cops-uxtest/`(Playwright 脚本 + 登录态 state.json),可复用作各批次验收工具。
**实测遗留小项**:巡检"明细"列显示裸 `0/2/3` 无标签(见 U-19);图标型卷备份复选框无可访问名(见 U-12)。

---

## A. P0 数据正确性与多宿主(后端核心,建议单 agent 串行做)

### B-01 [严重] 项目身份不含宿主维度,多宿主同路径同名项目互相覆盖
- 证据:`services/project-id.js:8-12`(ID 仅由 workingDir+projectName 派生);`scanner.js:131,135`;`lib/db.js:59-60`(project_preferences 主键)、`db.js:530-544`(container_state_events)、`db.js:77-79`(operation_history)均无 host 列;全库仅 `volume_backups` 有 host 列(`db.js:236-247`)。**实测已出现两个同名 `composeops` 项目(id 0537ae0e / ba07e916)并存**,其一 `mountState=metadata_missing`。
- 改法:项目 ID 派生纳入 hostId(或所有项目相关表加 host 联合键 + 迁移)。这是多宿主一切功能的地基,先于 B-02/B-04 做。
- 验收:双假宿主(可用 TCP 假节点或 mock driver)同路径同名项目产生两个不同 project_id,偏好/事件/操作历史互不串写;现有单宿主数据迁移无损(迁移脚本带备份还原演练)。

### B-02 [严重] 监控/自愈/事件流只作用于"当前活动节点",其余节点静默失明
- 证据:`metrics-collector.js:32,179`、`alert-monitor.js:131,164,199,254`、`health-alerter.js:46,109`、`image-updater.js:196,354` 全走 `getActivityDocker()`;`container-events.js:32,100,120` 宿主变更即 `stopDockerEventStream()`;`routes/ws.js:97,227` 日志订阅绑活动宿主。
- 改法:调度器按已配置 host 列表逐个建采集器/事件会话,"每节点一份健康与事件流"一等公民;UI 提供节点过滤。
- 验收:配两个假节点时两节点容器都出现在 /monitor 与事件中心(按 host 标注);单节点行为不变。

### B-03 [严重] 定时数据库备份无消费者时背压卡死,且无完整性校验
- 证据:`db-dumper.js:138-142`(gzip.pipe 到被丢弃的 PassThrough,~64KB 后反压 docker exec stdout)、`db-dumper.js:161-181`(固定 300ms 收尾窗口即返回)、`:157,163`(客户端中断 output.destroy 半途 .gz 留在 `data/backups/db/`);`cron-scheduler.js:260` 调用后丢弃 result.stream,靠 `:348-352` 15 分钟 SIGKILL 兜底。
- 改法:后台(cron)路径不接 output 管道,只落文件;落盘后校验 gzip 完整性+字节数+退出码,失败产生告警事件(接 B-16)。
- 验收:模拟大库 dump(>100MB)cron 任务在合理时间内完成且文件可 gunzip;中断测试不留半成品文件。

### B-04 [高] 活动宿主是进程级全局可变状态,长操作中途切节点即跨节点执行
- 证据:`docker-hosts.js:95-102,170`(setActiveHost)、`routes/hosts.js:100`;`compose-runner.js:63`(`project?.host || getActiveHost()`,scanner 从不给 project 赋 host);`alert-monitor.js:131,164`(拿旧扫描的 container.id 对"当前活动客户端"inspect/restart)。
- 改法:操作入口一次性解析 hostId 沿调用链显式传递(仓库已有范式:`ops-effect-worker.js:38` 校验 `effect.target.hostId`);操作期间 pin 宿主,检测到变更即中止。依赖 B-01。
- 验收:操作进行中切宿主 → 该操作失败并报"宿主已变更",绝不跨节点执行。

### B-05 [高] 互斥锁只在单进程内存,cron 路径连进程内锁都绕过
- 证据:`project-operation-lock.js:3,10-13`(Map+AsyncLocalStorage)、`compose-runner.js:13-25`、`cron-scheduler.js:364,369,384`(running Set);`cron-scheduler.js:322-323` 直接 spawn compose,未经 `project-action-runner.js:28,52,60` 项目锁 → 定时 pull 与 UI up/save/镜像升级(`image-updater.js:321` 有锁)可并发打同一项目。
- 改法:项目级互斥下沉为 SQLite TTL lease 表(仓库已有 `ops_effects.lease_expires_at` 范式,`db.js:742-755`);cron 复用 project-action-runner。
- 验收:并发测试:同一项目同时触发 cron pull 与 UI compose up → 后到者排队或明确拒绝,无交叉输出。

### B-06 [高] cron 定义与执行历史存 `data/cron-jobs.json`:非原子写、解析失败静默清空、不进备份
- 证据:`cron-scheduler.js:12`(路径)、`:125-138`(JSON.parse 失败 → jobs=[] 且 fileLoaded=true,之后 persist() 覆盖只剩一条)、`:141-144`(writeFile 全量覆盖,无 tmp+rename);导出白名单排除 `docker.hosts`(`db.js:1743`),cron 也不在导出集合。
- 改法:迁进 SQLite 事务表(长期);短期至少 tmp+rename 原子写 + 解析失败拒绝覆盖并告警。
- 验收:损坏 JSON 注入测试 → 任务不丢失且有告警;cron 数据出现在个人数据导出与 DB 备份恢复演练中。

### B-07 [高] `saveCompose` 的 `docker compose config --quiet` 无超时且整段包在项目锁内
- 证据:`compose-runner.js:130-149`(spawn 后只等 close,无 kill 计时器)、`:162`(withProjectOperationLock 包住校验与替换);`compose-runner.js:119` 的 `COMPOSE_OPERATION_TIMEOUT_MS` 全仓无引用(死常量);对照 `project-action-runner.js:33-36` 有 SIGTERM/SIGKILL。
- 改法:给 config 校验加 30–60s 硬超时(锁内生效);删除或真正启用该常量。
- 验收:mock 一个挂死的 compose config 子进程,30s 内保存请求返回超时错误且锁释放。

### B-08 [高] `/health` 用静态本地 Docker 客户端,与活动宿主无关
- 证据:`app.js:28`(`import docker from './services/docker.js'`)、`docker.js:5`(`new Docker()` 固定本地 socket)、`app.js:169-186`(health 只 ping 该客户端并据此 503)。
- 改法:按已配置节点逐个 ping,返回 `{activeHostId, hosts:[{id,ok,latencyMs}]}`;避免编排层因远端节点抖动误重启面板。
- 验收:活动节点为远端且不可达时 /health 仍报告面板自身 ok + 该节点 down。

---

## B. P1 功能关联性闭环(前端事件系统 + 跨页联动,建议单 agent)

### L-01 [严重] Agent 执行写操作后普通页面不刷新(Agent↔UI 断裂)
- 证据:`composables/useAgentChat.js:274` 只有 `cron_created` 派发 `cron-agent-created`;Agent 的 compose/容器/config 工具成功后无任何广播,也不调 servicesStore。Monitor/Inspection/Resources/GitOps/Cost 等本地取数页只有 host-changed+轮询。
- 改法:所有 mutation 型 `action_completed` 统一派发 `composeops:data-changed`(带 projectId/host),各页据此失效本地缓存;与 L-02 共用同一事件。
- 验收:让 Agent 重启一个容器,15s 内 /monitor 与 /resources 指标/状态自动更新,无需手动刷新。

### L-02 [严重] Compose 保存/回滚、卷备份恢复无跨页感知
- 证据:`ComposeView.vue:663-673`(confirmSave 只调 API+本地 message)、`:737`(confirmRestore 只 load()+toast);`components/resources/VolumeBackupPanel.vue:159-185` 仅本地 toast;全仓无 `data-changed`/`compose-changed` 事件。正例:`RollbackView.vue:295,400` 调 `store.refresh(true)`。
- 改法:保存/回滚/恢复成功后派发统一 `composeops:data-changed`;servicesStore/monitor/resources/topology 订阅。
- 验收:改 compose 新增服务 → /services 卡片 5s 内出现新服务;恢复卷备份 → /resources 列表更新。

### L-03 [严重] 事件中心"任务/操作"事件 deep-link 用错路由与 Tab(点了看不到)
- 证据:`components/EventCenter.vue:185` `to:/operations?tab=jobs&job=…`、`:209` `/operations?status=failed`;而 `/operations` 已 redirect 到 `/events`(router.js),`EventCenterView.vue:101` `TABS=['timeline','operations','state']`,tab=jobs/status 不在集合 → 落回告警 tab。正例:`AutonomousOpsView.vue:165` 用 `/events?tab=operations&job=`。
- 改法:统一 `/events?tab=operations&job=`;顺带落实 L-15 深链规范。
- 验收:批量任务失败事件点击后直达对应 job 详情视图。

### L-04 [严重] cron 执行、GitOps 同步、卷备份、巡检产出不进统一事件/任务中心(数据孤岛)
- 证据:`emitEvent/recordAlertEvent` 仅出自 event-center.js/events.js/task-watchdog.js/workflow-engine.js;`gitops.js:28,117` 用内存 activeOperations Map 不落 operations 表;`cron-scheduler.js` 执行不 emitEvent;巡检/卷备份同理。前端 AutonomousOpsView 取数源无 getCronHistory/getGitOpsHistory/getInspectionOverview。
- 改法:cron/gitops/backup/inspection 完成时写 operations 表或 emitEvent,ops-center 统一消费。
- 验收:跑一次 cron pull + 一次 GitOps sync,任务中心时间线各出现一条可下钻记录。

### L-05 [高] `projects-changed` 只有 AppHeader 监听,纳管/挂载变更不扩散
- 证据:`SettingsView.vue:558` 保存后派发,全仓仅 `AppHeader.vue:345` 监听(只刷 header 自己)。servicesStore/ServicesView/TopologyView 不监听。
- 改法:servicesStore 监听 `projects-changed` 触发 refresh(或并入 L-01 的 data-changed)。
- 验收:设置页纳管新项目 → /services 无需刷新即出现该卡片。

### L-06 [高] keep-alive 生命周期半实现(onActivated 死代码 + 返回陈旧)
- 证据:`App.vue:61-66` keepAliveViews 名单与实现错位:`AutonomousOpsView.vue:261,588` 写了真 onActivated 却不在白名单(永不触发);`AgentWorkflowView.vue:753` 只有注释无 hook 且不在白名单;白名单里 SettingsView/TopologyView/ComposeView 无 onActivated → 切回数据不刷新。AGENTS.md 明确要求"新增实时/定时页面必须实现并测试激活/失活资源生命周期"。
- 改法:对齐名单:AutonomousOpsView 入 keepAlive;SettingsView/TopologyView/ComposeView 补 onActivated 刷新(或移出 keepAlive);补一条"白名单页面必须导出激活/失活 hook"的 lint 或单测。
- 验收:切走 /compose 外部改文件 → 切回自动见新内容;AutonomousOpsView 自动 load 生效。

### L-07 [高] 孤岛页面:12 个功能页 0 页内入口 + 默认折叠分组
- 证据:跨页入口计数 review/gitops/cost/cmdb/node-groups/resources/topology 均为 0;`AppSidebar.vue:120` 默认折叠"自动化"与"资源"两组(共 12 页),只能靠 Cmd+K 发现;`router.js` preload 又排除 monitor/compose 等重交互页。
- 改法:Dashboard 增加 review/cost/resources/gitops 入口卡;默认展开高价值分组;对 monitor/review/ops-center 纳入 preload;与 U-07(IA 合并)同批做,避免加了入口又合并导航的返工。
- 验收:新用户路径(不打开 Cmd+K)可在 2 次点击内从 Dashboard 到达巡检、成本分析、GitOps。

### L-08 [高] "交给 Agent"两套机制并存,/agent 整页与全局抽屉割裂
- 证据:机制A `agent-prompt` CustomEvent → AgentDrawer(App.vue:36),发射者 InspectionView×3/ServicesView/MarketplaceView/EventCenter;机制B `sessionStorage 'composeops:agent-diagnosis-prompt'`+push('/agent')(`AIDiagnosisModal.vue:107,111`,仅 `AgentWorkflowView.vue:708-715` 读)。`/agent` 整页不监听 agent-prompt。
- 改法:统一为 agent-prompt 一条 prefill 通道,AgentWorkflowView 也监听;抽屉与整页会话状态同源(共用 useAgentChat 会话 id)。
- 验收:在 /agent 页内触发"交给 Agent"预填发生在主聊天输入框,不弹抽屉。

### L-09 [中] 镜像更新检查 4 处重复实现,UI 各写一份
- 证据:SettingsView(checkUpdates `:538`)、`NodeGroupView.vue:179`、`ServiceProjectCard.vue:205`、`ProjectUpgradeModal.vue:79`,加 `EventCenter.vue:214` pending-images 卡片;仅共享纯函数 `lib/image-update-summary.js`。正例:StoragePruneModal、VolumeBackupPanel 已共享。
- 改法:抽 ImageUpdatePanel 或统一走 ProjectUpgradeModal。
- 验收:三处 UI 同一组件;新增"有 N 个可升级"入口一致性测试。

### L-10 [中] 巡检建议无法一键转成动作
- 证据:`InspectionView.vue:166-167` finding.tool 只渲染成文本徽章;后端 `services/inspection.js:47,123` 每条 finding 带 tool 字段(本为一键处理设计);整报告只有 askAgent/askAgentForReport(`:357,362`)。
- 改法:finding.tool 做成按钮 → 预填 Agent(agent-prompt)或生成 cron 草案。与 L-08 通道合用。
- 验收:"尚无数据卷备份"建议可直接点击生成卷备份 cron 草案并在确认门可编辑。

### L-11 [中] client.js 死方法 13 个(后端端点存在但 UI 不可达)
- 证据:0 调用:`getProject/getStateContainers/getMetricsStats/getActiveHost/getCmdbAsset/getWorkflowDefinition/getAgentFeedback/getAgentCompaction/pruneDocker/saveProjectMounts/streamApplyEnv/applyRetentionPolicy/evaluateAlerts`;其中 applyRetentionPolicy/evaluateAlerts 有真实后端端点 → 保留策略与告警评估"有后端无入口"。
- 改法:删除纯死方法;`applyRetentionPolicy`/`evaluateAlerts` 补设置页入口(与 B-11 保留策略统一任务配套)。
- 验收:client.js 无零调用方法;设置页可触发保留策略并预览影响。

### L-12 [中] 后端冗余端点与前端漂移面
- 证据:`GET /cost-analysis/{containers,images,projects,storage,trends}`+`POST /cost-analysis/snapshot` 前端只用 report/suggestions;`GET /marketplace/templates` 被 /ops/blueprints 取代;`GET /ops/inspection/reports` 前端只 getInspectionReport(id)(实测:报告列表页其实渲染了列表,但 client 缺 list 方法,属漂移);`PUT /projects/mounts` 已死。另实测 `GET /api/v1/projects/management` 返回 `project_not_found` 404 语义(GET 应为查询或 405)。
- 改法:合并冗余端点或补 client 方法;管理端点 GET 语义修正。
- 验收:client.js 与 router.js 端点清单一一对应(可写一致性测试脚本)。

### L-13 [中] 跨页返回(from)链只有 /logs 实现
- 证据:`LogsView.vue:120,283,293` 支持 from=services|topology+returnTarget;services→compose(`ServicesView.vue:457`)、event→/services?focus(`EventCenter.vue:198`)、`AIDiagnosisModal goCompose/goEnv`(`:101-102`)均无 from;`ComposeView.vue:7` "返回"硬编码 /services。
- 改法:把 from 返回做成路由层通用机制(如 meta.returnTarget 解析器),各 deep-link 统一携带。
- 验收:从事件中心 deep-link 进 /services?focus 后,页面出现"返回事件中心"按钮。

### L-14 [中] 节点分组纯 localStorage,不跨页/跨端共享
- 证据:`NodeGroupView.vue:137` 仅 `localStorage.setItem('composeops:node-groups')`;HostSwitcher/Settings hosts/stores/hosts.js 均不读。
- 改法:分组落 backend(hosts 表字段)并经 hosts store 共享。
- 验收:换浏览器登录,节点分组仍可见;HostSwitcher 按分组展示。

### L-15 [中] 同一资源 query 参数不一致(深链规范缺失)
- 证据:`AppHeader.vue:218` /logs?projectId= 无 from vs `ServiceProjectCard.vue:92` 带 from;EventCenter tab=jobs/status vs AutonomousOpsView tab=operations&job(即 L-03);/services?focus 与 ?env 混用(AppHeader:228 vs AIDiagnosisModal:102)。
- 改法:沉淀深链参数规范(projectId/containerId/from/tab/job)并集中构造(如 `lib/deep-links.js` 生成器,全站禁手写路由字符串拼接)。
- 验收:grep 全仓无手写 `'/logs?'`、`'/events?'` 类拼接;新增一致性单测。

### L-16 [中] GitOps 漂移与备份演练失败不产生下游动作
- 证据:`services/gitops-drift.js:120-132` 检出 drift 只返回对象,不 emitEvent/不建告警工单;`VolumeBackupPanel` verify 失败仅本地 toast(`:183-185`)。ops-tickets 能力已存在但未被调用。
- 改法:drift/演练失败接入告警(health-alerter/alert-monitor 通道)或直接生成工单。
- 验收:制造 drift → 事件中心出现可下钻告警,可一键建工单。

### L-17 [中] 告警 deep-link 只到项目 focus,无直达容器日志/监控
- 证据:`alert-monitor.js:124,219`、`health-alerter.js:136` 均 `to:/services?focus=${project.id}`;`EventCenter.vue:237` to:event.target||'/events';无 per-alert → /logs?projectId=&containerId= 或 /monitor?container= 直链。
- 改法:alert target 带 containerId;事件中心 alert 卡片加"去日志/去监控"按钮(与 L-15 规范合用)。
- 验收:unhealthy 告警一键直达该容器日志页(带 from=events)。

### L-18 [低] preload/keepAlive 名单与孤岛页策略不一致
- 证据:`router.js` preload 排除 {shell,agent,agent-history,compose,monitor};keepAlive 排除 AutonomousOpsView 等;孤岛重交互页冷进入既无预取又无缓存。
- 改法:与 L-07 同批:monitor/review/ops-center 纳入 preload;keepAlive 决策随 L-06 一并定案。
- 验收:冷进入 /monitor 首屏 < 1.5s(本地实测)。

---

## C. P2 UI/UX 设计系统债(前端,建议单 agent,按 U-01→U-19 顺序)

### U-01 [高] CostAnalysisView 整页游离于设计系统之外
- 证据:`views/CostAnalysisView.vue:2,10,19-27,31-57,83-90,344-433`:自建 .stat-card/.spinner/.error-state、硬编码 `↻` 字符按钮、手搓 SVG 图表;与 card/metric-tile/Skeleton/SparklineChart 体系脱节。
- 改法:迁移到既有组件(card/metric-tile/Skeleton/SparklineChart);图标换 lucide。
- 验收:文件内零 scoped 自定义卡/图样式;视觉与 /monitor 一致。

### U-02 [高] 关键元信息对比度不达 WCAG AA
- 证据:`text-muted`/`count-badge`/`data-table th`/`empty-state` 用 text-surface-500(#6f7a8a,style.css:128,241,338,351)在 surface-900/950 上约 3.2:1;`metric-meta` 用 surface-600(style.css:213)约 2.6:1,正是 11px 级关键元信息。
- 改法:次要文字 token 提亮至 surface-400/300;跑一次对比度脚本验证。
- 验收:全站正文/表头/计数对比度 ≥ 4.5:1(11px 小字),用脚本断言 token 组合。

### U-03 [高] 全站表格无排序、无分页(14 个 data-table 页零命中 sortable/pagination)
- 证据:全库 grep 零命中;最需要场景:AgentExecutionHistoryView(执行历史)、events/EventTimeline、GitOpsView 提交历史、CronTasksView 执行记录。
- 改法:data-table 场景补最小排序+分页或虚拟滚动(优先历史类四页)。
- 验收:执行历史 >100 行时首屏行数受控且可翻页;列头可排序。

### U-04 [高] 16/26 页缺 EmptyState,至少 5 种手搓空态并存
- 证据:`CMDBView.vue:64`、`ResourcesView.vue:67-71`、`WorkflowCenterView.vue:76`(td-colspan);`NodeGroupView.vue:51`、`WorkflowCenterView.vue:40`(虚线 div);`RollbackView.vue:40,63,86,107`、`OperationsCenterView.vue:119,159`(实色面板);`InspectionView.vue:131`、`CronTasksView.vue:78`、`OpsTicketsView.vue:63`(裸文本)。
- 改法:统一替换 EmptyState;空态文案应含"下一步动作"(链接或按钮),纯"暂无"不合格。
- 验收:全仓无手搓空态(可 grep 虚线 border-dashed+暂无 模式)。

### U-05 [高] MarketplaceView 4 个弹层不走 BaseModal/useEscapeKey
- 证据:`MarketplaceView.vue:150-237,541`:裸 modal-backdrop/modal 类+自写 handleMarketplaceDialogKeydown;违反 AGENTS.md 弹层统一约定。另 `AppSidebar.vue:48-49` 移动弹层未接 useEscapeKey。
- 改法:接 BaseModal + useEscapeKey,删除自写 trap。
- 验收:Marketplace 弹层 Esc/焦点陷阱/背板点击行为与全站一致(用现有 ConfirmDialog 测试基线仿写)。

### U-06 [高] 缺 btn-sm/input-sm 尺寸档 → 30+ 处 `!` important 覆写各自为政
- 证据:`OpsTicketsView.vue:146,171,190`(`btn-primary min-h-9! px-3! text-xs!`)、`RollbackView.vue:51,74`、`LogsView.vue:34-35`(`min-h-7! px-2! py-0.5! text-[11px]!`)、`DashboardView.vue:26`。
- 改法:style.css 增加 `btn-sm`/`input-sm` @utility;然后全仓清剿 `!` 覆写(grep `!` 类)。
- 验收:全仓 `min-h-\d+!|px-\d+!|text-\[11px\]!` 类覆写清零;按钮视觉尺寸归入两档。

### U-07 [高] 任务域信息架构重叠:5 个语义相近入口+图标重复
- 证据:`AppSidebar.vue:91-95`(ClipboardList×2、Clock3×2);"Autonomous Ops"/"长期运维任务"/"定时运维计划"/"工作流中心"/事件中心内嵌"操作中心"五个近义页(`AutonomousOpsView.vue:9`、`OpsTicketsView.vue:9`、`OperationsCenterView.vue:6`)。
- 改法:与 L-04/L-07 合并规划:把 任务/工单/计划/工作流 收编为"任务中心"一级页+tab,或至少重命名去歧义、图标去重。决策先行(建议合并到 /events 同级的"任务中心"),再动代码。
- 验收:侧栏任务类入口 ≤ 3 个且标题互不歧义。

### U-08 [中] 同一组 KPI 在 5 页以 4 种卡组件重复渲染
- 证据:`DashboardView.vue:32-60`、`MonitorView.vue:12`、`NodeGroupView.vue:17-19`、`CostAnalysisView.vue:31-57`、`ResourcesView.vue:24-26`(inline metric-tile / StatCard / ops-kpi / 自建 stat-card 四种实现)。
- 改法:定义 KPI 卡单一实现(建议 metric-tile 为权威),跨页只读复用。
- 验收:四页 KPI 同源组件;ops-kpi/自建 stat-card 样式删除。

### U-09 [中] RiskBadge 自称权威 0 引用,风险文案 5 处各自实现
- 证据:`components/common/RiskBadge.vue:19`(注释自称全站唯一权威);SettingsView、OpsTicketsView、AgentExecutionHistoryView、settings/AgentPoliciesPanel 手写;`CostAnalysisView.vue:302,396-398` 再造 severityLabel()+severity-* CSS。
- 改法:接入 RiskBadge(风险色进 @theme token)或删组件;五处统一。
- 验收:全仓风险徽章渲染只经 RiskBadge。

### U-10 [中] ResourcesView 单页 5 类体系错位
- 证据:`ResourcesView.vue:12,106`(flash 横幅代替 toast)、`:24-26`(手搓计数 chip)、`:31`(侧栏 nav-link 挪用为页内 tab)、`:55,74`(`.checkbox` 类在 CSS 中未定义,渲染为原生白色复选框)、`:77`(手搓状态徽章,同文件又 import 了 StatusBadge)、`:81`+`:89-90`(行内两段式删除确认与 ConfirmDialog 并存)。
- 改法:逐项替换:toast、count-badge、tabs、StatusBadge、ConfirmDialog 单轨;定义 `.checkbox` 或统一用 `accent-*` 原生风格(与 VolumeBackupPanel.vue:17、LogContextPicker.vue:23 现状三形态一并定案)。
- 验收:该页零手搓样式;删除确认只走 ConfirmDialog。

### U-11 [中] "emerald 状态色系"未落 token:唯一语义色是蓝 accent
- 证据:`style.css:18-19`(@theme 只注册 accent);emerald/rose 状态色硬编码于 `StatusBadge.vue:32-44` 等默认 Tailwind 色散落各处,与 AGENTS.md "emerald 状态色系"宣称不符。
- 改法:@theme 注册 `--color-status-ok/warn/error/info` token 并全站替换。
- 验收:grep 组件内 `emerald-|rose-` 硬编码明显下降;状态色改动一处生效。

### U-12 [中] 可访问名缺失:图标 router-link 仅 title、搜索 input 仅 placeholder、复选框无 label
- 证据:`ServiceProjectCard.vue:92-95`(每容器日志/终端/AI 入口仅 title);`ServicesView.vue:61`、`OperationsView.vue:27,63`(search-field input 无 aria-label);实测 /resources 卷备份复选框 aria-label 命中 0。
- 改法:补 aria-label;checkbox 一律包 label 或 aria-label。
- 验收:axe/lighthouse a11y 扫描主五页无 "label" 类违规。

### U-13 [中] 错误文案直接透传 error.message,中英混杂
- 证据:`toast.error(e.message)` 模式 ≥8 处(MarketplaceView、RollbackView 等);用户看到英文/堆栈级文本。
- 改法:前端加错误码→中文文案映射层(client.js 统一 catch 翻译,保留详情折叠)。
- 验收:断开后端网络/模拟 400,toast 文案全中文且含可行动信息。

### U-14 [中] z-index 阶梯违规:AppHeader 项目切换面板 z-60 与 Cmd+K 同层
- 证据:`AppHeader.vue:30` 用 z-60(AGENTS.md:8 z-[60] 专属 Cmd+K);`HostSwitcher.vue:10-11` 用 z-50(EventCenter 层)。
- 改法:降层或新增 z-58 子层并同步更新 AGENTS.md 阶梯表。
- 验收:Cmd+K 打开时可盖过 header 面板;阶梯文档与代码一致。

### U-15 [中] zinc 色板脱离 surface 家族
- 证据:`AgentExecutionHistoryView.vue:20-49`、`MarketplaceView.vue:189-199` 用 text-zinc-*。
- 改法:换回 surface-*。
- 验收:全仓 grep `zinc-` 清零。

### U-16 [中] 样式重复:toggle-label 与 agent-toggle 逐字节相同;tabs 三套、checkbox 三形态
- 证据:style.css:248-283 vs 285-319(diff 为空);tabs @utility:504、tabs-segment:2420、.nav-link:837 三套。
- 改法:合并重复 utility;tabs 定一套权威(tabs),tabs-segment 收编或文档化适用场景;与 U-10 checkbox 定案合并。
- 验收:style.css 无重复 utility;页内 tab 一律 tabs/tabs-segment。

### U-17 [低] 孤儿组件清理
- 证据:`components/common/RiskBadge.vue`(0 引用,与 U-09 联动定案)、`InfoPanel.vue`(0)、`TemplateVariableDialog.vue`(0)、`ContainerTerminal.vue`(0)。
- 改法:接入实际页面或删除(优先后者,除非有 roadmap 用途)。
- 验收:components 目录无零引用 .vue。

### U-18 [低] 中文文案约定破坏:英文页头 + 标点全/半角混用
- 证据:`AutonomousOpsView.vue:6` 页头 H1 "Autonomous Ops";toast 标点样例 `卷…失败:`(半角冒号)vs `卷列表加载失败：`(全角)混用。
- 改法:文案 lint(简单 grep 规则进 CI:页头无 ASCII-only 标题;toast 标点统一全角冒号)。
- 验收:AGENTS.md 文案约定有自动化兜底。

### U-19 [低·新增实测] 巡检报告"明细"列显示裸 `0/2/3` 无标签
- 证据:/inspection 报告行明细列渲染 "0/2/3"(严重/关注/提示计数),无表头语义,实测截图确认。
- 改法:渲染为 `0 严重 / 2 关注 / 3 提示` 或徽章组。
- 验收:明细列可读,不需 hover。

---

## D. P3 产品成熟度与能力边界(后端 P2/P3 + 外部对标,建议第三波)

### 健壮性缺口(后端审计 P2/P3 条目)

- **B-09** workspace 方式在本地 daemon 建容器并挂本机 docker.sock,对 TCP 远端节点存在目标错位:`compose-workspace.js:70,80,186-189`(仅 ssh 分支走远端);对照 `ops-effect-worker.js:38` 的显式拒绝范式。改法:tcp 节点显式拒绝 workspace 执行路径并把原因回传 UI。
- **B-10** 面板自身可观测性缺失:30 处 `console.error` 绕过结构化日志(`cron-scheduler.js:394`、`metrics-collector.js:41`、`container-events.js:137` 等);无 onResponse 延迟/状态码指标。改法:console→fastify.log 收敛;加 onRequest/onResponse 指标钩子并在"系统/诊断"区暴露 p95 延迟与错误率。
- **B-11** 保留策略不一致,主库已 869MB 无容量水位:`maintenance.js:87-118` 不清 alert_events/container_metrics;`metrics-collector.js:210-212,237` 仅进程内定时器;`maintenance.js:109` 吞缺表异常。改法:统一保留任务+库体积水位卡(与 L-11 的 applyRetentionPolicy UI 合并)。
- **B-12** 上游不可达被渲染成"没有项目":`container-events.js:108-116,136-142` 固定 3000ms 重连无退避;`scanner.js:113-117` 连接失败即 return []。改法:指数退避+抖动;扫描返回 `unavailable` 状态驱动前端横幅与告警(前端配横幅组件)。
- **B-13** 加密/搬迁路径 foreign_keys=OFF 且迁移无回滚:`lib/sqlite.js:66,133,293` vs `db.js:17`;19 条迁移只追加(`db.js:167-173,791-806`)。改法:全库 foreign_key_check 进 readiness 报告;高风险迁移补回滚演练脚本(AGENTS.md 已有"双 compose 文件+外置密钥"纪律,延续)。
- **B-14** 实时通道进程内内存态,重启即丢订阅无补投:`container-events.js:15,27,35-37,50,99`;`bounded-sse-writer.js:6`(256KB 溢出只回调)。改法:以 event_records 游标断线补投;前端显式"事件流已降级/重连中"提示。
- **B-15** 输入校验前移不彻底:`routes/personal.js:62-70` POST /import 无 schema(1MB JSON 直入);`db.js:1758-1777` 白名单不约束 projectPreferences 的任意 projectId。改法:/import 加 JSON Schema(键枚举/条数/体积),白名单留作第二层。
- **B-16** 关停不 drain,每次重启批量产生 outcome_unknown:`index.js:101-115`(5s race)、`index.js:55-66`(启动即标记 interrupted)。改法:关停先"拒绝新任务+有界等待 drain",可安全收尾的收尾;保留"不自动重放副作用"的现有正确语义。
- **B-17** 测试盲区:cron 持久化/损坏恢复、多宿主身份隔离、db-dumper 大 dump、`services/guardian.js`/`cost-analysis.js`/`deploy-preview.js`/`runtime-context.js` 零覆盖;前端 views/ 零测试(仅 6 组件 spec + 1 e2e)。改法:优先补 B-01/B-03/B-05/B-06 对应回归测试(与本批次改动同 commit);view 级测试接 CI。

### 外部对标差距(已实查 Portainer CE / Coolify / Dokploy / CasaOS / Komodo / Beszel / Uptime Kuma / lazydocker 官方文档,按对单用户 Compose 运维台的价值排序)

- **X-01 域名 + 自动 HTTPS**:Coolify/Dokploy 标配(Traefik 标签托管、Let's Encrypt 自动签发、redirect 规则)。ComposeOps 全仓无 domain/cert/traefik 管理(`project-ports.js` 只拼 `http://host:port`;grep traefik|letsencrypt 为空)。改法:**不要自己当反代**——做 Traefik labels 可视化生成器(compose 编辑里按服务生成 labels)+ 证书到期只读监控,性价比最高。来源:docs.dokploy.com `/core/domain/certificates`、github.com/coollabsio/coolify。
- **X-02 端点级可用性探测**:Uptime Kuma(HTTP/TCP/keyword/JSON/ping)+ 证书到期检查是同类标配。ComposeOps `alert-rules.js:12` `ALERT_METRICS` 只有 cpu/memory/restart_count;但 `state-history.js` 已实现 Uptime-Kuma 式容器状态推算可用率(容器级有、服务级无)。改法:复用现有 alert-rules/告警管道加 `http_check`/`tcp_check`/`cert_expiry` 三指标(compose 已解析 ports,探测目标可自动建议);与 L-11 的 evaluateAlerts UI 一并落地。来源:github.com/louislam/uptime-kuma。
- **X-03 备份异地化 + 定时 restore 演练**:Coolify(每日 cron + S3 兼容上传,且明文警告 "A backup is not a restore test")、Dokploy S3 destination、Beszel(磁盘或 S3 双向)。ComposeOps 备份只落本机磁盘(volume-backup.js/db-dumper.js;grep s3|minio 仅命中应用模板)——**同机故障=零保护**;已有 `verifyVolumeBackup()`+`npm run recovery:drill` 是好底座但不在调度里。改法:backup destination 抽象 S3/MinIO/SFTP(自家 MinIO blueprint 当一等公民)+ cron 新增 restore-verify 任务类型(`cron-scheduler.js:14-22` JOB_TYPES 现无)。与 B-03/B-06 同 agent 做。
- **X-04 期望状态收敛(desired-state)**:Komodo Sync Resources 是标配(期望状态+`depends on` 级联,sync 自动补齐缺失容器)。ComposeOps `gitops-drift.js` 头部注释即"只读对比…不执行任何变更"——drift 只能看不能收敛。改法:drift 页加"收敛"按钮,**直接挂现有确认门/操作锁**(L-16 的告警联动一起做),无需新建规则引擎。来源:komo.do `/docs/automate/sync-resources`。
- **X-05 Actions/Procedures 一等公民 + 定时失败告警**:Komodo Procedures(按标签批量重启、按时间 scale、批量 exec)+ Schedules 带 `failure_alert`。ComposeOps 定时只有 6 个硬编码类型(`cron-scheduler.js:14-22`);`workflow-engine.js:33` 有 trigger/condition/agent/approval/action/verify 节点但无"按标签/按组批量"action;cron 失败无告警开关。改法:cron 加 `failure_alert` 字段;把 prune/restart-by-label/exec/backup 做成可组合 action 目录——Agent 工具已有这些能力,只是没暴露成非 AI 的一等公民。来源:komo.do `/docs/automate/procedures`、`/docs/automate/schedules`。
- **X-06 私有 Registry 凭证 + digest pin 的升级路径**:Coolify/Komodo 把 Registry 当一等资源。ComposeOps `image-updater.js:101` 只向 `auth.docker.io` 要公共 token → GHCR/私仓 `reachable:false`;digest-pinned 服务被判 `pinned` 不可更新(`:70`)只能手改 compose。改法:host 级 registry credential 存储 + "换 tag 保留旧 digest,失败自动回滚"(`:421 restoreComposeBackupBatch` 骨架已在)。
- **X-07 部署历史 = 统一"发布点"**:Coolify rollback(retained images)/Dokploy 最近 10 次部署,把 compose 版本+env 版本+镜像 digest 绑成可回滚原子记录。ComposeOps compose 备份、env 备份、镜像升级(`image-updater.js:272-303` 快照)、ReleaseView 分别存在,缺统一发布点。改法:发布点表(compose sha + env sha + 每服务 digest + 触发来源),回滚=一次确认门内恢复三者;记录进任务中心(L-04 通道)。
- **X-08 PR preview / 评审部署**:Coolify preview deployments(独立域名+独立 env,PR 关闭自动回收)、Dokploy 队列可取消。ComposeOps 的 compose/env 双栏 diff 预览(`ComposeView.vue:135-137`+ChangePreviewModal)**已领先多数同类**,缺隔离预览环境。改法:`docker compose -p <proj>_prN`+临时端口起预览栈→URL→关闭即 down(复用 compose-workspace/operation-lock)。低频场景,放最后。
- **X-09 卷内文件浏览/下载**:Portainer volumes browse(upload/download/rename/delete)、CasaOS 文件管理。ComposeOps 只有卷列表+tar 整卷(`streamBackupToReply`),排障要开终端。改法:`docker exec ls -l` + 单文件流下载(只读起步),价值/成本比极高。
- **X-10 跨节点一屏指标墙 + 轻量 agent 拉取模型**:Beszel(hub+极小 agent,一屏多系统卡片含 disk IO/温度/容器表)、Komodo Periphery、Portainer Edge。ComposeOps HostSwitcher 单活跃节点视角、NodeGroupView 只批量巡检、远端走 SSH/TCP 直连(每轮 fan-out 慢且需暴露端口)。改法:hosts 页做 Beszel 式节点卡片墙(CPU/mem/disk%/容器数/最近告警)——**依赖 B-02 的每节点采集器**;SSH 通道可选 agent 模式留作远期。与 L-14 节点分组后端化同批。
- **X-11 应用商店完成度**:Coolify "360 one-click services + **generated credentials**"、CasaOS 精选/图标/widget。ComposeOps blueprints 已有 envSchema/`secret:true`/端口冲突预检(`app-blueprints.js:66`),缺分类图标,且装完无收尾三件套:访问 URL 卡片、自动生成的强密码(显示一次/一键复制)、健康检查通过前"启动中"态。
- **X-12 存储回收信息密度**:lazydocker(镜像祖先层、可回收预估)。ComposeOps 已有 `getSystemStorageDf`+`pruneStorage`+三态标签(`ResourcesView.vue:128-168`),缺 prune **前** dry-run 清单(按类别列可回收 MB)与后 reclaimed 明细(现在只记一个 reclaimedMB 数)。

### 可直接照搬的交互范式(低成本高确定性)

- **Portainer 栈编辑器**:Version 下拉取历史版本直接替换编辑器内容;"Prune services" 显式开关(编辑删服务时强制确认);Git 栈只给"拉最新 commit + Re-pull and redeploy"复选框——三点都比 ComposeOps 现有"比较"更省决策成本(`ComposeView.vue` 版本下拉 + 保存弹窗加 prune 确认)。
- **Komodo 变量插值 `[[KEY]]`**:双括号显式标记引用,UI 一眼辨引用 vs 字面量;secret 语义="更新/日志中永不出现"(与 `secret-redactor.js` 语义对齐),比掩码显示更硬。给 `ProjectEnvModal.vue` 加引用语法。
- **Coolify env 行内 flag 注释**(buildtime/runtime 作用域区分):ComposeOps env 编辑器可吸收一层"作用域"信息。
- **Beszel 加服务器**:hub 生成 token → 粘贴一行 curl/systemd 安装命令 → 自动上报,比手填 SSH 密钥/指纹摩擦小得多(SSH 节点向导可借形态)。
- **Uptime Kuma 状态条分组**:同 key 告警折叠成一行(count+first/last)而非平铺——`EventTimeline.vue` 现五路事件平铺;`guardian.js` 已有 key 冷却逻辑可直接复用做分组键。
- **Dokploy 部署队列**:排队中的部署可取消入队(在跑的不取消)——`compose-runner`/`project-operation-lock` 场景最便宜的防抖动交互。

### 差异化定位(执行 agent 必读,防止把优势改没了)

同类自动化是"规则与 desired-state 驱动、人点按钮";ComposeOps 是"AI 工具循环 + 确认门 + 策略/操作锁"——agent 是带审批的 operator 而非 scheduler。**X-04/X-05 这类收敛/批量动作应挂在现有确认门后面,不要另建规则引擎。**
四项领先或持平于对标产品,改造时不得回退:①7 个通知渠道含 bark/wecom/dingtalk/feishu(同类普遍只有 telegram/slack/discord/gotify);②`verifyVolumeBackup`+`recovery:drill` 恢复校验意识;③容器状态转换推算可用率(`state-history.js`,Uptime-Kuma 模型);④compose/env 双栏 diff 预览。

---

## E. 执行批次与验证门(交给执行 agent 的操作纪律)

**波次划分**(每波一个 agent 串行;波内可并行独立小项):

| 波次 | 内容 | 前置 | 验证门 |
|---|---|---|---|
| 1 快速修复(半天) | U-14、U-18、L-03、U-12、U-19、U-15、U-16、U-17、L-11 死方法删除、B-07、B-08 | 无 | `npm run build` 零 Warning + 前后端单测全绿 + cops-uxtest 回归脚本 |
| 2 联动闭环(1-2 天) | L-01、L-02、L-05、L-06、L-08、L-13、L-15、L-17、U-05、U-04、U-06 | 波次 1 | 新增:data-changed 事件契约测试;keep-alive 激活/失活 hook 存在性测试(AGENTS.md 要求) |
| 3 多宿主与一致性(2-3 天,风险最高) | B-01→B-04→B-05→B-02→B-03→B-06 顺序执行 | 波次 1 | 双假宿主测试套件(新建);迁移脚本 dry-run;`DB_PATH=/tmp/x.db` 后端全绿 |
| 4 设计系统清债(1-2 天) | U-01、U-02、U-03、U-07(先 IA 决策)、U-08、U-09、U-10、U-11、U-13 | 波次 2(组件/文案通道先就位) | 对比度脚本 + grep 清剿清单 + view 冒烟测试 |
| 5 产品化差距(按 roadmap 取舍) | L-04、L-07、L-09、L-10、L-12、L-14、L-16、L-18、B-09…B-17、X-01…X-12 + "照搬范式"清单 | 波次 2+3(确认门/事件通道/每节点采集器是 X-02/03/04/10 的依赖) | 每项独立验收标准见条目;改造时对照"差异化定位"节防止回退四项优势 |

**硬纪律(违反会返工)**:
1. 改 `backend/src/lib/dotenv.js` / `agent-protocol-core.js` 必须同步前端对应文件,字节一致 sync 测试兜底(AGENTS.md)。
2. 只在仓库根 `npm install`;不再生成 workspace 内 lockfile。
3. 后端测试必须 `--test-concurrency=1` + `DB_PATH=/tmp/x.db`。
4. 任何新页面进 keep-alive 白名单必须同时实现激活/失活资源生命周期(AGENTS.md 明文)。
5. 端口 28765、双 compose 文件、`composeops_opsdash-data` 卷不许动。
6. B-01 迁移类改动必须带数据备份与回滚演练,先在副本库验证再动生产库路径。
