# 故障关联与遥测接入

AI 值守的「关联日志、指标与依赖」按故障的节点和应用范围组合证据：原始故障日志/状态、最多两小时的容器指标和独立 HTTP 探针、近期可靠变更、同应用故障以及 OTLP trace/log。同名项目在不同节点之间不会串读。当前日志和 Compose 依赖明确标为采集时快照，不假装还原过去配置。

依赖假设引用依赖边、依赖服务异常和可用的同 trace 请求。页面明确区分假设和事实：时间相关、当前 depends_on 和客户端 span 均不能单独证明因果。缺失日志、指标、配置或遥测会显示缺口；不把缺测解释为正常。AI 诊断复用这些来源，并限制每类数量和总字节，防止少量长日志挤满上下文。

## OTLP HTTP JSON

在「应用可靠性 → 遥测接入」为已纳管应用创建凭据，选择允许的服务。凭据只显示一次，保存到私有文件或应用凭据管理中。请求头为 `Authorization: Bearer <凭据>`；不使用管理会话 cookie。凭据绑定节点配置和 Docker Engine 身份；撤销、撤管或身份变化后拒绝写入，Engine 核对缓存最多 30 秒。

- 日志：`POST /otlp/v1/logs`
- 链路：`POST /otlp/v1/traces`
- `Content-Type: application/json`；可选 `Content-Encoding: gzip`
- 标准 `resourceLogs/scopeLogs/logRecords` 与 `resourceSpans/scopeSpans/spans` 结构。
- `resource.attributes` 必须包含凭据范围内的 `service.name`。可选 `composeops.host.id`、`composeops.project.id` 如有必须匹配凭据；平台归属始终取自凭据。
- trace/span ID 为十六进制（32/16 位，不能全零）；时间戳为纳秒十进制字符串；状态码为整数。
- 接收 JSON 子集，不提供 protobuf、gRPC、指标信号、通用 trace 存储或完整 APM 功能。未知字段忽略，保留的属性有明确白名单。客户端日志/链路是待核验的证据。

许多导出器使用 `OTEL_EXPORTER_OTLP_ENDPOINT` 指定 `https://你的面板/otlp`、协议 `http/json`，并设置认证头。各语言 SDK 对 JSON 支持不同，若只支持 protobuf，应使用支持 JSON 输出的转换路径；不要将 protobuf 数据发往此入口。

限额：请求体及解压后内容最多 1 MiB，每批最多 200 条；每凭据每分钟最多 2000 条和 8 MiB JSON。超限返回 429 与 Retry-After，整个批次不部分落库。trace/log 重试按范围与内容去重。遥测最多保留 7 天；每应用最多 2 万条、总计最多 20 万条，超出时按接收时间清理最旧记录。列表查询最多 200 条；因此无记录不能证明故障不存在。

日志/属性进入数据库和 AI 前收集敏感值并脱敏；查询文本、任意请求头和任意属性不会全量保存。应用仍应在采集源过滤个人数据及业务敏感内容。
