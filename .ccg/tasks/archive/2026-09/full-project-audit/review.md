# ComposeOps 全项目产品、技术与工程质量审查

审查对象：`/home/sgy/workspace/ComposeOps`

审查日期：2026-09-26

审查范围：前后端一方源码、配置、路由、数据库迁移、静态资源、测试、CI 和项目文档。`node_modules`、构建产物、数据库文件和截图仅用于验证，不作为源码设计依据。

## 结论速览

| 维度 | 结论 | 说明 |
| --- | --- | --- |
| 项目概览 | 良好 | 定位清楚，单用户 Docker Compose 运维台的主链路完整，目录和技术栈边界清晰。 |
| 后台 UI/UX | 良好 | 暗色工业风、状态色、响应式和反馈组件一致；信息架构、节点切换刷新和流式页面生命周期仍有明显问题。 |
| 功能逻辑 | 一般 | 认证、项目纳管和 Compose 文件边界较扎实，但工作流、跨节点备份和远程 Compose 执行存在会改变结果的缺陷。 |
| 完整度 | 一般 | 核心运维链路可用，但社区市场为空实现，工作流编辑器和若干维护策略仍是半成品或契约断裂。 |
| 代码质量与安全 | 一般 | 有集中认证、路径校验、脱敏和 XSS 防护；异步资源清理、输入契约和 lint warning 数量需要治理。 |
| 性能与可扩展性 | 一般 | SWR、缓存和后台任务有基础；2 秒全量指标采集、全量路由预取、缺少分页及跨节点抽象会限制规模。 |

总体评分：**6.6 / 10**。工程基础和安全意识明显高于原型，但关键运维动作仍有“状态显示成功、实际执行未停止/执行错节点/结果被覆盖”的风险，发布前应先修复 P1。

## 一、项目概览：良好

### 定位与目标用户

README 明确将产品定义为个人服务器使用的单用户 Docker Compose 运维面板，并明确不支持多租户和团队协作，见 `/home/sgy/workspace/ComposeOps/README.md:25-27`。核心用户是拥有 Docker 主机、需要集中查看和操作多个 Compose 项目的个人运维者，而不是企业 RBAC 场景。Docker Socket 等价 root 的边界也被文档明确说明，见 `/home/sgy/workspace/ComposeOps/README.md:250-256`。

产品主链路是“发现项目 -> 显式纳管 -> 查看状态/日志 -> 编辑 Compose 或环境变量 -> 执行操作 -> 查看操作记录/回滚”，并扩展到 AI Agent、备份、GitOps、巡检和工作流。README 的功能清单见 `/home/sgy/workspace/ComposeOps/README.md:74-173`。

### 技术栈

- 前端：Vue 3、Vite 5、Pinia、Vue Router、Tailwind CSS、Lucide、Monaco、xterm、Marked、DOMPurify，依赖清单见 `/home/sgy/workspace/ComposeOps/frontend/package.json:14-40`。
- 后端：Node.js 22 ESM、Fastify、`@fastify/websocket`、better-sqlite3、dockerode、ssh2、nodemailer、YAML，见 `/home/sgy/workspace/ComposeOps/backend/package.json:15-30`。
- 数据库：SQLite；认证、AI 会话、操作记录、指标、备份、CMDB、事件和工作流均通过迁移演进，迁移入口和版本说明见 `/home/sgy/workspace/ComposeOps/backend/src/lib/db.js:163-180`，当前测试覆盖到 v11。
- Docker 集成：dockerode 用于 API 操作，Compose CLI/工作区 runner 用于配置和生命周期操作；主机节点支持 local/TCP/SSH，见 `/home/sgy/workspace/ComposeOps/backend/src/services/docker-hosts.js:154-219`。

### 目录与工程组织

仓库使用 `frontend/`、`backend/`、`docs/`、`.github/` 和任务目录分层，后端路由、服务、lib、测试分开，前端 views、components、composables、stores、api 分开。当前一方文件约 281 个，其中后端源码 93 个、前端源码 104 个、测试 43 个，规模与模块化程度匹配。

主要组织风险不是目录混乱，而是部分功能契约分散在多个注册表：例如工作流节点配置在后端引擎、前端表单和数据库 JSON 之间没有共享 schema；Agent 前置检查又独立维护了一份参数名称，见 `/home/sgy/workspace/ComposeOps/backend/src/services/agent-tool-categories.js:211-228`。

## 二、后台 UI/UX：良好

### 视觉、排版与组件一致性

视觉基础样式集中在 `/home/sgy/workspace/ComposeOps/frontend/src/style.css:6-83`，统一定义画布、面板、文字、状态色和品牌色；通用按钮、输入、卡片、页面标题和工具栏定义在 `/home/sgy/workspace/ComposeOps/frontend/src/style.css:219-267`。这使按钮、输入框、卡片、状态反馈在各页面基本一致，颜色也能表达成功、警告、失败和信息状态。

移动端安全区、底部导航、弹层层级和焦点样式已有明确实现，见 `/home/sgy/workspace/ComposeOps/frontend/src/style.css:85-184`。现有桌面和移动截图也显示主面板、设置页、抽屉和底部导航基本可用：`/home/sgy/workspace/ComposeOps/artifacts/ui-regression-dashboard-mobile-final.png`、`/home/sgy/workspace/ComposeOps/artifacts/ui-regression-settings-desktop-final.png`。

日志文本虽然使用 `v-html`，但先转义 HTML 后只替换固定关键字，见 `/home/sgy/workspace/ComposeOps/frontend/src/components/logs/LogLine.vue:70-74`；Agent Markdown 还经过 DOMPurify，见 `/home/sgy/workspace/ComposeOps/frontend/src/lib/agent-markdown.js:1-8` 和 `:382-387`。这是较好的安全和可读性折中。

### 信息架构与操作效率

桌面主导航只保留总览、服务、配置、日志、AI 助手、设置，见 `/home/sgy/workspace/ComposeOps/frontend/src/components/AppSidebar.vue:63-70`；但另外约 15 个拓扑、CMDB、终端、巡检、变更、监控、市场、任务、工作流、事件、定时、GitOps、存储和成本模块全部进入“更多”，见 `:71-90`。这对重度运维用户增加发现成本，建议按“服务/配置/观测/自动化/系统”分组，而不是继续堆叠入口。

节点切换后 Header 只广播事件，项目列表只在挂载时读取，见 `/home/sgy/workspace/ComposeOps/frontend/src/components/AppHeader.vue:186-204`。因此项目下拉和命令面板可能继续显示旧 Docker 节点的项目，直到整个 Header 重建。

数据卷备份界面在远程节点记录存在时只显示本地下载链接，见 `/home/sgy/workspace/ComposeOps/frontend/src/components/resources/VolumeBackupPanel.vue:40-49`。恢复有覆盖确认，见 `:58-59`，但远程备份下载体验不完整。

### 交互生命周期和响应式风险

App 的 keep-alive 白名单包含 `ShellView` 和 `AgentWorkflowView`，见 `/home/sgy/workspace/ComposeOps/frontend/src/App.vue:52-59`，与旁边“实时数据页不保活”的注释相矛盾。Shell 和 Agent 的主要清理分别放在 `onBeforeUnmount`，见 `/home/sgy/workspace/ComposeOps/frontend/src/views/ShellView.vue:78-81`、`/home/sgy/workspace/ComposeOps/frontend/src/composables/useAgentChat.js:384-389`。切页只触发 deactivated 时，WebSocket、SSE 或轮询可能继续占用资源。

正向方面，`useWebSocket` 支持主动关闭、指数重连和重连上限，见 `/home/sgy/workspace/ComposeOps/frontend/src/composables/useWebSocket.js:86-146`；页面也有空态、加载骨架、Toast、确认弹窗和错误条，交互反馈基础完整。

## 三、功能逻辑：一般

### 做得较好的部分

认证、Origin 校验、安全响应头和统一错误处理集中在 `/home/sgy/workspace/ComposeOps/backend/src/app.js:59-112`；密码使用 scrypt，Session 只存哈希 token，并使用 HttpOnly、SameSite Cookie，见 `/home/sgy/workspace/ComposeOps/backend/src/lib/auth.js:24-85`。项目控制前会检查 managed、mountEnabled、editable，见 `/home/sgy/workspace/ComposeOps/backend/src/services/project-action-runner.js:6-17`；Compose 文件还做 realpath 和项目目录边界校验，见 `/home/sgy/workspace/ComposeOps/backend/src/services/compose-runner.js:38-49`。

### P1 功能缺陷

1. **WebSocket Shell 失败路径泄漏会话槽位。** `activeExecSessions` 在 `/home/sgy/workspace/ComposeOps/backend/src/routes/ws.js:205-224` 登记，但 `container.exec()` 失败和 `exec.start()` 失败路径在 `:226-245` 只关闭 socket，没有调用 `teardown()`。反复触发 Docker 错误最多可占满 `MAX_EXEC_SESSIONS`，直到空闲定时器到期。

2. **Agent `compose.exec` 超时不会停止容器内命令。** `/home/sgy/workspace/ComposeOps/backend/src/services/tools/compose-tools.js:264-285` 用容器内 `timeout` 和外部 `Promise.race()`；外部超时只 reject，没有销毁 exec stream、停止 exec 或终止子进程。若容器没有 `timeout`，命令可以在请求失败后继续运行。

3. **工作流取消有竞态，取消状态可能被覆盖。** `/home/sgy/workspace/ComposeOps/backend/src/services/workflow-engine.js:98-128` 的节点循环没有检查取消标志；`cancelInstance()` 在 `:281-285` 只写数据库状态。正在执行的节点结束后仍可能进入循环结尾，把实例写成 `success`，或在异常时写成 `failed`。

4. **条件节点没有分支语义。** 工作流循环对 `definition.nodes` 全部顺序执行，见 `/home/sgy/workspace/ComposeOps/backend/src/services/workflow-engine.js:99-127`；条件节点只把结果写入 `context.conditionMatched`，见 `:162-166`，没有 true/false edge、跳过节点或分支目标。UI 文案声称支持“条件 -> Agent -> 审批 -> 执行”，实际条件不会改变后续执行路径。

5. **工作流编辑器无法配置可执行节点。** 前端只能编辑节点 ID 和类型，见 `/home/sgy/workspace/ComposeOps/frontend/src/views/WorkflowCenterView.vue:90-108`；新建默认 action 节点也没有 `projectId` 或 `action`，见 `:157-163`。后端 action 节点要求 `projectId` 并使用 `node.config.action`，见 `/home/sgy/workspace/ComposeOps/backend/src/services/workflow-engine.js:197-208`，所以 UI 创建的默认工作流运行时会失败。

6. **数据卷备份没有按记录宿主恢复、下载和删除。** 创建记录保存当前 `host`，见 `/home/sgy/workspace/ComposeOps/backend/src/services/volume-backup.js:143-165`；但恢复直接使用当前活动 Docker，见 `:180-195`，文件解析也用当前活动主机而不是 `record.host`，见 `:211-221`，远程下载 helper 同样使用当前活动 Docker，见 `:235-255`。切换节点后操作旧备份可能读错文件、读不到文件或把同名卷覆盖到错误节点。

7. **`volume.mount` 前置检查与真实参数契约不一致。** 检查器读取 `params.hostPath`，见 `/home/sgy/workspace/ComposeOps/backend/src/services/agent-tool-categories.js:211-225`；工具声明并使用的是 `source`，见 `/home/sgy/workspace/ComposeOps/backend/src/services/tools/config-tools.js:341-384`。当前调用进入前置检查时很可能直接返回 false，导致合法的挂载操作无法执行。

8. **多节点 Compose CLI 没有完整传递保存的凭据。** dockerode SSH/TLS 客户端会使用私钥、密码和 TLS 内容，见 `/home/sgy/workspace/ComposeOps/backend/src/services/docker-hosts.js:154-183`；但 Compose 子进程环境只设置 `DOCKER_HOST`，SSH/TCP 分支见 `:205-219`，没有注入 SSH 私钥/密码或 `DOCKER_CERT_PATH` 等 TLS 文件。远程 dockerode 操作和远程 Compose 文件/生命周期操作可能出现不一致。

9. **蓝图部署的 direct 写入模式可能把文件写进面板容器。** `/home/sgy/workspace/ComposeOps/backend/src/services/app-blueprints.js:106-128` 只要面板容器内 `mkdir('/projects/...')` 成功就选择 `direct`；随后 `:135-147` 将该路径交给 Compose，`runUp()` 在 `:156-168` 按 direct 子进程执行。默认 Docker Compose 配置没有挂载 `/projects`，见 `/home/sgy/workspace/ComposeOps/docker-compose.yml:58-69`，因此 Docker daemon 所在宿主机不一定能看到面板容器内的文件，部署可能失败或路径错位。

## 四、完整度：一般

### 已完成的主要能力

认证、项目发现/显式纳管、Compose 多文件编辑和备份、日志聚合、受限 Shell、环境变量文件、镜像升级/回滚、数据卷备份、数据库 Dump、定时任务、GitOps、AI Agent 确认门、事件中心、巡检、CMDB、指标和工作流均有实际路由、服务和测试，不是单纯静态页面。CI 也覆盖 lint、前后端测试、构建和 Docker 构建，见 `/home/sgy/workspace/ComposeOps/.github/workflows/ci.yml:9-118`。

### 半成品、占位与缺失

1. **社区模板市场是空实现。** `/home/sgy/workspace/ComposeOps/backend/src/services/marketplace.js:14-20` 明确返回 `[]`，而模板搜索和统计仍暴露 community 来源，见 `:193-235`、`:261-275`。应在 UI 中明确“尚未接入社区源”，或实现可验证的远程源、缓存、签名/信任策略。

2. **自定义模板创建和更新没有 YAML 校验。** AI 生成路径在 `/home/sgy/workspace/ComposeOps/backend/src/services/marketplace.js:81-85` 调用了 `validateYaml`，但用户直接创建/更新的 `:102-141` 没有调用。非法 Compose 可以入库，直到后续部署才失败。

3. **CMDB 文档承诺的卷和网络资产没有同步。** 文档说明统一 Host / Project / Container / Volume / Network，见 `/home/sgy/workspace/ComposeOps/backend/src/services/cmdb.js:13-17`；实际 `syncAssets()` 只同步 host、project、container，见 `:26-70`，没有 Docker volume/network 资产和对应关系。

4. **指标保留策略存在断裂。** 正常采集后台每小时直接调用默认 7 天删除的 `pruneMetrics()`，见 `/home/sgy/workspace/ComposeOps/backend/src/services/metrics-collector.js:156-187`；7-30 天聚合逻辑在另一个 `applyRetentionPolicy()` 中，见 `/home/sgy/workspace/ComposeOps/backend/src/services/metrics.js:309-355`，只由手动 API `/metrics/retention-policy` 触发，见 `/home/sgy/workspace/ComposeOps/backend/src/routes/metrics.js:257-267`。按设计应保留的 7-30 天历史在正常调度中不会聚合。

5. **监控时间范围和告警边界有问题。** 1 分钟/5 分钟视图的异常查询最少强制为 1 小时，见 `/home/sgy/workspace/ComposeOps/frontend/src/views/ResourceMonitorView.vue:307-315`；阈值为 `0` 时又被 `!alertForm.value.threshold` 当作空值拦截，见 `:343-349`。

6. **前端保留已删除端点的死 API。** `/home/sgy/workspace/ComposeOps/frontend/src/api/client.js:203-208` 的 `execContainer()` 请求 `/ai/exec`，而后端仅有 `/ai/logs` 等路由，见 `/home/sgy/workspace/ComposeOps/backend/src/routes/ai.js:103-133`。目前未发现实际调用，因此属于接口漂移和维护风险，不是当前主流程故障。

扫描到的 `return []` 大多是空数据兜底或空结果的合法语义，例如自定义模板解析失败；社区模板的 `return []` 则有明确注释“没有真实社区源”，应单独视为未完成功能，而不是把所有空数组都当作 mock。

## 五、代码质量与安全：一般

### 正向证据

- 全局 REST/WebSocket 认证和 Origin 检查集中，见 `/home/sgy/workspace/ComposeOps/backend/src/app.js:72-87`。
- SQLite 文件启动时设置 0600，见 `/home/sgy/workspace/ComposeOps/backend/src/lib/db.js:8-13`。
- AI 工具结果、执行参数和错误有脱敏落库逻辑，见 `/home/sgy/workspace/ComposeOps/backend/src/lib/db.js:794-832`。
- 个人数据导出明确排除 `ai.api_key`、密码哈希和通知配置，见 `/home/sgy/workspace/ComposeOps/backend/src/lib/db.js:1122-1134`；导入只接受有限设置字段，见 `:1137-1158`。
- 未发现仓库内硬编码的真实 API key、密码、私钥或 token；Compose 示例中的 `ADMIN_PASSWORD` 是注释占位，见 `/home/sgy/workspace/ComposeOps/docker-compose.yml:79-81`。

### 质量和安全风险

1. WebSocket 和容器 exec 的资源清理缺陷是当前最需要修复的工程问题，详见 P1-01/P1-02。它们不等于未授权访问，但会导致服务容量耗尽和后台命令残留。
2. 自定义模板、工作流节点和 Agent 前置检查各自维护输入契约，已有参数漂移证据，见 `/home/sgy/workspace/ComposeOps/backend/src/services/agent-tool-categories.js:211-228`。建议从工具注册元数据生成 schema 和前置检查，减少重复定义。
3. 两端 lint 都没有 error，但后端有 36 个 warning、前端有 49 个 warning；包括空 catch、未使用变量和 `vue/no-v-html` 提示。`LogLine.vue` 的 XSS 实际已转义，但应补充 lint 注释或改用安全渲染 helper，避免真实风险与工具噪声混杂。
4. 产品是单用户管理员模型，不应按企业 RBAC 缺失判定为 bug；但所有已登录用户拥有管理能力是产品边界，未来若扩展团队协作必须先引入角色/资源授权。

## 六、性能与可扩展性：一般

### 正向设计

API 客户端实现 12 秒 SWR 缓存和写后失效，见 `/home/sgy/workspace/ComposeOps/frontend/src/api/client.js:6-98`；后台任务、工作区 runner 缓存和空闲回收也已有实现，见 `/home/sgy/workspace/ComposeOps/backend/src/services/compose-workspace.js:13-16`、`:89-137`。Compose 项目操作使用项目锁，见 `/home/sgy/workspace/ComposeOps/backend/src/services/project-action-runner.js:19-59`。

### 性能和扩展问题

1. 生产启动每 2 秒对所有容器采集指标，见 `/home/sgy/workspace/ComposeOps/backend/src/index.js:35-38`。容器数量增长后 Docker API、SQLite 写入和单进程事件循环压力会线性增长，应采用采集批次、动态间隔、批量写入上限和按需采集。
2. 路由在空闲时预取全部页面 chunk，见 `/home/sgy/workspace/ComposeOps/frontend/src/router.js:44-53`；构建产物中 Monaco 主 chunk 约 2.30 MB，xterm 约 291 KB。低带宽或移动端首屏会额外消耗流量，建议只预取高概率页面，编辑器/终端按进入页面加载。
3. CMDB 拓扑一次取最多 2000 个资产和全部关系，没有分页或增量查询，见 `/home/sgy/workspace/ComposeOps/backend/src/services/cmdb.js:89-92`。资产数量增长后响应和前端图渲染都会变重。
4. 多节点能力把 Docker API、SSH 文件读写、Compose CLI 和本地路径模型混合在多个服务中。应统一 `HostContext`，所有备份、Compose、文件操作都显式传 hostId，避免依赖当前全局活动节点。

## 问题清单

### P0 严重

暂无已确认的 P0。当前未发现无需登录即可访问受保护 API、仓库内硬编码真实密钥或已确认的任意宿主路径越权；Docker Socket 等价 root 是产品部署边界，文档已明确，不单独列为缺陷。

### P1 重要

- P1-01 WebSocket Shell exec/start 失败不 teardown，会耗尽 20 个会话槽位：`backend/src/routes/ws.js:205-245`。
- P1-02 Agent `compose.exec` 外部超时不终止容器命令：`backend/src/services/tools/compose-tools.js:264-285`。
- P1-03 工作流取消可被完成/失败状态覆盖：`backend/src/services/workflow-engine.js:98-143`、`:281-285`。
- P1-04 条件节点只写 context，不产生分支或跳过：`backend/src/services/workflow-engine.js:99-127`、`:162-166`。
- P1-05 工作流 UI 无法填写 action/projectId/prompt/condition，默认 action 工作流不可执行：`frontend/src/views/WorkflowCenterView.vue:90-108`、`:157-163`；后端 `backend/src/services/workflow-engine.js:197-208`。
- P1-06 数据卷备份恢复/下载使用当前活动节点而非记录 host：`backend/src/services/volume-backup.js:143-165`、`:180-221`、`:235-255`。
- P1-07 `volume.mount` 前置检查读 `hostPath`，工具实际使用 `source`：`backend/src/services/agent-tool-categories.js:211-228`、`backend/src/services/tools/config-tools.js:341-384`。
- P1-08 远程 Compose CLI 只注入 `DOCKER_HOST`，未传递保存的 SSH/TLS 凭据：`backend/src/services/docker-hosts.js:154-219`。
- P1-09 蓝图 direct 写入可能只写入面板容器，随后交给宿主 Docker daemon：`backend/src/services/app-blueprints.js:106-168`、`docker-compose.yml:58-69`。

### P2 建议

- P2-01 社区模板永久返回空列表：`backend/src/services/marketplace.js:14-20`。
- P2-02 自定义模板创建/更新缺少 YAML 校验：`backend/src/services/marketplace.js:102-141`。
- P2-03 CMDB 同步缺少卷、网络资产：`backend/src/services/cmdb.js:26-70`。
- P2-04 指标 7-30 天聚合策略未接入正常定时清理：`backend/src/services/metrics-collector.js:179-187`、`backend/src/services/metrics.js:314-355`。
- P2-05 短周期异常检测至少查询 1 小时，阈值 0 无法创建：`frontend/src/views/ResourceMonitorView.vue:307-315`、`:343-349`。
- P2-06 前端死 API `/ai/exec`：`frontend/src/api/client.js:203-208`；后端路由证据 `backend/src/routes/ai.js:103-133`。
- P2-07 Shell/Agent 页面 keep-alive 导致切页不及时释放流：`frontend/src/App.vue:52-59`、`frontend/src/views/ShellView.vue:78-81`、`frontend/src/composables/useAgentChat.js:384-389`。
- P2-08 节点切换后 Header 项目列表不刷新：`frontend/src/components/AppHeader.vue:186-204`。
- P2-09 移动端/桌面端“更多”聚集过多运维模块：`frontend/src/components/AppSidebar.vue:71-90`。
- P2-10 2 秒全量指标采集、全量路由预取和 CMDB 2000 条上限会限制规模：`backend/src/index.js:35-38`、`frontend/src/router.js:44-53`、`backend/src/services/cmdb.js:89-92`。

## 可执行改进方案

### 第一阶段：先修 P1

1. 给 WebSocket exec 的 `exec()`、`start()`、stream error 和 socket close 统一包 `try/finally`，确保 `teardown()` 幂等执行；新增“连续 exec 建立失败后槽位仍可用”的路由测试。
2. 给 `compose.exec` 保存 `exec` 和 stream 句柄；超时先关闭 stream，再调用可用的容器终止/kill 机制，最后记录 `timed_out`。不能只依赖容器是否安装 `timeout`。
3. 为工作流实例增加取消版本号或内存中的 cancellation token；每个 await 前后检查状态，最终写 success/failed 时使用条件更新 `WHERE status = 'running'`，并为取消与慢节点增加竞态测试。
4. 将节点模型改为显式 `next`, `onTrue`, `onFalse` 或边表；前端按节点类型动态渲染 `action/projectId/prompt/expression`，后端保存前做必填校验。
5. 所有备份记录操作传入 `record.host`，使用 `getDockerForHost(record.host)` 和对应 host 的目录/远程 runner；UI 对远程备份提供下载、节点确认和“当前节点不一致”提示，恢复前显示目标节点。
6. 删除或修正 `volume.mount` 前置检查参数名，并让工具注册元数据成为唯一参数来源；远程 Compose 采用显式 SSH runner 或安全临时凭据文件，禁止把秘密拼进普通环境日志。
7. 蓝图部署统一走宿主可见的 workspace runner，或在选择 direct 前验证 `/projects` 是 Docker daemon 可见的同一路径；新增真实 Docker socket 下的部署冒烟测试。

### 第二阶段：补齐完整度和契约

1. 创建/更新自定义模板都执行 YAML 和 Compose 语义校验；市场 UI 将 community 标为“未接入”或接入带版本/签名校验的源。
2. 把 `applyRetentionPolicy()` 接入唯一的定时维护入口，保证 7 天原始、7-30 天 5 分钟聚合、30 天后删除的策略由测试验证。
3. 异常检测按前端 period 传递精确小时/分钟窗口；告警阈值使用 `threshold == null` 判断空值，保留合法 0。
4. 删除 `execContainer()` 死 API 或改为 `/ai/agent/execute-stream` 的实际能力；在 CI 增加生成式 endpoint 对照检查，避免 client 方法无后端路由。
5. CMDB 增加 volume/network 资产和关系，接口增加分页/按 host 增量同步。

### 第三阶段：体验、性能和工程治理

1. 从 keep-alive 排除 Shell、Agent、监控、任务等带流或定时轮询页面，使用 `onActivated/onDeactivated` 管理连接和轮询。
2. 节点切换统一刷新项目、命令面板、当前页面和缓存；SWR cache key 加 hostId，避免跨节点复用旧数据。
3. 将导航“更多”按观测、自动化、资源、系统分组；对高频任务保留一级入口，其余按分组折叠。
4. 指标采集改为批量事务、动态采样和上限保护；路由预取排除 Monaco/xterm 大 chunk，CMDB/事件/操作列表提供分页。
5. 清理 85 个 lint warning，优先处理空 catch、未使用变量和安全 lint 注释；为上述 P1 补充 Docker/mock runner 集成测试，而不仅是纯函数测试。

## 验证结果与剩余风险

- 后端测试：181/181 通过，命令：`DB_PATH=/tmp/composeops-audit-final.db npm test`。
- 前端测试：132/132 通过；测试期间有 Vue 生命周期/inject warning，但没有失败。
- 后端 lint：0 error，36 warnings。
- 前端 lint：0 error，49 warnings。
- 前端构建：通过；Monaco 主 JS chunk 约 2.30 MB，xterm chunk 约 291 KB。
- 未执行真实 Docker 多节点、SSH/TLS Compose、远程备份恢复和蓝图宿主可见性端到端测试；这些正是当前 P1 中需要在修复阶段补上的验证空白。

## 一句话总体评价

ComposeOps 已经是一个有真实运维边界、安全意识和较完整主链路的单用户 Docker Compose 面板，但工作流、跨节点数据保护和异步资源生命周期仍未达到可放心交给生产运维动作的成熟度。
