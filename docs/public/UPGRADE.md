# 升级与回退

本文针对固定镜像安装，从 1.5.1 升级到 1.6.0。源代码构建安装需要检出目标 tag 后重新构建镜像。保留原 Compose 项目名、端口、挂载和数据卷，不要运行 `docker compose down -v`。

## 1. 保存升级前状态

先完成 [在线数据库备份](BACKUP_RESTORE.md#在线备份)，把快照复制到容器和数据卷之外，并记录它对应的旧镜像版本。额外备份宿主 Compose/env 文件和业务数据卷；面板数据库不包含业务容器数据。

在当前安装目录保存原清单：

```bash
cp -p docker-compose.yml docker-compose.before-1.6.0.yml
```

若有 override 或加密 overlay，也保存相应清单。已加密实例始终使用原来的双 Compose 文件和外置密钥，密钥与数据库备份分开保存；下面的单文件命令仅适用于默认未加密安装。加密安装的命令应保留 `-f docker-compose.yml -f docker-compose.encrypted.yml` 和原 `COMPOSEOPS_DB_ENCRYPTION_KEY_FILE`，见 [加密部署说明](DATABASE_ENCRYPTION.md)。

## 2. 更新固定镜像

将现有清单中 `opsdash` 服务的 `image` 改为 `stanly1997/opsdash:1.6.0`，保留其他配置。不要直接用下载的新文件覆盖自定义的端口或挂载。使用 `${COMPOSEOPS_VERSION:-...}` 的清单也可在本机 `.env` 设置 `COMPOSEOPS_VERSION=1.6.0`；GitHub Release 附件为字面量固定版本，需直接修改 `image`。

```bash
docker compose pull opsdash
docker compose up -d --no-build --wait opsdash
docker compose ps opsdash
```

检查能够用原密码登录、项目授权与配置仍在、历史可读，以及核心服务/日志页面正常。后台启动会执行数据库迁移，升级期间面板会短暂不可用。

## 3. 如需回退

回退必须使用“旧镜像 + 升级前数据库快照”。不要直接让 1.5.1 打开已由 1.6.0 迁移的数据库。

1. 为升级后的状态另存独立备份，保留后续排查和恢复机会。
2. 按 [数据库恢复步骤](BACKUP_RESTORE.md#恢复需要停机) 校验升级前快照、停止面板、复制快照并删除旧 WAL/SHM；暂时不要执行最后的 `up`。只使用备份 CLI 进行校验/复制，避免启动新版应用再次迁移旧快照。
3. 将现有清单的镜像恢复为升级前记录的固定版本（例如 `stanly1997/opsdash:1.5.1`）。如使用 `COMPOSEOPS_VERSION`，同步恢复该变量；保留原卷和其他部署配置。
4. 运行 `docker compose up -d --no-build --wait opsdash`，验证旧密码、配置和历史。回退会丢失快照之后的面板数据库变更；独立备份仍可保留这些状态供恢复使用。

已经启用加密的实例，回退镜像也必须支持该加密格式并挂载同一外置密钥。不要把“1.5.1 明文实例升级/回退验收”理解为允许任意旧镜像打开加密数据库。

## 自动验收范围

Release 质量门在独立容器和卷中验证：amd64 的 1.4.0/1.5.1 升级、原生 ARM64 的 1.5.1 升级；升级后原密码与配置保留；新版在线备份恢复；升级前快照在新卷启动旧镜像；两种架构的明文到加密迁移与外置密钥恢复。测试不会覆盖真实实例或删除业务数据卷。具体结果见对应 tag 的 Release 工作流。
