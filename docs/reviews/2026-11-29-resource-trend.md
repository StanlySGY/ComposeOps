# 资源趋势图的浏览器布局与坐标修复

日期：2026-11-29。基线 e9676ac。

WebKit 桌面/手机全页面和离线网络检查稳定报告 `ResizeObserver loop completed with undelivered notifications.`。诊断包装浏览器原生 ResizeObserver 后，确认来源是 ResourceTrend：首次尺寸回调直接写入 SVG viewBox 宽度，改变 SVG 自适应高度，进而改变被观察节点。原始失败日志和诊断记录保留，没有屏蔽浏览器错误。

## 改动

- 将尺寸更新合并到下一帧，只有有限、正值且实际变化的宽度才更新；卸载断开观察并取消尚未执行的帧，迟到回调不再排帧。
- 将屏幕坐标换算成 SVG 坐标，修复小于最小图表宽度时点击选错采样点的问题。
- 尺寸或数据范围变化时清除旧光标与旧采样详情，避免新曲线显示上次数据。

依据已实时读取的 CSS Resize Observer 规范与 MDN 文档处理观察回调的布局变更；不更换图表库或增加依赖。

```text
https://drafts.csswg.org/resize-observer/
https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver
```

## 验证

- 新增组件回归修复前 3 failed、1 passed，修复后 4 passed；连同驾驶舱/总览刷新专项共 23 passed。
- Chromium 与 WebKit 的桌面/手机全页面和节点监控回归共 98 passed、6 skipped；跳过项为桌面下仅适用手机的用例，未算作通过。此前四个 WebKit 失败用例均通过。
- 独立 WebKit 原生 ResizeObserver 诊断从一条循环错误变为 errors=[]，目标宽高正常稳定。
- 生产/预览构建、根目录 lint、diff 检查通过。构建存在插件耗时提示，未修改阈值隐藏提示。
- 证据在 `~/.local/state/composeops/overnight-20261128/`：resource-*、resize-diagnostic.log、resize-diagnostic-fixed.log、preview-webkit-failures。

原工作区未动；生产 c40fb28 未重启，24 小时观测继续保留历史失败。真实多节点、外部数据库及最新整镜像验收不由本轮前端浏览器结果代替。
