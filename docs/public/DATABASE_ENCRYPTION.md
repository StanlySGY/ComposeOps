# SQLite 数据库静态加密

ComposeOps 默认兼容现有未加密安装。静态加密是显式启用项：密钥必须独立存储，不能放进项目目录、SQLite 数据卷或数据库备份旁边。密钥丢失后，加密数据库无法恢复。

## 1. 在数据卷以外保存密钥

在 Docker 宿主机执行一次：

```sh
install -d -m 700 "$HOME/.config/composeops"
umask 077
openssl rand -hex 32 > "$HOME/.config/composeops/db-encryption-key"
chmod 600 "$HOME/.config/composeops/db-encryption-key"
```

请将密钥纳入独立的受控密钥备份，并限制能读取它的账号。不要把密钥内容粘贴进工单、日志或 Git。只备份 SQLite 文件而不备份密钥，无法构成可恢复备份。

## 2. 首次启用或迁移现有安装

先用当前版本创建一份在线一致性备份，并将其复制到数据卷以外的受保护目录：

```sh
umask 077
docker exec opsdash node scripts/database-backup.js --output /tmp/composeops-before-encryption.db
install -d -m 700 "$HOME/.local/share/composeops-recovery"
docker cp opsdash:/tmp/composeops-before-encryption.db "$HOME/.local/share/composeops-recovery/opsdash-before-encryption.db"
chmod 600 "$HOME/.local/share/composeops-recovery/opsdash-before-encryption.db"
docker exec opsdash rm -f /tmp/composeops-before-encryption.db
```

第一次切换前，这份备份是**未加密的敏感数据**；将它留在受保护的离线位置。加密迁移、登录和数据读取验证都完成后，再依据备份保留策略处理它。不要把备份放回 Docker 数据卷。

在切换前运行只读迁移前审计。它会检查当前数据库与备份的 SQLite 完整性、schema/迁移版本、核心表计数、密钥格式与权限，以及密钥/备份是否真正分开存放；失败时不要继续切换。该检查不修改数据库，也不会输出密钥：

```sh
node backend/scripts/database-readiness-audit.js --db="$DB_PATH" --backup="$BACKUP_PATH" --key-file="$KEY_FILE"
```

请把 `DB_PATH`、`BACKUP_PATH` 和 `KEY_FILE` 替换为本机可访问的实际路径。备份文件需为 `0600` 或更严格、所在目录需为 `0700` 或更严格；密钥与备份要位于相互分离的目录树。审计成功只表示具备受控迁移的前置条件，不等同于迁移后加密验证或恢复演练通过。

导出密钥路径，并通过加密 overlay 重建服务：

```sh
export COMPOSEOPS_DB_ENCRYPTION_KEY_FILE="$HOME/.config/composeops/db-encryption-key"
docker compose -f docker-compose.yml -f docker-compose.encrypted.yml build opsdash
docker compose -f docker-compose.yml -f docker-compose.encrypted.yml up -d --force-recreate opsdash
```

启动时，应用会把原有数据库架构、表数据、索引、视图、触发器、BLOB、迁移版本和自增序列复制到同目录的加密临时文件；通过完整性校验后才原子替换原数据库。失败时不会用不完整文件替换原库。迁移会占用额外磁盘并延长启动时间；大数据库需安排维护窗口并确认剩余空间。即使自动迁移保留原文件直到切换成功，也仍应先创建独立备份。

检查服务健康、能登录并读取 AI 配置/历史记录，再查看加密状态：

```sh
docker compose -f docker-compose.yml -f docker-compose.encrypted.yml ps
docker exec opsdash node scripts/database-encryption.js status --db /app/backend/data/opsdash.db
```

启用后**始终同时使用两个 Compose 文件**；每个需要执行 Compose 命令的 shell 都要设置 `COMPOSEOPS_DB_ENCRYPTION_KEY_FILE`。如果省略 overlay，容器将缺少密钥挂载；对已加密数据库，应用会拒绝启动，不会降级为明文。

## 3. 离线密钥轮换

轮换必须在停机窗口执行。先将数据库与新旧密钥分别备份到受控位置，确认新密钥已进入独立密钥保管系统，然后创建新密钥文件：

```sh
umask 077
openssl rand -hex 32 > "$HOME/.config/composeops/db-encryption-key.next"
chmod 600 "$HOME/.config/composeops/db-encryption-key.next"
export COMPOSEOPS_DB_ENCRYPTION_KEY_FILE="$HOME/.config/composeops/db-encryption-key"
docker compose -f docker-compose.yml -f docker-compose.encrypted.yml stop opsdash
docker run --rm --volumes-from opsdash \
  -v "$HOME/.config/composeops/db-encryption-key:/run/secrets/old-key:ro" \
  -v "$HOME/.config/composeops/db-encryption-key.next:/run/secrets/new-key:ro" \
  --entrypoint node stanly1997/opsdash:latest \
  scripts/database-encryption.js rotate \
  --db /app/backend/data/opsdash.db \
  --old-key-file /run/secrets/old-key \
  --new-key-file /run/secrets/new-key \
  --confirm-stopped
```

维护容器复用已停止的应用容器的数据卷。轮换过程会校验旧密钥、导出到临时文件、切换密钥并完整性校验，然后原子替换数据库。不要对仍被应用或其他进程打开的数据库执行轮换。

轮换完成后，更新运行时密钥文件并启动应用：

```sh
mv "$HOME/.config/composeops/db-encryption-key.next" "$HOME/.config/composeops/db-encryption-key"
chmod 600 "$HOME/.config/composeops/db-encryption-key"
docker compose -f docker-compose.yml -f docker-compose.encrypted.yml up -d opsdash
```

在应用启动、登录、历史记录及备份/恢复验证通过之前，保留受保护的旧密钥与数据库备份。通过完整验收和保留期后，再按密钥销毁流程清理旧副本。旧密钥不能解开已轮换数据库。

## 4. 加密备份与恢复

当数据库进程配置了 `DB_ENCRYPTION_KEY_FILE` 时，`backend/scripts/database-backup.js` 的独立快照会保持加密状态，并在写入后检查完整性：

```sh
docker exec opsdash node scripts/database-backup.js --output /tmp/opsdash-encrypted-snapshot.db
docker exec opsdash node scripts/database-backup.js --verify /tmp/opsdash-encrypted-snapshot.db
```

备份从容器拷到宿主机或异地存储后，应限制访问权限。恢复到新卷时，必须先准备同一密钥的受控副本，再使用加密 overlay 启动应用。不要先以不含密钥的版本打开加密文件。

## 5. 恢复演练（不会修改在线数据库）

恢复前先确保加密快照和密钥分别存储，二者都在仓库目录之外；密钥文件应为 `0600`，密钥目录应为 `0700`。可对现有加密快照进行只读来源校验，并将其复制到一次性临时目录，使用外置密钥打开副本、执行完整性检查、核对 schema、迁移版本及核心表行数。演练退出时自动删除临时副本；在线数据库、备份和密钥都不会被改写。

```sh
install -d -m 700 "$HOME/.local/share/composeops-recovery/reports"
npm run recovery:drill -- --backup="$HOME/.local/share/composeops-recovery/opsdash-encrypted-snapshot.db" --key-file="$HOME/.config/composeops/db-encryption-key" --report-file="$HOME/.local/share/composeops-recovery/reports/recovery-drill-$(date +%Y%m%d-%H%M%S).json"
```
报告使用 `0600` 权限创建，且不会包含密钥内容。演练会拒绝明文数据库、错误密钥、权限过宽的密钥文件、仓库内备份，以及与备份位于同一目录树的密钥。它验证的是**当前机器上的可恢复性**，不能代替异地副本、独立密钥托管、另一台主机上的恢复或正式灾难恢复时间目标验收。

## 安全边界

- 加密保护 SQLite 主数据库文件的静态内容；运行中的进程仍会在内存中访问解密后的数据。
- 密钥通过宿主机只读挂载提供，与 SQLite 数据卷分离；拥有 Docker Socket/root 权限的宿主机管理员仍可能读取正在运行的进程及其密钥。
- 应用在缺少密钥时拒绝打开具有非标准 SQLite 文件头的数据库，避免静默降级；仅凭文件头不能区分加密文件与损坏文件。
- 加密文件、密钥与备份需分开保管，并定期演练恢复。不要在数据库仍被其他进程访问时运行离线加密或轮换工具。
