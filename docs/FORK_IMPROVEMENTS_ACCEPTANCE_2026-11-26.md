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
