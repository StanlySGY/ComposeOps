# 回归审查记录

## 审查结论

本轮变更未发现 Critical 问题。设置页签的实际故障已定位为纵向 flex 容器压缩 `.tabs` 到 1px 高，导致按钮视觉存在但鼠标命中被父层截断；增加 `shrink-0` 后，长内容页签保持 39px 高并可正常点击。

Compose 页面现在以 `route.query.projectId` 作为唯一项目上下文，切换到无项目或不可编辑项目时会清理编辑器状态和 query；异步文件请求会校验项目、文件索引和当前路由，避免旧请求覆盖新页面。拓扑、变更评审和回滚页面也限制在可编辑/已纳管项目范围内，避免对受保护 Compose 或备份端点产生无权限请求。

## Critical

- 无。

## Warning

- 外部模型审查未能产出报告：Antigravity 返回 Gemini Code Assist 地区资格 403；Claude wrapper 返回退出码 1，未返回审查内容。不能将其记为模型通过，结论依据本地人工审查、自动化测试和 Playwright 回归。
- 前端 lint 保留 49 条既有 warning，0 errors；本轮变更未新增同类错误。正式 Docker 容器会周期性输出部分容器 stats 超时/容器已删除的既有运行日志，不属于本轮页面修复。

## Info

- `frontend/src/style.css`: `.tabs` 增加 `shrink-0`，防止设置页等长内容页面把页签行压缩到不可点击。
- `frontend/src/views/ComposeView.vue`: 同步路由项目参数、清理失效状态并防止异步旧响应覆盖当前编辑器。
- `frontend/src/views/RollbackView.vue`: 只请求已纳管项目的备份，并修正可回滚项目统计使用数组长度。
- `frontend/src/views/TopologyView.vue`、`frontend/src/views/ChangeReviewView.vue`: 只展示可编辑项目，避免触发未授权 Compose 请求。

## 验证记录

- 前端 lint：通过，0 errors，49 warnings。
- 前端 Vitest：13 个测试文件、132 个测试全部通过。
- 后端 Node test：181 个测试全部通过，串行执行。
- 前端生产构建：通过，无构建 warning。
- Playwright 桌面设置页：7 个页签全部真实点击通过；URL query、正文和侧栏一致，页签高度均为 39px；本轮 0 console error、0 失败请求、0 个 4xx/5xx。
- Playwright 全量主要路由：21 个入口均有主体内容和 `main`，无空白页、无横向溢出、无 runtime error。
- Playwright 移动端 390x844：底部导航、“更多功能”抽屉、拓扑/回滚/事件/应用市场入口和 Esc 关闭均通过，无横向溢出或请求错误。
- 已查看截图：`artifacts/ui-regression-settings-tabs-final.png`、`artifacts/ui-regression-mobile-final.png`。

## 残余风险

- 回归数据库中没有可编辑 Compose 项目，因此本轮浏览器无法对真实 `projectId` 文件加载和跨项目切换做有数据的 UI 点击验证；相关逻辑已由代码审查、路由状态检查和后端权限测试覆盖。
- 正式实例使用现有 Docker 容器和持久化数据卷，重启后仍需以用户实际纳管项目做一次真实 Compose 编辑/保存验证。
