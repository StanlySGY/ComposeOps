# 事件时间线的历史事实与时区（2026-11-29）

## 复现与修复

GitOps 时间线原先用仓库当前 `status` 与 `lastSync` 拼出单条事件，既丢失多次同步/回滚，也可能把后续失败与上次成功时间混在一起。现改用已有统一事件 API 的 GitOps 持久记录，显示真实标题、时间、详情和级别，不读取仓库快照来代替历史。

原先 `new Date(SQLite UTC 字符串)` 受本地时区影响，最近一小时筛选可能排除实际半小时前的事件。现复用 `parseTimestamp` / `formatTimestamp` 统一 UTC 处理；摘要统计也改为当前筛选结果，而非标签写着“当前筛选范围”却统计所有已加载记录。未知操作状态不再直接判失败。

时间线五路请求支持取消信号，切节点、离开页面或身份变化后旧轮次失效。节点切换立即重新读取，本人密码轮换恢复读取；刷新操作记录强制获取新结果。部分来源失败时继续显示其他来源并提供原位重试。页面明确说明这是各来源返回记录的汇总，非完整历史。

## 验证

- 首轮新增 6 项测试在旧实现下全部失败；修复后相关 7 文件、41 项通过。UTC 回归显式在 Asia/Shanghai 时区运行。
- Chromium/WebKit 桌面和移动端 16 项通过，均设 Asia/Shanghai；覆盖多条真实形状的 GitOps 记录、UTC 筛选、摘要、局部失败重试、切节点和卸载取消。
- lint、生产和预览构建通过；浏览器响应均为合成数据，没有修改实际历史。

官方资料：ECMAScript Date.parse 规范明确无 UTC 偏移的日期时间按本地时间解释；完整抓取保存在证据目录 `ecma-date-time-full.html`，来源 `https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date.parse`。

证据位于 `~/.local/state/composeops/overnight-20261128/timeline-*`。原失败保留，生产未重启。
