# 平台健康与可靠性告警

应用可靠性页面提供「平台健康」和「可靠性告警」。平台每 30 秒记录数据库/WAL、磁盘余量、增长率、执行器心跳、任务排队/执行时间与备份观测。原始平台样本保留 7 天，已结束的告警和发送记录保留 90 天，结果未知的通知保留供核对。

容量来自平台数据库所在文件系统。增长率至少需要间隔 5 分钟的样本，按数据库与 WAL 的总量计算；短时趋势不能保证未来容量。数据库备份工具在源文件旁生成权限为 0600 的 `.backup-status.json`，记录尝试状态、最近成功时间与耗时，不记录密钥或备份内容。未经过该工具产生的旧备份不会被自动认定成功。

## 独立健康检查器

`scripts/platform-checker.mjs` 不导入面板代码，不读取数据库，不挂载 Docker socket。Node 22 或以上运行环境即可使用。它通过专用 Bearer 凭据调用 `POST /healthz/platform/`；凭据只允许健康检查与检查器回报，不能访问运维 API。凭据在「平台健康」生成，仅显示一次；轮换后旧凭据立即失效。

示例私有配置（配置和凭据文件均设置为 0600）：

```json
{
  "url": "http://127.0.0.1:28765/healthz/platform/",
  "tokenFile": "/home/your-user/.config/composeops/checker-token",
  "stateFile": "/home/your-user/.local/state/composeops/checker-state.json",
  "location": "same-host",
  "intervalMs": 30000,
  "timeoutMs": 10000
}
```

运行：

```sh
node scripts/platform-checker.mjs --config /安全路径/checker.json
# 单次观测；连续三次异常才告警，连续三次健康才恢复
node scripts/platform-checker.mjs --config /安全路径/checker.json --once
```

同一状态文件只允许一个检查器实例写入。用 systemd 保证单实例、退出重启；不要将同一配置交给两个并发调度器。示例用户级 unit：

```ini
[Unit]
Description=ComposeOps independent health checker
After=network-online.target

[Service]
ExecStart=/usr/bin/node /安全路径/platform-checker.mjs --config /安全路径/checker.json
Restart=always
RestartSec=10
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

检查器状态、观测及通知结果写入 `stateFile`，摘要写入标准输出，由 systemd 收集。可配置 `webhookUrl` 接收 JSON 通知，并用 `Idempotency-Key` 去重；凭据只发往 `url`，不会出现在通知或检查日志中。未配置 webhook 时事件仍保留，但明确显示未配置通知。失败最多五轮重试；发送中进程退出会标记结果未知，不会自动重发可能已送达的事件。

同宿主独立进程能发现面板退出、无响应或平台健康异常，**不能发现宿主机整体断电/失联**。整机保护需要在另一宿主运行此脚本，通过受信任网络或 HTTPS 访问面板，并将 `location` 改为 `separate-host`。页面中部署位置为部署方声明，不是平台自动证明。建议配置独立于面板的 webhook 接收端。

## 多窗口错误预算

每个应用目标可单独启用告警，默认关闭。默认快速规则为 5 分钟与 1 小时同时超过 14.4 倍预算消耗，持续规则为 30 分钟与 6 小时同时超过 6 倍。短/长窗口与阈值可编辑。一个探针最多代表 30 秒覆盖；缺测不会计为成功。两个窗口都达到最低覆盖率（默认 90%）才评估消耗率，否则触发独立的覆盖不足告警。100% 目标为零错误预算，任一已覆盖故障都超过预算。

告警需要两次连续异常观测；恢复需要至少三次连续独立观测并持续指定时间（应用默认 5 分钟，平台默认 1 分钟）。维护期不触发新告警，也不确认恢复；维护结束重新积累连续观测。目标或规则改版、目标停用/归档会行政关闭旧告警，这不等于恢复。目标改版后需要重新保存对应告警规则。

通知接入设置页现有渠道，逐渠道保存发送状态，重启不会重发已成功记录。待发告警在恢复或规则改版后会被标记为已替代。未配置渠道、最终失败及发送结果未知均可见；接收端最好按事件编号去重，因为网络超时不能证明接收方未收到消息。

平台自身无法在停止时向通知队列写入，因此独立检查器是独立的监测与通知通道；两者的持久记录互不替代。
