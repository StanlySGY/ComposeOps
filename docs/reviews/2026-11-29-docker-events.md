# 夜间改进：Docker 事件流背压与建连恢复

日期：2026-11-29，Asia/Shanghai。

## 复现

旧 Docker 事件流以 data 回调持续读取，每条记录追加 Promise 链。当项目扫描挂起，1,000 条约 4 KiB 事件全部进入待处理队列，且未换行输入没有大小上限。getEvents 建连没有期限或主动取消信号。三项新增回归均失败，保留 events-before.log。

## 改进

- 逐行异步迭代：只在上一条事件完成扫描、广播与工作流路由后读取下一条；保持顺序，不主动丢弃有效事件。行大小最多 256 KiB，超限记录固定错误并断流恢复，不记录原始事件正文。
- 保持 UTF-8 分片、CRLF、空行及有效末条无换行事件；坏 JSON 跳过该行，后续记录仍处理。
- 建连 15 秒期限，传入 Docker SDK abortSignal；退订、节点配置更新、超时会取消建连或在途事件处理。迟到的旧连接只销毁，不能重新占用会话。
- 连接失败沿用退避重连。已经建立的 Docker 事件流没有空闲超时：没有容器事件是正常状态，不因安静而循环断连。

## 验证

- 同样的 1,000 项测试，扫描挂起期间读取 **8 项**，恢复后 1,000 项顺序和数量全部符合预期；旧实现读取 1,000 项。
- 有界行读取、Docker 事件、工作流路由和多节点隔离专项 **23/23** 通过。
- 完整后端：**1,254 通过、1 项既有跳过、0 失败**，403 秒。后端 lint、Node 语法及 git diff 检查通过。
- 真实本机 Docker Events API 只读检查：27 ms 建连，主动中断后 stream.destroyed=true；没有创建、停止或修改业务容器。
- 原事件测试只等待一次 setImmediate，改为等待实际第二条事件抵达，仍检查相同两条事件。新增重连夹具的 mock callCount 语义判断错误已修正，原失败保留；没有减少断言或修改业务成功标准。
- 没有 UI 改动，不重复浏览器验收；没有部署或重启生产。

官方 Node 22 Stream 文档实时获取到仓库外 node-stream.html，使用既有异步迭代和取消接口，没有引入新依赖。
来源：https://nodejs.org/docs/latest-v22.x/api/stream.html

证据目录：`~/.local/state/composeops/overnight-20261128/`。主要文件：events-before.log、events-after.log、events-final.log、events-final-2.log、events-backend-full.log、events-lint.log、events-real-docker.json。历史失败保留。

断流期间 Docker 的事件重放覆盖仍受 daemon 事件历史窗口约束；本次保证客户端有界和取消边界，不声称所有网络中断均无事件丢失。
