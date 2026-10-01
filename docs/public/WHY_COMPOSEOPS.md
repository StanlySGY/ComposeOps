# Why ComposeOps

ComposeOps 面向个人服务器和 Homelab，围绕 Docker Compose 组织服务、配置、日志和 AI 工具执行。

## 核心体验

- AI 读取状态与日志，提出操作，通过审批门执行并展示工具结果。
- 默认 ask 模式下写操作需要确认；会话可显式放宽部分审批，critical 操作始终确认。
- 多渠道按优先级切换，工具能力与流式兼容性可单独测试。
- 不配置 AI 也能使用服务、日志和配置功能。

## 选型边界

目前是单管理员、中文界面，没有多租户隔离。Docker Socket 访问等价宿主高权限。需要团队权限、PaaS 构建发布或 Kubernetes 管理时，应评估其他产品的最新版本。

参考产品：[Dockge](https://github.com/louislam/dockge)、[Portainer](https://www.portainer.io/)、[Komodo](https://komo.do/)、[Coolify](https://coolify.io/)。不提供缺少版本与来源依据的功能胜负表。

先体验 [离线预览](https://stanlysgy.github.io/ComposeOps/)，再在测试项目上验证授权与恢复流程。预览不能替代真实环境验收。
