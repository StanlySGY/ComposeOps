# 最终复核记录

## 本次补充

- 数据卷备份列表按项目 `composeMode` 选择 Compose 读取方式：本地 direct 使用本地文件，workspace 使用 `readWorkspaceCompose()`，TCP Docker API-only/不可编辑项目直接以 `COMPOSE_WORKSPACE_REQUIRED` 返回 409。
- Compose 卷名解析区分逻辑键与 Docker 实际名：普通卷默认解析为 `<project>_<volume>`，external 卷使用逻辑名，顶层 `name` 显式名称优先；宿主已有卷清单只用于判断期望卷是否存在，不把同名裸卷误认成项目卷。
- 远程备份下载等待容器成功退出、stdout 和 stderr 三条完成条件后再结束响应；响应 close、attach/demux 错误、非零退出和尾流超时统一进入幂等清理，确保 attach、demux 和 helper 容器释放。
- 保留文件名/卷名校验、备份记录宿主绑定、宿主级备份目录与 retention 隔离。

## 验证结果

- 后端：`DB_PATH=<临时目录> npm test`，205 tests passed，0 failed，使用 `--test-concurrency=1`。
- 前端：`npm test`，13 个测试文件、132 tests passed。
- 后端 lint：0 errors，39 warnings。
- 前端 lint：0 errors，49 warnings。
- 前端构建：成功，2404 modules transformed，0 build warnings。
- 定向数据卷测试：9 tests passed；覆盖真实卷名解析、裸卷误认、retention 宿主隔离、非法旧记录、workspace 缺失 fail-closed。
- 本次新增/修改 JavaScript 已通过 `node --check`。
- `git diff --check` 通过。

## 外部模型审查

按 M 复杂度要求并行尝试 Antigravity 与 Claude 双模型审查，但两者均未产生有效报告：

- Antigravity：headless 模式缺少 command 权限，工具调用被自动拒绝；wrapper 同时注入 `--gemini-model` 并报该参数只对 gemini backend 生效，最终没有 agent message。
- Claude：wrapper 同样注入不兼容的 `--gemini-model` 参数，进程以退出码 1 结束。

因此本次最终审查依据为本地完整 diff、定向测试、全量测试、lint、构建和语法检查；外部模型未修改文件。

## 验证限制

- 当前环境未执行真实 Docker daemon 下的 tar 备份/恢复/远程下载 E2E。
- 未执行真实 SSH 主机、TCP TLS daemon、跨节点共享工作区和远程备份目录 E2E。
- 未执行真实 Docker exec 超时杀进程和 WebSocket 长连接压测。
- 前端测试仍有既有 Vue `inject()`/生命周期 warning；lint 中仍有既有 warning，包括 `LogLine.vue` 的 `v-html` 告警，本次未扩大范围处理。

## 结论

数据卷备份真实卷名解析与远程流清理边界已完成，未发现本次范围内的 Critical 阻断项；未能通过真实 Docker/SSH/TLS 环境验证的部分已 fail closed 并由 mock/单元测试覆盖主要分支。
