# Fork 改进实现与验收（2026-11-26）

实现分支：`feat/fork-improvements-20261126`。基线：`eaff73df06e91f6ed80bf5c8be3ffd7da32f7c63`。

使用独立 worktree，未改动原工作区已有的 AI 搜索代码、测试及 Docker Compose 配置。本次未发布生产实例。

## 实现范围

| 改进 | 实现与边界 |
| --- | --- |
| 镜像更新检查 | 使用容器实际 ImageID，与对应平台的远端 config digest 比较；支持 Registry v2 Bearer 握手、摘要验证、独立代理和失败短缓存，保留主线发布评审。 |
| 访问入口 | TCP/UDP、HTTPS、IPv6、主机网络声明端口、多入口展示；按节点/项目/服务/端口保存路径，并用 revision 防止覆盖并发修改。 |
| 界面主题 | 深色默认、浅色、跟随系统；首屏初始化、浏览器保存、跨标签同步；编辑器、终端、图表及常用弹层适配。 |
| 完整备份 | 完整 Compose 范围预检，配置/env/构建引用、bind、命名和匿名卷、镜像与可写层；受控停机、加密归档、读回校验、原状态恢复和持久锁。 |
| 隔离恢复 | 固定 Engine/清单/父目录身份；新目录、新网络、无发布端口，默认创建停止的副本；可显式启动并检查健康，不覆盖原应用。保留环境变量和命令中的字面 `$`。 |
| 异地同步 | WebDAV 条件上传及下载 SHA256 校验；115 自有 Client ID/PKCE、令牌刷新、OSS 上传与 SHA1/长度校验；自动同步固定原备份节点。 |

数据库新增 v30（访问路径）及 v31（完整备份持久项目锁）。异常任务保留锁，显式恢复需要复核 Engine、容器身份和全部原运行容器健康；未知结果不会自动重放。

## 自动验证

- 后端全量：919 项，918 通过、1 跳过、0 失败，串行独立测试数据库。
- 前端全量：137 个文件，1007 项全部通过。
- 最后恢复序列化及弹窗改动后：恢复测试 4/4、运维页面测试 19/19；再次完成 lint 与生产前端构建。
- 浅色文字和状态色 AA 对比度、保持缓存页面停用/激活的轮询生命周期、实际运行镜像 A 与已移动标签 B 的更新检测均有回归覆盖。
- WebDAV 使用本地真实 HTTP 流式上传、下载、幂等和损坏拒绝测试；115 授权/刷新/OSS/校验使用协议桩测试。

主要命令：

```sh
DB_PATH=/tmp/composeops-final-backend.sqlite npm test --workspace backend
npm test --workspace frontend
npm run lint
npm run build
```

## Docker 实机演练

使用独立临时数据库、唯一 Compose 项目和临时目录，以及候选镜像 `composeops:fork-improvements-20261126`。候选镜像基于本机已缓存运行时加当前源码/依赖/构建产物，仅用于验收；未将它作为正式发布镜像。

可复现脚本：`scripts/fork-improvements-acceptance.mjs`。它要求唯一 `/tmp/composeops-fork-acceptance-<UUID>` 根目录和根目录内的测试 DB，拒绝其他路径。先在宿主使用 `BACKUP_FIXTURE_SETUP_ONLY=1` 准备目录，再在独立候选容器设置 `BACKUP_FIXTURE_PREPARED=1` 执行。根目录只读挂载，state/backups/restore 单独可写挂载；不能把测试应用的父目录以可写方式挂入其他容器。

演练确认：

- 三服务整体备份；原先停止的服务仍停止。
- 原命名卷、匿名卷、bind 文件和容器可写层均从备份恢复。
- HTTP 返回原数据，Redis key 值一致。
- 恢复副本的网络 internal、无原发布端口；compose.json 权限 0600。
- 包含 `$MISSING_VAR`、`${HOME}` 的真实容器环境值在恢复后逐字保留。
- 备份执行期间项目操作返回 PROJECT_BUSY，任务成功后可重新执行。
- 备份与隔离恢复成功后清理测试服务、卷和网络。

最后成功备份 ID：`4f6f5cdb-1022-496d-ac37-6232fd142400`；恢复任务：`f7b56323-a0cf-4e59-a17f-f8f0e8be9ed9`。

本机证据：`/tmp/composeops-live-acceptance-delivery.log`、`/tmp/composeops-backend-final.log`、`/tmp/composeops-frontend-final.log`、`/tmp/composeops-lint-delivery.log`、`/tmp/composeops-build-delivery.log`。

## 浏览器验收

Chromix 实际浏览器，1440×1000 和 390×844：默认深色、浅色、跟随系统、刷新持久化、设置面板与侧栏配色、移动端无横向溢出及恢复弹窗在视口内。通过真实 API 保存 `/proof/` 后，服务卡片链接即时更新。读取真实加密备份并展示完整恢复路径映射，确认按钮保持人工确认门。

已修复实测发现的浅色旧硬编码配色，以及恢复弹窗内错误不可见的问题。

## 验证限制

- 115 真实账户授权、配额和公网上传尚未验证；外部 WebDAV 服务商的账号与配置也需接入后测试。界面提供连接测试，未通过测试不能开启自动同步。
- 隔离副本启动/健康通过不等于生产业务 SQL/HTTP 恢复验收；主线可靠性页面的业务恢复演练保持独立。
- 完整备份执行器目前支持本地 Linux Docker；远端 SSH/TCP 节点不伪报支持。
- 备份目录 catalog 由单面板进程写入，运行多个面板实例共享同一状态目录不受支持。

使用说明：`docs/public/FULL_BACKUP_OPERATIONS.md`、`docs/public/APPLICATION_ACCESS.md`、`docs/public/THEMES.md`。实现借鉴 black210/ComposeOps 固定提交 `d39f14dcd5bda9585765a01da5c761dd008d0db5`，未整分支合并。

## 继续复测与上游检查（2026-11-27）

### 上游状态

在独立实现 worktree 执行 `git fetch origin --prune` 和 `git pull --ff-only`，返回 Already up to date。`origin/main` 仍为 `eaff73d`（2026-11-25），当前分支已包含它。

另行拉取此前借鉴的 `black210/ComposeOps` 两条分支，只建立远端引用供比对：`main` 为 `819c39c`（2026-11-03），`codex/full-backup-restore` 为 `d39f14d`（2026-11-16），后者与上次参考提交完全相同。因此本轮没有新的上游功能需要合并。查询结果保存在 `artifacts/retest-20261127/origin-head.txt` 与 `fork-heads.txt`。

### 实际发现并修复

1. **异常备份恢复中途停止**：某个原运行容器启动或健康检查失败时，旧代码会跳过后续容器。现在先核对全部容器身份，再逐个尝试启动、汇总验收结果；失败仍保留日志和项目锁，身份不符时全部拒绝启动。
2. **目录预检响应过期**：备份/恢复预检期间修改路径，迟到的旧结果曾重新开放确认。现在预检绑定输入版本，任何路径变化都会作废旧结果；提示重新预检，新预检完成后仍须确认。
3. **页面生命周期状态残留**：缓存停用时仅改变请求代次，未清除 busy/preparing，重新激活后可能无法继续操作。现在停止轮询和请求、清空节点操作上下文及确认门，重新加载当前节点。该用例覆盖 KeepAlive 下的停用/激活契约；当前 App 白名单未缓存 MaintenanceView。
4. **宿主机启动时后端退出**：未设置或清空 HOSTNAME 时，自身容器探测发送空 ID，Docker 返回重定向，docker-modem 的后续请求出现未捕获的 DNS 错误。本次真实浏览器触发过该进程退出。现在完整备份、工作区和传统卷备份均拒绝空身份探测；需要执行器镜像时返回明确配置提示。镜像探测失败不再被永久缓存，Docker 恢复后可以重试。
5. **运维页说明不准确**：移除“自动备份后更新整个应用”的旧文案，明确镜像检查、发布评审和完整备份是分别发起的操作。

同时扩充真实 HTTP 与 Docker 演练脚本，增加节点上下文、恢复确认令牌不可重放、默认停止副本、工作进程中断后的显式恢复等边界。恢复单测覆盖确认后 Engine、备份摘要、父目录 inode 改变，以及目标目录已存在时不修改资源。

### 上轮完整复测记录（2026-11-26）

以下为中断前的执行交接记录。恢复本轮时 `/tmp/composeops-retest-20261126-e7fe4776` 已不存在，不能再直接读取这些旧日志；未把旧结果冒充为 11 月 27 日重新执行的结果。端到端失败 trace 仍在 `frontend/test-results/`。

| 检查 | 上轮结果 |
| --- | --- |
| 后端全量（恢复修复后） | 921 项：920 通过、1 个显式启用的 Docker 卷备份集成测试跳过、0 失败 |
| 前端全量 | 137 个文件、1007 项通过 |
| Chromium / WebKit 桌面及移动端 E2E | 首轮 1007 通过、11 条适用条件跳过、2 失败；两条失败 trace 为 ERR_NETWORK_CHANGED，在停止并发 Docker 网络变更后各重跑 3 次，6/6 通过，未降低断言 |
| 真实 HTTP | 638 请求通过，包括全路由鉴权、写请求 Origin 拒绝及持久化流程 |
| 外部镜像仓库 | Docker Hub/GHCR token、manifest 和 linux/amd64 config digest 实查通过 |
| 官方 Dockerfile | 构建成功，含加密 SQLite 原生依赖；镜像内静态加密数据库及 v31 迁移验证通过 |
| 真实 Docker 完整备份与恢复 | 三服务、bind、命名/匿名卷、可写层、HTTP/Redis 数据、字面 `$`、网络隔离、0600 权限、默认停止副本、一次性确认通过 |
| 实际中断恢复 | 停机后 SIGKILL worker，确认无成功备份且保留锁；显式恢复后原运行/停止状态正确并释放锁 |

上轮中断任务 `2f011ad0-9803-4952-a0f8-99d981ab5062`，恢复任务 `a459d76d-4521-46dc-aab6-dfc256fac07d`，成功备份 `765feca3-1c2a-4564-9239-46ac67aef0de`，启动副本恢复 `f3c6da3b-36d6-4950-abe9-488d46b80447`。这些 ID 是历史定位信息，不代表仍保留可恢复文件。

### 本轮可读取证据

本轮日志、截图和 JSON 结果统一放在 worktree 的 `artifacts/retest-20261127/`（已被 Git 忽略，测试凭据不提交）。

- 前端相关测试：5 个文件、40 项通过，其中运维页面 22 项；新增 3 个异步回归用例修复前全部失败、修复后通过，分别见 `maintenance-races-before.log` / `maintenance-races-after.log`。
- 后端相关测试：80/80 通过，见 `backend-targeted.log`。自身容器探测新增的 5 个用例修复前全部失败、修复后通过，见 `docker-self-before.log` / `docker-self-after.log`；另加入传统卷备份空身份保护，与卷备份运行测试合计 13/13 通过，见 `docker-self-final.log`。
- 生产前端构建通过（`build.log`），最终 lint 与差异格式检查通过（`lint-final.log`）。
- 桌面浏览器使用当前源码的独立本地 HTTP 服务，读取专门构造的加密样例，经真实 Docker helper 认证与生成恢复映射；两项确认默认未选中，执行按钮禁用，见 `browser-preview-results.json`、`restore-preview-desktop.png`。样例只用于映射验收，没有执行恢复，不能将其算作业务恢复通过。
- 延迟真实后端预检响应，随后在浏览器更改目标目录，再释放旧响应：旧确认按钮不出现，弹窗提示重新预检，见 `browser-race-results.json`、`restore-stale-response.png`。
- 本地启动进程原始崩溃日志保存在 `browser-server-before-fix.log`；修复后相同的真实 API/浏览器预检完成，服务保持在线。
- 新增宿主机识别修复后，再跑后端全量：926 项，925 通过、1 项显式 opt-in 的 Docker 卷备份集成测试跳过、0 失败，见 `backend-full.log`。传统卷备份空身份补充用例在该轮发现测试文件之后才加入，另由上述 13 项针对性测试覆盖，没有计入 926。
- 当前版本真实 HTTP：638/638 请求通过，见 `http.log` 与 `http/result.json`，包括恢复/备份拒绝边界、目录浏览、全路由鉴权与 Origin 校验。
- 当前代码通过官方 Dockerfile 构建：`composeops:retest-20261127`，本地镜像标识 `sha256:426690d77e8006456183fb5c2560aea6917b1a87d9dff1ef9d4e7ac939183ccb`，见 `docker-build.log`。
- 最新镜像内加密数据库创建、读写、关闭后重新打开及 v31 表检查通过，文件头保持加密，见 `docker-encrypted-smoke.log`。首次冒烟脚本误用二进制密钥，被格式校验正确拒绝；改为文档规定的 64 位十六进制密钥后通过，原错误保存在 `docker-key-format-rejection.log`。
- 移动端 390×844 的恢复弹窗及长路径无横向溢出、两项确认默认未勾选，见 `browser-mobile-results.json`。Chromix 截图出现部分中文字缺字，切换到标准 Chromium 重验同一真实服务后中文完整显示，见 `restore-chromium-mobile.png`；未为测试浏览器的字体问题修改产品文案或样式。

本轮只做本地测试与修复。115 真实账户、公网 WebDAV 服务商、远端完整备份适配、多面板共享 catalog 等限制仍同上；不能据此宣称所有部署环境和灾难恢复场景均已验证。
