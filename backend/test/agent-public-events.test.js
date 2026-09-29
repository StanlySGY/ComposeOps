import test from 'node:test';
import assert from 'node:assert/strict';
import { toPublicAgentEvent } from '../src/lib/agent-public-events.js';

test('公开 Agent 事件隐藏工具协议和内部工具字段', () => {
  // trace 思考/执行进度现在透出给"执行动态"面板:phase 保留,内容经协议词清洗
  const traceEvent = toPublicAgentEvent({ type: 'trace', trace: { phase: 'tool_executing', content: '正在执行 tool_call 步骤' } });
  assert.equal(traceEvent.type, 'trace');
  assert.equal(traceEvent.phase, 'tool_executing');
  assert.ok(!/tool_call/.test(traceEvent.content), 'trace 内容中的协议词必须被清洗');
  // round 从 metadata.loopCount 透出,供"执行动态"渲染"第 N 轮"
  assert.equal(toPublicAgentEvent({ type: 'trace', trace: { phase: 'loop_iteration', content: '第 2 轮循环', metadata: { loopCount: 2 } } }).round, 2);
  assert.equal(toPublicAgentEvent({ type: 'trace', trace: { phase: 'loop_started', content: '开始' } }).round, 0);
  // done 透出 planId,前端据此把点赞/点踩写回对应执行记录
  assert.equal(toPublicAgentEvent({ type: 'done', content: 'ok', planId: 42 }).planId, '42');
  assert.deepEqual(toPublicAgentEvent({
    type: 'done', content: 'ok', planId: 42,
    usage: { prompt_tokens: 10.8, completion_tokens: 4, total_tokens: 14, rounds: 2, cost: 999 },
  }).usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, rounds: 2 });
  // session_meta 透出本次用户消息的落库 id,前端据此截断历史(编辑并重发)
  assert.deepEqual(toPublicAgentEvent({ type: 'session_meta', userMessageId: 42 }), { type: 'session_meta', userMessageId: 42 });
  assert.deepEqual(toPublicAgentEvent({ type: 'session_meta' }), { type: 'session_meta', userMessageId: 0 });
  // thinking 现在是"轮次分隔"事件:带 round,正文可选(旧占位文案仍兼容透传)
  assert.deepEqual(toPublicAgentEvent({ type: 'thinking', round: 2 }), { type: 'thinking', round: 2, content: '' });
  assert.deepEqual(toPublicAgentEvent({ type: 'thinking' }), { type: 'thinking', round: 0, content: '' });
  assert.deepEqual(toPublicAgentEvent({ type: 'thinking', round: 1, content: '正在思考第 1 轮...' }), { type: 'thinking', round: 1, content: '正在思考第 1 轮...' });
  // reasoning 是模型的真实推理增量:必须原样透传(截断会让"思考过程"看着没内容)
  assert.deepEqual(toPublicAgentEvent({ type: 'reasoning', round: 1, content: '先看容器状态\n再决定是否重启' }), { type: 'reasoning', round: 1, content: '先看容器状态\n再决定是否重启' });
  assert.deepEqual(toPublicAgentEvent({ type: 'reasoning', content: 'x' }), { type: 'reasoning', round: 0, content: 'x' });
  // token 分片必须在 ai.js 发射层(全量、有状态)完成协议剥离后原样透传:
  // 逐 token 清洗会吃掉分片边界的空白与换行,造成表格/代码块与正文粘连、英文空格丢失。
  assert.deepEqual(toPublicAgentEvent({ type: 'token', content: '回答 \n\n| 项目 | 状态 |' }), { type: 'token', content: '回答 \n\n| 项目 | 状态 |' });
  assert.deepEqual(toPublicAgentEvent({ type: 'token', content: '' }), { type: 'token', content: '' });
  assert.deepEqual(toPublicAgentEvent({ type: 'token' }), { type: 'token', content: '' });
  // done 是完整文本,仍做协议与内部伪代码清洗。
  assert.deepEqual(toPublicAgentEvent({ type: 'done', content: '结论 如下:\n\n\ntext tool_ca' }), { type: 'done', content: '结论 如下:\n\ntext', planId: '' });
  assert.deepEqual(toPublicAgentEvent({ type: 'token', content: 'iNdEx++ result= composeOps.project.list_managed()project_list<tID | 项目名称 |\n您当前可以操作的项目如下:' }), { type: 'token', content: 'iNdEx++ result= composeOps.project.list_managed()project_list<tID | 项目名称 |\n您当前可以操作的项目如下:' });
  assert.deepEqual(toPublicAgentEvent({
    type: 'confirmation_required',
    tool: 'cron.create',
    params: { password: 'hidden', name: 'backup' },
    executionId: 12,
    toolCallId: 'call-1',
    risk: 'medium',
    description: '创建定时任务',
  }), { type: 'confirmation_required', executionId: '12', toolCallId: 'call-1', tool: 'cron.create', params: { password: '[REDACTED]', name: 'backup' }, risk: 'medium', description: '创建定时任务' });
  // risk 透传给前端:critical 操作要隐藏"本会话不再询问"按钮(fail-closed)
  assert.equal(toPublicAgentEvent({ type: 'confirmation_required', risk: 'critical' }).risk, 'critical');
  // 达到最大循环次数必须透传:此前被静默丢弃,前端只看到流关闭无任何提示
  assert.deepEqual(toPublicAgentEvent({ type: 'max_loops_reached', maxLoops: 20 }), { type: 'max_loops_reached', maxLoops: 20 });
});

test('公开 Agent 事件保留用户需要的上下文和完成通知', () => {
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_result', tool: 'project.list_managed', result: { result: [{ id: 'p1' }] } }), {
    type: 'context_data', kind: 'projects', projects: [{ id: 'p1' }],
  });
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_result', tool: 'cron.create', result: { result: { name: 'backup' } } }), {
    type: 'action_completed', kind: 'cron_created', result: { name: 'backup' },
  });
  // 通用工具结果只透出工具名/成败/耗时,结果体不外带;空结果给一句人话兜底,避免展开是空白
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_result', tool: 'compose.ps', result: { success: true, result: {}, durationMs: 120 } }), {
    type: 'tool_result', tool: 'compose.ps', success: true, durationMs: 120, summary: '执行成功,该操作没有返回数据', error: '',
  });
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_result', tool: 'compose.ps', result: { success: false, error: '容器不存在', durationMs: 12 } }), {
    type: 'tool_result', tool: 'compose.ps', success: false, durationMs: 12, summary: '{"error":"容器不存在","durationMs":12}', error: '容器不存在',
  });
  assert.equal(toPublicAgentEvent({
    type: 'tool_result', tool: 'task.stop', result: { success: true, result: { message: '已停止', killed: false }, durationMs: 4 },
  }).summary, '已停止');
  // 请求工具时携带脱敏参数摘要,供工具卡片展开查看
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_requested', tool: 'config.inspect', params: { password: 'x', name: 'api' } }), {
    type: 'tool_requested', tool: 'config.inspect', paramsText: '{"password":"[REDACTED]","name":"api"}',
  });
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_requested', tool: 'config.inspect' }), { type: 'tool_requested', tool: 'config.inspect', paramsText: '{}' });
  // 执行阶段同样带脱敏参数:此前只带工具名,展开"参数与结果"是空的
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_executing', tool: 'config.inspect', params: { token: 'x', name: 'api' } }), {
    type: 'tool_executing', tool: 'config.inspect', paramsText: '{"token":"[REDACTED]","name":"api"}',
  });
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_executing', tool: 'config.inspect' }), { type: 'tool_executing', tool: 'config.inspect', paramsText: '{}' });
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_rejected', tool: 'compose.restart' }), { type: 'tool_rejected', tool: 'compose.restart' });
  assert.deepEqual(toPublicAgentEvent({ type: 'tool_error', tool: 'compose.logs', error: '容器不存在' }), { type: 'tool_error', tool: 'compose.logs', error: '容器不存在' });
});
