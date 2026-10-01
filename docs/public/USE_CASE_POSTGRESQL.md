# PostgreSQL 配置故障恢复演练

此流程演示可复现的配置错误与修复，尚未作为真实 Agent 端到端验收，也不模拟数据损坏恢复。使用空目录和独立测试项目，不绑定宿主端口。

创建 `compose.yml`：

```yaml
services:
  postgres:
    image: postgres:16.4-alpine
    environment:
      POSTGRES_PASSWORD: demo-only-change-me
    command: [postgres, -c, max_connections=100]
    volumes: [data:/var/lib/postgresql/data]
    healthcheck:
      test: [CMD-SHELL, pg_isready -U postgres]
      interval: 2s
      timeout: 2s
      retries: 20
volumes:
  data:
```

```bash
docker compose -p composeops-pg-demo up -d --wait
docker compose -p composeops-pg-demo exec -T postgres psql -U postgres -c "CREATE TABLE demo_marker (value text); INSERT INTO demo_marker VALUES ('retained');"
```

将 command 中 `max_connections=100` 改成 `max_connections=invalid`，执行 `docker compose -p composeops-pg-demo up -d`，日志应明确指出参数无效。

在 ComposeOps 中授权 **composeops-pg-demo**，保持默认 ask 审批模式，向 Agent 提出：

> 读取这个测试项目的退出状态、日志和配置，定位启动错误。保留数据卷，提出最小配置修复，确认后重建，并执行 SELECT 验证 demo_marker。

核对计划只修复参数后批准。可手动将参数恢复为 100，运行 `docker compose -p composeops-pg-demo up -d --wait`。验收：

```bash
docker compose -p composeops-pg-demo exec -T postgres psql -U postgres -c 'SELECT * FROM demo_marker;'
docker compose -p composeops-pg-demo ps
```

必须看到 `retained` 且容器 healthy。修改 POSTGRES_PASSWORD 环境变量不会为已有数据目录重置数据库密码；不要将它误当成密码修复。数据损坏、主版本升级需要独立的原生备份与恢复计划。

演练后仅清理该测试项目：`docker compose -p composeops-pg-demo down -v`（会删除测试数据）。
