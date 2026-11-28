# 预览身份与真实浏览器入口修复

日期：2026-11-29；基线 d30469a。使用独立工作树，原工作区未提交修改保留。

## 问题

成员账号上线后，正式前端通过 `/auth/status` 的 principal 区分管理员和成员。离线预览及登录浏览器夹具仍只返回 authenticated，导致预览显示空的成员工作台。真实 Docker 验收脚本还使用旧的“管理员密码”字段名称，CI 在登录前失败，无法继续验证部署流程。

## 修复

- 预览和登录夹具明确返回虚构管理员身份；未登录夹具返回 principal=null。
- 登录测试使用当前界面的“密码”可访问名称，并核验默认账号 admin。密码错误、键盘重试、密码显隐、初始化校验和素材失败回退断言保持。
- 真实 Docker 项目验收使用同样的当前登录入口，保留后续部署评审、环境漂移阻止、日志、终端及容器状态核验。

没有改变正式身份校验或权限边界。预览仍不回退访问真实后端。

## 验证

- 修复前登录夹具桌面/手机共 6 项失败，页面快照明确显示误入成员工作台；原失败日志与 trace 已保留。
- 修复后登录与全页面预览：49 passed、3 skipped（桌面项目跳过仅手机适用项），包含两个视口、全部导航、焦点循环、键盘交互、无横向溢出及无真实后端流量检查。
- 真实 Docker 项目 direct/workspace 两模式均完成 1440px 与 390px 验收；包括 360 行断线日志补回、单容器/聚合切换、有效配置评审、保存、实际部署及原项目身份检查。使用既有 composeops:release-c40fb28 镜像核验脚本适配，不冒充最新应用镜像验收；临时项目和面板已清理。
- 预览构建、根目录 lint、脚本语法及 diff 检查通过。正式运行代码未改，不重复后端全量测试。
- 证据目录：`~/.local/state/composeops/overnight-20261128/`，包括 login-preview-failures-before-fix、login-preview-fixed.log、workspace-browser-real.log 和 workspace-browser-real-workspace.log。

官方 Playwright authentication 与 locators 文档已直接获取成功，继续使用用户可感知的名称定位并验证登录后的实际页面。搜索服务无返回、Context7 连接失败，不把工具失败当作文档已核验。

```text
https://playwright.dev/docs/auth
https://playwright.dev/docs/locators
```

生产仍为 c40fb28，healthy、RestartCount=0，没有重启。24 小时观测约运行 12.4 小时，4 次历史健康失败保留，未宣称全天通过；预定最早完成时间为北京时间 2026-11-29 12:01:29，晚于本轮 09:00 工作截止时间。托管 CI 的全部浏览器与新镜像结果仍需跟踪。
