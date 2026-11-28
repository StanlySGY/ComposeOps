# 本机镜像验收补充（2026-11-29）

候选镜像 `composeops:overnight-security-20261129` 来自 `e2174079236c8162b2c634595152f818c1aec4cf`，镜像清单 ID 为 `sha256:2cdc64e6f5badc6ef2122e3b6b2186f1987afa445fbf35f4d2b00ad8fc38525c`。它验证该提交的运行依赖和导出修复，不代表后续回滚中心、时间线或数据库查询修改已经部署。

## 构建记录

前两次构建分别遇到桥接网络超时，以及 host 网络的 npm 官方 tarball 超时。日志均保留，没有记为通过。确认区域镜像的 tarball 能完整下载后，使用 host 网络、npm 区域镜像和 HTTPS apt 镜像构建成功，Dockerfile 未改。

## 本机实际验收

- 初次安装、认证、重启后状态持久化。
- 从本机保留的基线镜像 `sha256:2ab16de25aa309b9ab17a9ca333bfc799141c90f34861b1267f393b3ce8e1018` 升级，旧配置继续存在；在线备份恢复到新卷；使用升级前快照在另一新卷回退。
- 全新安装分支：独立 Redis/PostgreSQL 的 Agent 数据库探针，停止时不可用、重启后恢复且数据保留；命名卷备份/恢复内容和 SHA256 校验。
- 明文迁移到加密 SQLite、加密快照及使用外置临时密钥的新卷恢复，全部通过。

`scripts/image-smoke.mjs` 两种模式均成功。测试仅创建独立随机命名的容器、卷和临时密钥，并完成清理；生产 `opsdash` 健康，重启计数仍为 0。原工作区的 3 个已修改文件和 1 个未跟踪文件保持原状。

日志在 `~/.local/state/composeops/overnight-20261128/security-dependencies-image-build-*.log`、`security-image-upgrade-smoke.log`、`security-image-fresh-smoke.log`。
