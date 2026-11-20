# ComposeOps 全功能验收（2026-11-20）

本次覆盖已登记的 26 个页面、259 个 HTTP 路由记录，以及部署、恢复、远程节点、AI 执行与审批等关键流程。这里的“全功能验收”指按模块和风险场景完成验收矩阵，不代表穷尽任意数据、外部平台及所有故障组合。

本机证据根目录：`~/.local/state/composeops/acceptance/2026-11-20-full/`。日志包含运行时间、命令、退出码；失败与重试证据保留。发版证据另存 `~/.local/state/composeops/releases/2026-11-20-full-acceptance/`。凭据、数据库备份与浏览器会话不进入 Git。

## 本轮修复

- Docker 节点探测持久化观察值；编辑、删除和并发探测期间迟到响应不覆盖新状态，本机节点同样适用。离线容器数显示未知，恢复后清除旧错误。
- 节点连接检测及平台健康检查到期取消真实网络连接，避免挂起请求累积。
- 设置页正确显示检测失败原因，错误提示保留读屏播报语义。
- AI 环境快照固定扫描节点，切换期间丢弃迟到结果；管理权限和项目数量限制每次重新应用。
- 成本采样最多并发 6 个容器，相同请求合并；报告及趋势按节点隔离，前端切节点/离页后拒绝旧响应。部分指标失败有明确提示，存储读取失败返回错误。
- 成本镜像容量使用实际层占用，可回收空间扣除仍被引用的唯一层；慢磁盘统计保留真实取消能力并给予 30 秒期限。
- 浏览器测试不再静默复用其他工作树的预览服务；自定义端口贯穿服务器与离线网络断言。

## 验收矩阵

| 模块 | 验收方式与结果证据 |
|---|---|
| 登录、鉴权、Origin、注销 | `full-http-v6`：575 次真实 HTTP 请求；所有注册受保护 API 拒绝未登录请求，所有写 API 拒绝外站 Origin；普通会话不能替代 MCP、平台监测、OTLP 专用凭据 |
| 26 页与设置/可靠性标签页 | `production-pages-v2`：已登录正式环境，桌面及手机各 44 个上下文，共 88 次观测，无捕获页面异常及横向溢出；仅证明页面可达和基础渲染 |
| 跨浏览器交互 | Chromium、WebKit 的桌面及移动端完整预览套件；审批、失败重试、焦点、Esc、表单、终端、日志、配置、历史、窄屏等；使用离线接口适配器，不冒充真实后台写入 |
| 节点、监控、拓扑、资产、成本 | 单测、页面交互、真实读取；节点超时真正关闭 socket，双节点交错响应回归，成本并发/隔离/容量公式回归 |
| 远程 Docker | `remote-node-v2`：实际 OpenSSH、SFTP、Docker dial-stdio、远程 Compose、主机指纹拒绝；双向 TLS 连接、无客户端证书拒绝、API-only 节点只读。隔离回环环境，不添加生产节点 |
| Compose、服务控制、变更回退 | `reviewed-deployment-integration`、`compose-recovery-integration`、`container-recovery-smoke`：真实 Docker，配置审核、生命周期、失败补偿及多文件回退 |
| 存储、卷备份恢复与清理 | `volume-backup-service-integration`、`resource-cleanup`：原卷内容/权限/隐藏文件/链接保护、损坏备份拒绝、停止容器引用保护、错误节点拒绝删除 |
| 市场、蓝图、数据库服务 | `blueprint-deployment-integration`、`database-service-integration`：真实 Compose 部署与服务验收；HTTP 自定义模板增改删、收藏与搜索 |
| AI 值守与可靠性 | `incident-recovery-integration`、`sre-autonomy-integration`、`sre-delivery-integration`：真实故障、授权、恢复验收、结果复盘 |
| 应用发布 | `application-release`：三个实际 HTTP 服务按依赖更新，中途失败阻止后续服务，获授权后反序回退；再验证完整成功发布 |
| 工作流、工单、计划任务 | 真实 HTTP 持久化：审批等待/批准/重复批准拒绝、运行中删除拒绝、工单幂等和非法终态拒绝、Cron CRUD/非法表达式；配合对应状态机与界面测试 |
| GitOps、日志、终端、操作中心 | 现有自动化覆盖配置校验、同步/漂移/回退、流式结果、断连未知态、历史、搜索与资源释放；镜像 CI 再跑实际 Docker 项目工作台和终端 |
| Agent 模型和工具链 | `agent-live-web`：真实配置模型，搜索→打开 Docker 官方正文→带来源回答；临时 DB、空 Docker 节点，只暴露两个只读联网工具，无生产项目上下文 |
| Agent 稳定性与权限 | `agent-soak`：5 分钟、4 客户端、慢读/断连及收尾资源检查，模型为确定性替身；另由全量后端测试覆盖并发执行、策略 deny、critical 确认、审计与持久队列 |
| 业务恢复、平台监测、诊断评测 | 复用同日已部署基线 `628ba31` 的实际三数据库业务恢复、加密备份、独立监测及真实模型诊断证据；这些模块本轮没有改动，证据位于上一轮发版目录 |
| 安装、升级、加密、恢复 | 发布镜像本机与 CI 门禁，支持基线升级/回退、全新安装、在线备份、加密恢复及 ARM64，正式数据库副本另行启动验证 |

## 本机结果

- 后端 797 通过、1 跳过；前端 954 通过；lint 通过。
- 全量浏览器首次 968 通过、41 失败、11 跳过。38 项失败来自自定义端口未同步到网络断言，3 项为 WebKit 超时；保留完整原始失败记录。
- 修复后重跑相关 5 组文件、四种浏览器/设备组合：214 通过、6 跳过，覆盖上述全部失败及节点设置修复。其余完整套件结果沿用首次通过证据。
- 正式在线加密备份完成源库/副本校验，备份大小 2,121,646,080 字节。
- 精确提交的远端 CI、镜像和上线结果存入发版目录，不以文档创建时间假定已部署。

## 可重复运行

```sh
npm ci
npm run lint
npm test
npm run build
npm run build:preview --workspace frontend
PREVIEW_PORT=4187 npm run test:preview --workspace frontend
node scripts/full-http-acceptance.mjs
node scripts/remote-node-acceptance.mjs
node scripts/release-acceptance.mjs --run-isolated-fixtures
# 真实模型需显式启用，配置文件仅放仓库外并设为 0600：
ACCEPTANCE_AI_CONFIG=/private/config.json node scripts/agent-web-acceptance.mjs --run-live-model
```

远程节点脚本需本机 OpenSSH server、openssl、ssh-keygen 及 Docker，使用唯一临时项目并自行清理。模型配置 JSON 为 `{ "ai": { ... }, "search": { ... } }`，只发送公开文档验收问题，可能产生正常模型调用费用。

## 边界与暂缓项

- 外部告警接收渠道按用户要求暂缓；没有宣称飞书、企业微信、钉钉、邮箱等通知送达成功。
- `172.16.100.28` 部署的是独立平台监测服务，并未加入 Docker 节点列表；正式外部机器全盘断电未人为实施。
- SSH/TLS 实测为隔离回环传输，无法代替每一种实际防火墙、代理或异构远端发行版。
- 真实模型联网证明本次调用成功；不能保证第三方搜索、模型渠道永远可用。
- 原工作区的未提交 AI 搜索相关性修改、Compose 修改与旧跟踪文档保持原样；本轮不将其顺带提交。
