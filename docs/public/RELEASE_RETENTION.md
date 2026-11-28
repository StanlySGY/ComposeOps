# 发布备份与构建缓存维护

发布前的完整数据库备份必须保留，但每次发布都永久留下完整副本，会迅速耗尽宿主磁盘。下面的工具在宿主执行，不需要数据库密钥，不连接 Docker，也不需要重启面板。

## 先预览，再按清单执行

```sh
node scripts/release-retention.mjs \
  --root=/outside/composeops-state \
  --plan=/outside/retention-plan.json \
  --keep=2 --min-age-hours=168

node scripts/release-retention.mjs --apply=/outside/retention-plan.json
```

预览文件必须为新文件，权限为 0600，有效期一小时。执行时重新计算清单指纹；备份、发布凭据、目录身份或保留标记变化后必须重新预览。默认保留最近两份，以及七天内的备份；`--keep` 不能小于 2。磁盘紧急处置可显式设置 `--min-age-hours=0`，这会删除同一天内的较早发布备份，需先核对清单。

只识别根目录下一层 `deploy-YYYYMMDD-name/database-before.tar`，且必须存在匹配的成功发布结果、版本记录和 SHA-256 文件。缺少凭据、发布失败、正在发布（`.deploying`）、符号链接、硬链接或未知命名都会保留。`data-volume-before.tar`、业务备份目录、线上数据库、密钥、日志、截图、回滚镜像不在清理范围。

在指定发布目录创建 `.retain` 可长期保留其备份。最新 `keep` 份备份的内容会逐一核对 SHA-256，全部通过后才允许删除任何旧备份；校验和只证明文件与记录一致，不替代解密恢复演练。

清理过程使用 `.release-retention.lock` 防止并发，并在根目录保存权限为 0600 的 `release-retention-*.jsonl`，逐项记录删除意图与结果。若进程异常退出，先确认没有清理进程运行，再核对审计记录及文件现状；不要盲目删除锁或重放旧计划。清理后旧发布目录保留元数据与验收证据，但对应已删除备份不能再用于回滚；SHA-256 文件可供历史审计，不能据此假设备份仍存在。

建议在每次发布完成健康检查、数据库验收及回滚备份验证后执行预览，把保留策略纳入发版收尾。工具不会自动创建定时删除任务。

## Docker 构建缓存

先读取本机版本、`docker buildx prune --help` 与 `docker system df`，确认支持的参数。构建缓存与业务镜像/卷分开处理：

```sh
# 只回收超过 24 小时未使用的构建缓存；后续构建可能变慢
docker buildx prune --filter 'until=24h'
```

当前 Buildx 还支持 `--reserved-space`、`--max-used-space` 和 `--min-free-space`。它们是缓存保留/空间目标，受年龄过滤及共享层影响，不保证释放指定大小。先查看实际输出，并以文件系统可用空间变化核实结果。无需为此执行 `docker system prune -a --volumes`，也无需删除已停止的业务容器。

本机 2026-11-28 已确认 Buildx v0.36.1 支持这些参数；其他节点以其实际帮助输出为准。官方资料（核查日期 2026-11-28）：

```text
https://docs.docker.com/reference/cli/docker/buildx/prune/
https://docs.docker.com/build/cache/garbage-collection/
```
