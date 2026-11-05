# ComposeOps 数据库备份与恢复

适用 1.5.0+，默认容器名 `opsdash`、数据库 `/app/backend/data/opsdash.db`。自定义 DB_PATH 时相应调整路径。备份包含管理员、会话、渠道密钥和历史，应按凭据文件保管；设置页 JSON 导出不能替代它。

## 在线备份

应用运行时可执行；使用 SQLite 在线备份 API，包含尚未 checkpoint 的 WAL 提交。不要直接复制运行中的 opsdash.db。

```bash
snapshot="opsdash-$(date +%Y%m%d-%H%M%S).db"
docker exec opsdash node scripts/database-backup.js --output "data/snapshots/$snapshot"
mkdir -p backups
chmod 700 backups
docker cp "opsdash:/app/backend/data/snapshots/$snapshot" "backups/$snapshot"
chmod 600 "backups/$snapshot"
docker exec opsdash node scripts/database-backup.js --verify "data/snapshots/$snapshot"
```

输出路径已存在时拒绝覆盖。请将备份加密复制到另一台设备，按自己的保留策略清理旧快照；CLI 不自动清理。完整性检查只证明 SQLite 结构可读，不证明外部业务数据可恢复。

## 恢复（需要停机）

先用上面的命令为当前状态另做一份备份。以下命令在安装清单所在目录执行，使用相同 Compose 项目名和已有数据卷。不要执行 `down -v`，不要在运行中的数据库上覆盖文件。

将选定快照复制到容器数据目录的暂存文件，并先校验：

```bash
docker cp backups/SELECTED.db opsdash:/app/backend/data/restore-candidate.db
docker exec opsdash node scripts/database-backup.js --verify data/restore-candidate.db
docker compose stop opsdash
```

服务停止后，用同一版本镜像的一次性容器校验、替换数据库并删除旧 WAL/SHM：

```bash
docker compose run --rm --no-deps --entrypoint node opsdash scripts/database-backup.js --verify data/restore-candidate.db
docker compose run --rm --no-deps --entrypoint node opsdash -e "const f=require('fs');f.copyFileSync('data/restore-candidate.db','data/opsdash.db');f.chmodSync('data/opsdash.db',0o600);for(const x of ['data/opsdash.db-wal','data/opsdash.db-shm'])f.rmSync(x,{force:true})"
docker compose up -d --no-build --wait opsdash
```

重新登录，检查渠道配置、项目授权和历史。恢复会回到备份时的密码和会话状态；若失败，保持停止状态，用恢复前快照重复步骤。确认成功后删除暂存文件。

## 其他数据

该文件不包含业务容器卷、宿主 Compose/env 文件或外置备份目录。为这些数据单独备份。ComposeOps 的命名卷备份是文件级 tar 快照：恢复会完整替换卷内容，备份时不存在的文件也会被删除；执行前会在临时卷验证归档，并在恢复期间保留原卷安全包。运行中的 PostgreSQL/Redis 等仍应使用数据库原生备份或可靠的停写流程；通用 tar 和归档校验不能证明数据库事务或跨服务数据一致性。

数据卷备份按每个项目/卷/宿主分别保留最近 20 份，只有新备份成功写入并登记后才清理超额旧包。若备份目录磁盘空间不足，当前任务会失败、清理未完成的临时归档并保留已有备份，不会为了腾空间自动删除旧恢复点；请先释放备份目录空间或调整 `backup.volume_dir` 后重试。远程 Docker 节点的空间需要在对应远端宿主检查。

## 自动检查

`scripts/image-smoke.mjs` 在独立容器与卷中验证首次设置密码、配置持久化、从 1.4.0 升级、在线备份及新卷恢复后登录。它不会覆盖真实实例数据。
