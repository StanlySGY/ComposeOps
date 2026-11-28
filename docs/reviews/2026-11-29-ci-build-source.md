# 托管镜像构建源修复

2026-11-29，Asia/Shanghai。

CI run 46161924021 的 quality / Image installation, upgrade and restore（job 141032067830）在构建 backend-build 阶段失败。日志明确记录 TUNA 的 bookworm、bookworm-updates、bookworm-security InRelease 均返回 HTTP 403，apt 退出 100。该次安装/恢复、真实 Docker 工作流等后续步骤均跳过，不能计为通过。质量单测构建和 ARM64 验收虽成功，也不能替代失败的 amd64 验收。

调整 quality.yml 中 amd64、ARM64，以及手动 publish.yml 的 Docker build-args：APT_MIRROR=deb.debian.org、NPM_REGISTRY=https://registry.npmjs.org。沿用 Dockerfile 内既有 HTTPS、签名验证和重试设置，不关闭验证、不隐藏错误；本地 Dockerfile 默认镜像源不变。没有触发手动公开镜像发布。

验证：YAML 解析与三个构建步骤的实际参数断言通过，Debian bookworm InRelease 本地只读请求返回 HTTP 200。该本地请求不替代 GitHub runner 构建；推送后的完整 CI 仍须观察。

Docker 官方 build argument 文档已实时获取，证据保存在 `~/.local/state/composeops/overnight-20261128/docker-build-variables.html`。来源：https://docs.docker.com/build/building/variables/

原始失败日志：`ci-bridge-image.log`；job 状态：`ci-bridge.json`。`gh run view --log-failed` 对这个已被取消的 workflow 未返回日志，随后按准确 job ID 获取完整失败日志，未推测失败原因。
