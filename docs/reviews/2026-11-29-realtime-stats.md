# 夜间改进：实时指标恢复与新鲜度

日期：2026-11-29，Asia/Shanghai。用户要求持续改进到当日 09:00，本批不重启生产或重置观测。

## 实际缺陷

- 项目指标 SSE 没有建连/空闲期限，EOF 没有通知视图，断开后可能保留陈旧数值。
- 卡片只跟踪展开和项目 ID，停止容器变为运行、首次纳管、运行容器集合变化未能重新订阅。
- KeepAlive 失活时虽然取消，但属性 watcher 仍可能重新创建连接；旧回调缺少本地身份检查。
- CPU 未就绪时以零显示；日志页对指标错误不清除旧值。
- 指标服务端没有心跳/立即发送响应头，慢扫描与断线无法区分；直接 write 不处理慢客户端积压。

新增前端回归最初 7 项失败，服务端 2 项失败。修复保留共享连接，增加有限读取、CR/LF/CRLF 和多 data 行解析、逐项目 60 秒新鲜度、订阅生命周期与迟到结果隔离。连接 15 秒建立期限、60 秒空闲期限；服务端 15 秒心跳，使用既有 256 KiB 排队上限写入器，关闭时取消采样。

## 资料与边界

核对 WHATWG Server-sent events 规范：UTF-8、行结束方式、data 多行与注释处理。官方页面通过直接 HTTP 获取成功，保存 `whatwg-sse.html/.txt`；检索工具未返回内容，Context7 查询连接失败，未把失败查询写为成功引用。

来源：https://html.spec.whatwg.org/multipage/server-sent-events.html

心跳只表示连接存在，不能把未更新的项目数据保持为“新鲜”。指标延迟仅提示等待新采样，不冒充 CPU=0、容器已停止或业务恢复。没有引入新依赖。

## 验证与证据

仓库外证据目录：`~/.local/state/composeops/overnight-20261128/`。

- 全量前端：153 个文件、1,197 项通过。随后补充回调中切换订阅隔离和日志 CPU 未就绪处理，最终四个相关文件 **47/47** 通过。
- 项目指标服务端、指标有效性、Agent SSE 写入器关联测试 **22/22** 通过，包含慢扫描心跳、慢客户端队列溢出、断开取消 Docker 采样。
- 根目录 lint、正式前端构建、语法和 diff 检查通过。测试中既有 Vue/Router 警告按原样保留，不宣称零警告。
- Chromix 真实浏览器使用实际 Vue 卡片与共享 SSE 客户端、合成只读指标源；桌面 1440×1000、手机 390×844 各 **41 步** 通过。覆盖停止→运行、未知 CPU、EOF 清空及重连、页面离开/返回、隐藏期间状态改变、收起/展开。无运行错误、无横向溢出。此测试不冒充真实 Docker 或生产写操作。
- 浏览器截图仍有本机部分中文字形缺失，未将此作为字体视觉通过证据。
- 首轮前端测试触发了测试夹具重复 close 异常；修正夹具的取消生命周期后通过，原日志保留。

主要文件：`stats-before.log`、`stats-after.log`、`stats-server-before.log`、`stats-frontend-full.log`、`stats-frontend-final-3.log`、`stats-server-final.log`、`stats-lint-final-2.log`、`stats-build-final-2.log`、`stats-browser-desktop.json`、`stats-browser-mobile.json`、`stats-browser-fixture.html`。

00:05 左右只读核对：24 小时观测仍运行，已约 12.06 小时，线上健康 724 次/4 次历史失败；隔离负载 8,179 次完成/0 失败，RSS 峰值增长 1.9 MiB、FD 峰值增加 4。生产 healthy、restart=0，仍运行 c40fb28。本批尚未部署；24 小时完整观测最早 12:01:29 结束，晚于 09:00 截止时间。
