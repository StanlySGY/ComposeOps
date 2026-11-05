# ComposeOps 仓库维护审计（2026-11-05）

## 审计范围与结论

本记录覆盖指定工作区 `/home/sgy/workspace/ComposeOps`、GitHub 默认分支、六个 Dependabot PR、相关 CI 日志和项目文档。它是**仓库代码与维护状态审计**，不是生产环境验收报告。

- 仓库：`StanlySGY/ComposeOps`
- 默认分支：`main`
- 审计基线：`2d1b9aa4050a3e696f00d3c8ff64f14e562184cf`（2026-11-04）
- 审计开始时本地工作区：干净，`main` 与 `origin/main` 同步
- 当前主分支 CI：3 个 Job 全部成功；Pages 预览部署成功
- 六个 Dependabot PR 均仍为 open、未合并；PR 历史 CI 不能代替基于当前 `main` 的新验证

本轮只做仓库和 GitHub 核查及文档治理，不执行生产部署、重启或数据库操作。

## 当前主分支验证证据

| 验证 | 证据 | 结果与边界 |
| --- | --- | --- |
| CI | [Run 41840504764](https://github.com/StanlySGY/ComposeOps/actions/runs/41840504764) | 当前基线 `2d1b9aa` 的 3 个 Job 全部成功 |
| 代码质量 | 同上 | `npm ci`、release notes、lint、测试、正式构建、预览构建、Playwright 预览检查成功 |
| amd64 镜像 | 同上 | 镜像构建、首次安装/备份恢复、从支持基线升级成功 |
| ARM64 镜像 | 同上 | QEMU/Buildx 模拟构建、首次安装和恢复成功；**不是原生 ARM64 硬件验收** |
| Pages 预览 | [Run 41841947965](https://github.com/StanlySGY/ComposeOps/actions/runs/41841947965) | 当前基线预览工作流成功 |

仓库使用 npm workspaces，只维护根级 `package-lock.json`；`AGENTS.md` 明确禁止在 frontend/backend 子目录生成 lockfile。

## Dependabot PR 逐项状态

以下是本次审计时 GitHub 上的 PR 状态与最后可见的 PR CI，不代表新基线复验。

| PR | 更新 | 最后可见 CI | 失败/风险定位 | 后续处理 |
| --- | --- | --- | --- | --- |
| [#19](https://github.com/StanlySGY/ComposeOps/pull/19) | Docker Login Action 3 → 4 | 成功（36876374699） | 旧分支 CI 成功，但 base 落后于当前 main | 同步最新 main，重新跑完整 CI 后再合并 |
| [#20](https://github.com/StanlySGY/ComposeOps/pull/20) | Checkout 5 → 7 | 成功（38849887438） | 旧分支 CI 成功，但 base 落后于当前 main；覆盖多条工作流 | 同步最新 main，重新跑完整 CI 后再合并 |
| [#21](https://github.com/StanlySGY/ComposeOps/pull/21) | Buildx 3 → 4 | 成功（38849885041） | 旧分支 CI 成功，但 base 落后于当前 main | 同步最新 main，重新跑完整 CI 后再合并 |
| [#18](https://github.com/StanlySGY/ComposeOps/pull/18) | Vite 7 → 8 | 失败（40300267405） | `npm ci` 拒绝不同步的根 lockfile；Vite、Rolldown、Lightning CSS 及平台绑定包均未与 manifest 对齐 | 在 PR 分支更新根 lockfile；验证 Vite/Rolldown 与 Vue 插件、Vitest 的构建和测试兼容性 |
| [#23](https://github.com/StanlySGY/ComposeOps/pull/23) | Monaco 0.52 → 0.57 | 失败（37467922458） | 失败发生在 `actions/setup-node` 缓存路径解析阶段，旧工作流引用已不存在的 `backend/package-lock.json` 与 `frontend/package-lock.json`；不是 Monaco 运行时测试失败 | 同步当前 main 的根 lockfile 缓存配置，更新根 lockfile；验证 Compose 编辑器 ESM 导入、YAML Worker、语义提示与模式切换 |
| [#32](https://github.com/StanlySGY/ComposeOps/pull/32) | Playwright 1.63 → 1.64.1 | 失败（39229875732） | `npm ci` 因根 lockfile 仍锁定 Playwright 三个包 1.63.0 而拒绝安装 | 更新根 lockfile，完整复验预览浏览器测试 |

**合并准入：** #19/#20/#21 的旧 CI 通过不等于当前基线通过；#18/#23/#32 的旧失败也必须在同步到最新 main 后重新判断。每个 PR 都需确认 base 已更新、安装和全部相关 CI 通过、diff 无意外文件后，才可合并。

## 文档治理

- `docs/IMPROVEMENT_ROADMAP.md`：保留原始规划，增加归档说明；不再把早期路线图未勾选项当作当前欠账。
- `docs/improvements-analysis.md`：保留竞品研究快照，说明其中功能数量、趋势和待改进判断均需重新核实。
- `PROJECT_CONTEXT.md`：区分当前代码仓库状态与最近一次生产环境记录；生产记录保留原日期，不冒充本轮实时检查。
- `docs/public/RELEASE_CHECKLIST.md`：追加当前主分支 CI 与 Pages 预览证据，并明确 QEMU ARM64 不是原生硬件验收。

## 仍需真实环境的验收

以下事项没有通过本轮仓库审计得到验证，继续保持未验收状态：

1. 已认证管理员 Session 下的生产 UI 全流程操作。
2. 经授权的真实模型渠道、流式和工具调用兼容性。
3. 非生产 SSH/TLS 多节点、证书轮换和 WAN 断线恢复矩阵。
4. 第三方通知渠道的真实送达。
5. 原生 ARM64 机器上的 SQLite 原生依赖构建、加密读写和恢复。
6. 独立密钥托管、异地加密备份和另一主机恢复。

数据库密钥仍按既有决定只保存在本机。本轮没有读取或复制密钥，没有上传密钥，没有删除加密/明文恢复快照，也没有重启或修改生产容器。

## 本轮操作边界

本记录不声称六个 Dependabot PR 已更新、复验或合并；这些 PR 必须以新的分支提交和新 CI 结果为准。

## 2026-11-05 本地代码完善与依赖回归（后续补记）

本节记录审计后在本地工作分支完成的代码与依赖处理。以下结果来自工作区，不代表 GitHub PR 分支或远端 CI 已更新。

### 已处理

- Vite 升至 8.3.5，Playwright 与 @playwright/test 升至 1.64.1；根级 package-lock.json 已同步，且仓库仍只有一个 lockfile。
- GitHub Actions：actions/checkout@v7、docker/login-action@v4、docker/setup-buildx-action@v4，覆盖 quality/publish/release 工作流。
- Monaco 0.57 未合入：升级后的浏览器回归实际出现 Missing requestHandler or method: doValidation/resetSchema，说明当前 monaco-yaml/monaco-worker-manager Worker 链路并不兼容本次 Monaco 0.57 组合。已将 monaco-editor 固定在经过验证的 0.52.2，并执行 npm workspace 去重；npm ls monaco-editor --all 确认 monaco-yaml 与应用共享同一份 0.52.2，避免双实例。Dependabot PR #23 应继续保持未合并，待 Worker 适配有独立修复和浏览器证据后再评估。

### 本地验证结果

| 验证 | 结果 |
| --- | --- |
| 干净安装 | 根目录 npm ci 通过（420 packages） |
| Lint | 通过 |
| 后端单测 | 490 项：489 pass、1 skip、0 fail |
| 前端单测 | 68 个测试文件：420 pass、0 fail |
| Playwright 预览 E2E | 38 项：35 pass、3 skip、0 fail（桌面/移动） |
| 正式前端构建 | Vite 8.3.5 通过 |
| 静态预览构建 | Vite 8.3.5 通过 |
| Monaco 编辑器真实浏览器链路 | 项目直达、视图切换、重新选择项目后编辑器内容保持；YAML Worker 不再报 requestHandler 错误 |

### 依赖 PR 对应关系与剩余工作

- #18（Vite）与 #32（Playwright）：本地 manifest/根 lockfile 已按目标版本更新并通过本地回归；尚未同步或更新这两个 GitHub PR 分支。
- #19/#20/#21：对应 Action 版本已在本地工作分支更新并通过本地 lint/build；仍需在 GitHub 同步 main 后取得全量 CI 证据。
- #23（Monaco）：明确暂缓，不 cherry-pick、不合并，不把失败的 Monaco 0.57 试验残留在最终代码中。
- 本轮没有提交或推送；没有生产部署、容器重启、数据库或密钥操作。

## 升级配置恢复链路补强（本地工作区后续补记）

- 修复回滚中心的误导入口：此前仅按“项目已纳管、可编辑、非运行”展示恢复按钮，未确认项目是否真的有  的 Compose 备份。现在必须存在升级备份才展示。
- 将“镜像升级回滚”更名为“升级配置恢复”，明确说明该功能恢复 Compose 配置并重建容器，不保证回退已拉取的浮动 tag 镜像版本。
- 升级前备份改为完整读取当前项目的全部 Compose 文件后再持久化；挂载项目和 workspace 项目均支持。任一文件无法读取、文件数超过备份保留上限或备份不完整时，升级在执行 pull/up 前失败关闭。
- 每次升级使用独立 batch reason，恢复时只选最近一次完整批次并恢复该批次全部文件；兼容旧版  记录按创建时间分组。恢复前校验备份文件集与当前 Compose 文件集完全一致；任一文件恢复失败即停止，不执行容器重建；恢复后清除镜像检查缓存。
- 新增镜像引用解析、Compose 服务策略分类、同仓库 digest 比较、升级备份批次选择和恢复入口筛选测试。
- 本地验证：后端 499 项（498 pass / 1 skip）、前端 422 pass、Playwright 35 pass / 3 skip、前后端 lint 及 Vite 8.3.5 生产构建通过。
