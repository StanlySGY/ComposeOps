# Redis 升级演练

这是可手动复现的测试流程，尚未作为真实 Agent 端到端验收。请使用独立项目和测试数据；单实例重建会短暂中断连接，不承诺零停机。生产升级需结合客户端重连、维护窗口和独立备份。

在空目录创建 `compose.yml`：

```yaml
services:
  redis:
    image: redis:7.2.5-alpine
    command: [redis-server, --appendonly, 'yes']
    volumes: [data:/data]
    healthcheck:
      test: [CMD, redis-cli, ping]
      interval: 2s
      timeout: 2s
      retries: 20
volumes:
  data:
```

```bash
docker compose -p composeops-redis-demo up -d --wait
docker compose -p composeops-redis-demo exec -T redis redis-cli SET demo:marker retained
```

在 ComposeOps 中发现并授权 **composeops-redis-demo** 项目，向 Agent 提出：

> 读取这个测试项目，将 Redis 从 7.2.5-alpine 升级到 7.2.6-alpine。先说明停机与数据风险，修改和重建前请求确认，完成后验证版本、健康和 demo:marker 的值。不要删除数据卷。

保持默认 ask 审批模式，逐项核对目标项目与镜像标签。若模型不能执行，手动修改镜像后运行 `docker compose -p composeops-redis-demo up -d --wait`。验收：

```bash
docker compose -p composeops-redis-demo exec -T redis redis-cli INFO server
docker compose -p composeops-redis-demo exec -T redis redis-cli GET demo:marker
docker compose -p composeops-redis-demo ps
```

应看到 `redis_version:7.2.6`、值 `retained` 与 healthy。仅 Running 不代表业务验收通过；另需应用侧读写检查。失败时保留卷和日志，按已验证备份策略恢复，不能假设降级二进制始终兼容已修改的数据格式。

演练结束后仅清理该测试项目：`docker compose -p composeops-redis-demo down -v`（会删除测试数据）。
