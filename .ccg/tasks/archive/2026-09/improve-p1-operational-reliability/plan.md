# 实施计划

## Phase 1：执行资源生命周期

1. 抽出并导出 WebSocket Shell 的幂等会话清理辅助函数，覆盖 exec/start 失败、stream error、close。
2. 为 `compose.exec` 增加超时清理函数：销毁 stream，调用 exec 的停止能力；无法停止时至少终止 stream 并记录超时状态。
3. 补对应单元测试，确保失败后可再次占用资源、超时不会悬挂读取任务。

## Phase 2：工作流契约与状态机

1. 为 action/agent/condition 节点补定义校验；保留无 `edges` 的旧 nodes 数组顺序执行。
2. 新增可选 `next`、`onTrue`、`onFalse` 跳转语义，condition 不匹配时跳过不可达节点；防止循环和无效目标。
3. 取消检查使用数据库状态和条件式最终写入；审批恢复时保留兼容行为。
4. 前端按节点类型编辑配置，保留未知字段和旧定义兼容。
5. 补工作流校验、分支、取消竞态测试。

## Phase 3：宿主绑定与前端生命周期

1. 备份服务所有记录操作解析并使用 `record.host` 对应 Docker/文件 runner，下载路由也显式取记录宿主。
2. 修正 `volume.mount` 参数检查为 `source`。
3. 从 keep-alive 排除 Shell 与 AgentWorkflow，避免实时连接切页保活。
4. 补备份宿主选择/错误路径测试。

## Phase 4：远程执行和蓝图安全边界

1. 复核 Compose runner 支持的 host 模式；仅传递 Docker CLI 可安全消费的临时 TLS 文件，SSH 节点默认走 workspace runner，不把密码伪装成 DOCKER_HOST 能力。
2. 蓝图 direct 模式要求宿主可见 workspace，无法证明时拒绝 direct 并返回可操作错误。
3. 用 mock runner 覆盖分支，真实 SSH/TLS/Docker E2E 列为未执行验证项。

## Phase 5：完整度、体验和扩展性

1. 自定义模板创建/更新统一执行 YAML/Compose 基础校验；社区源明确标记为未接入，不伪造数据。
2. CMDB 同步 volume/network 资产与关系，列表接口增加分页和安全上限。
3. 将指标保留聚合接入维护调度；采集器增加动态间隔、并发/批量保护。
4. 修正监控短窗口和阈值 0；移除已删除 API；修正节点切换刷新和 SWR host 隔离。
5. 排除实时页面 keep-alive，按观测/自动化/资源/系统重组导航；限制大 chunk 空闲预取。

## 验收

- 后端测试、前端测试、构建、lint 均执行。
- 修改范围只包含本任务文件和必要源码/测试文件。
- 不触碰 `artifacts/` 原有未跟踪内容。
- 变更完成后进行双模型审查；外部 wrapper 若仍因环境参数失败，则记录原因并由本地 diff/test 审查替代。
