# 服务器驾驶舱

总览提供节点 CPU、内存、文件系统、网络趋势，项目/服务/容器资源排行与存储挂载关联。点击服务会切换正确节点、展开项目及服务组；返回保留节点、时间范围和筛选。

## 数据范围

- 宿主采集与面板环境分别展示。Docker TCP API 单独接入时，只能提供容器指标；宿主不可用不显示为 0。
- 本地节点使用独立采集服务生成的只读快照。SSH 节点复用已配置凭据和主机指纹，通过固定只读命令读取 Linux 指标，不写远端文件。
- 采集器 hostname/kernel 必须与 Docker Engine 身份吻合。不同主机或 Docker Desktop 的不匹配不会被误认作宿主。
- WSL 自动标记为 WSL Linux，不代表 Windows 整机。
- 整机 CPU 为 0–100%，容器 CPU 排行按 Engine 核数归一化，并保留使用核数。内存使用 MemAvailable；容器工作集按 Docker cgroup v1/v2 缓存扣除规则计算。容器限额占比不参与项目加总。
- 文件系统去重，排除伪文件系统。网络优先默认路由接口，避免把 bridge/veth 重复相加；复杂多网卡策略需要按实际网络核对。每个文件系统读写速率只使用可关联的块设备；不可关联显示未知。
- 容器卷关联不等于独占容量；共享卷/镜像不进行虚假分摊。未采集卷大小显示为挂载关联，不做昂贵的递归扫描。

## 本地 Linux 接入

在 Docker 宿主上用 Node 22 或更新版本运行（输出必须在仓库外）：

```sh
COMPOSEOPS_HOST_METRICS_OUTPUT=/home/operator/.local/state/composeops/host-metrics/host.json node /path/to/ComposeOps/scripts/host-metrics-agent.mjs
```

建议以单实例用户级 systemd 托管。可使用下面的 unit，替换用户目录、Node 和仓库绝对路径：

```ini
[Unit]
Description=ComposeOps read-only host metrics

[Service]
Type=simple
Environment=COMPOSEOPS_HOST_METRICS_OUTPUT=/home/operator/.local/state/composeops/host-metrics/host.json
ExecStart=/usr/bin/node /path/to/ComposeOps/scripts/host-metrics-agent.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=default.target
```

采集器没有网络监听，不读应用数据库或 Docker socket，只读取 Linux 资源计数和本地文件系统容量，原子写入 0600 快照。文件夹 0700，仅向面板挂载此文件夹（原子替换需要挂目录，不能仅挂文件）。默认面板以 root 运行；自定义非 root 用户需自行配置只读组权限。

将输出目录写入部署环境 `COMPOSEOPS_HOST_METRICS_DIR`，在已有部署文件后添加 `-f docker-compose.metrics.yml`。已使用数据库及业务备份加密时必须同时保留两个加密 overlay、原外置密钥和原数据卷。

## 采样、保留与告警

- 宿主采集 10 秒，容器快照缓存 10 秒；每节点最多 6 个并发 stats，最多 3 个节点并行。多标签页复用采样；采集轮次不重叠，页面离开或隐藏暂停轮询。
- 首个 CPU/速率样本显示未知；重启、计数器重置、采集超时不会形成假峰值。超过 30 秒的最后采样标为陈旧。
- 新宿主/稳定服务历史独立表，原始样本保留 1 天，之后聚合为 5 分钟桶，最长 30 天；保留均值、极值、样本权重和时间覆盖。容器现有历史策略仍为 7 天原始 / 30 天总保留。
- 文件系统容量历史每分钟保存，读取容量仍随独立采集周期；存储预测至少需 6 小时、60 个有效桶，缺测超过一小时则不预测，所有预测标为低置信估计。
- CPU/内存默认 90%、磁盘 85%、inode 90%，连续至少 2 分钟才写入现有事件中心；短时超限仅提示观察。设置键 `monitor.host.cpu_threshold`、`monitor.host.memory_threshold`、`monitor.host.disk_threshold` 可由部署配置维护。此版本没有单独新增通知通道，也不会自动执行重启/清理。

## 验收

按同一时间窗核对 Linux 的 CPU/内存/df 与 Docker stats。检查两节点切换、离线、服务重建、跨节点深链、390px 手机布局、全屏 Esc、页面激活/失活，以及 100 容器和多订阅的请求复用。迁移 v33 仅新增历史表和索引，旧表不重写。数据历史从接入开始累积，不生成虚假的过去数据。
