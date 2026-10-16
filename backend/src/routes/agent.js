/**
 * AI Agent 路由(/agent/*)。
 *
 * 执行路径已收敛为 Tool Loop 单一通道:
 *  - POST /agent/execute-stream —— 流式执行(SSE),高危工具经 confirmation_required → /agent/approve
 *  - GET  /agent/executions —— 执行审计
 *  - 会话与长期记忆复用 AI 会话存储
 * 早期"先规划后执行"(plan/execute/confirm/feedback/export 等)端点已随
 * executeWorkflow 规划管线一并移除;schema 约定沿用 ai.js 文件头。
 */
import {
  getAgentPlan,
  listAgentExecutions,
  listAgentPlans,
  listAgentFeedback,
  createAiSession,
  renameAiSession,
  listAiMemories,
  getAiUsageSummary,
  recordAgentFeedback,
  getAiSessionCompaction,
  getAiSessionSummary,
} from '../lib/db.js';
import { getAgent } from '../services/agent.js';
import { idField, limitField, numericId } from '../lib/schemas.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { redactSecretValue } from '../lib/secret-redactor.js';
import { toPublicAgentEvent } from '../lib/agent-public-events.js';
import { compactSessionHistory } from '../services/agent/compaction.js';
import {
  createAgentPolicyGroup,
  updateAgentPolicyGroup,
  deleteAgentPolicyGroup,
  listAgentPolicyGroups,
  createAgentPolicyRule,
  updateAgentPolicyRule,
  deleteAgentPolicyRule,
  listAgentPolicyRules,
  listAgentAuditEvents,
} from '../services/agent/policy-store.js';
import { randomUUID } from 'node:crypto';
import { createBoundedSseWriter } from '../lib/bounded-sse-writer.js';

export default async function agentRoutes(fastify) {

/** AI 端点进程内限流(单用户宽配额,防手滑重放与失控循环刷爆上游)。 */
function aiRateLimit(limit, windowMs = 60000) {
  return async (request, reply) => {
    const verdict = checkRateLimit(`ai:${request.ip || 'local'}`, limit, windowMs);
    if (!verdict.allowed) {
      return reply.code(429).send({
        error: 'rate_limited',
        message: '请求过于频繁,请稍后再试',
        retryAfterMs: verdict.retryAfterMs,
      });
    }
  };
}
  // 持久化 Agent 策略组（单管理员 API，由 app.js 的会话鉴权与 Origin 检查保护）。
  fastify.get('/agent/policy-groups', async () => ({ groups: listAgentPolicyGroups() }));
  fastify.post('/agent/policy-groups', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 160 },
      description: { type: 'string', maxLength: 1000 }, enabled: { type: 'boolean' },
    } } },
  }, async (request, reply) => {
    try { return { group: createAgentPolicyGroup(request.body) }; }
    catch (error) { return reply.code(error.statusCode || 400).send({ error: 'policy_group_invalid', message: error.message }); }
  });
  fastify.patch('/agent/policy-groups/:groupId', {
    schema: {
      params: { type: 'object', required: ['groupId'], properties: { groupId: { type: 'string', minLength: 1, maxLength: 128 } } },
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 }, description: { type: 'string', maxLength: 1000 }, enabled: { type: 'boolean' },
      } },
    },
  }, async (request, reply) => {
    try {
      const group = updateAgentPolicyGroup(request.params.groupId, request.body);
      if (!group) return reply.code(404).send({ error: 'policy_group_not_found', message: '策略组不存在' });
      return { group };
    } catch (error) { return reply.code(error.statusCode || 400).send({ error: 'policy_group_invalid', message: error.message }); }
  });
  fastify.delete('/agent/policy-groups/:groupId', {
    schema: { params: { type: 'object', required: ['groupId'], properties: { groupId: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (request, reply) => {
    if (!deleteAgentPolicyGroup(request.params.groupId)) return reply.code(404).send({ error: 'policy_group_not_found', message: '策略组不存在' });
    return { ok: true };
  });

  fastify.get('/agent/policy-rules', {
    schema: { querystring: { type: 'object', properties: {
      groupId: { type: 'string', maxLength: 128 }, limit: limitField(500),
    } } },
  }, async (request) => ({ rules: listAgentPolicyRules({ groupId: request.query?.groupId, limit: request.query?.limit }) }));
  const policyRuleBody = {
    type: 'object', additionalProperties: false,
    properties: {
      groupId: { type: 'string', minLength: 1, maxLength: 128 },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      effect: { type: 'string', enum: ['deny', 'allow'] },
      priority: { type: 'integer', minimum: -1000, maximum: 1000 },
      enabled: { type: 'boolean' },
      toolName: { type: 'string', minLength: 1, maxLength: 128 },
      projectId: { type: 'string', minLength: 1, maxLength: 200 },
      parameters: { type: 'object', maxProperties: 20 },
      reason: { type: 'string', maxLength: 1000 },
    },
  };
  fastify.post('/agent/policy-rules', {
    schema: { body: { ...policyRuleBody, required: ['groupId', 'name', 'effect'] } },
  }, async (request, reply) => {
    try { return { rule: createAgentPolicyRule(request.body) }; }
    catch (error) { return reply.code(error.statusCode || 400).send({ error: 'policy_rule_invalid', message: error.message }); }
  });
  fastify.patch('/agent/policy-rules/:ruleId', {
    schema: {
      params: { type: 'object', required: ['ruleId'], properties: { ruleId: { type: 'string', minLength: 1, maxLength: 128 } } },
      body: { ...policyRuleBody, minProperties: 1 },
    },
  }, async (request, reply) => {
    try {
      const rule = updateAgentPolicyRule(request.params.ruleId, request.body);
      if (!rule) return reply.code(404).send({ error: 'policy_rule_not_found', message: '策略规则不存在' });
      return { rule };
    } catch (error) { return reply.code(error.statusCode || 400).send({ error: 'policy_rule_invalid', message: error.message }); }
  });
  fastify.delete('/agent/policy-rules/:ruleId', {
    schema: { params: { type: 'object', required: ['ruleId'], properties: { ruleId: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (request, reply) => {
    if (!deleteAgentPolicyRule(request.params.ruleId)) return reply.code(404).send({ error: 'policy_rule_not_found', message: '策略规则不存在' });
    return { ok: true };
  });

  fastify.get('/agent/audit-events', {
    schema: { querystring: { type: 'object', properties: {
      planId: { type: 'string', maxLength: 128 }, executionId: { type: 'string', maxLength: 128 }, limit: limitField(500),
    } } },
  }, async (request) => ({ events: listAgentAuditEvents({
    planId: request.query?.planId, executionId: request.query?.executionId, limit: request.query?.limit,
  }) }));
  // POST /api/v1/ai/agent/sessions —— 创建聊天会话
  fastify.post('/agent/sessions', async () => ({ sessionId: createAiSession() }));

  // PATCH /api/v1/ai/agent/sessions/:sessionId —— 重命名聊天会话
  fastify.patch('/agent/sessions/:sessionId', {
    schema: {
      params: { type: 'object', required: ['sessionId'], properties: { sessionId: numericId } },
      body: {
        type: 'object', additionalProperties: false, required: ['title'],
        properties: { title: { type: 'string', minLength: 1, maxLength: 80 } },
      },
    },
  }, async (request, reply) => {
    try {
      renameAiSession(request.params.sessionId, request.body.title);
      return { ok: true, title: request.body.title.trim().slice(0, 80) };
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: 'session_rename_failed', message: error.message });
    }
  });

  // GET /api/v1/ai/agent/memories —— 长期记忆管理页/侧栏
  fastify.get('/agent/memories', {
    schema: { querystring: { type: 'object', properties: { limit: limitField(200), query: { type: 'string', maxLength: 200 } } } },
  }, async (request) => ({ memories: listAiMemories(request.query?.limit, request.query?.query).map((row) => redactSecretValue(row)) }));

  // GET /api/v1/ai/agent/executions —— 执行历史(审计)
  // 同一个 limit 同时喂 listAgentPlans(上限 100)与 listAgentExecutions(上限 500),
  // 故按更宽的 500 收 —— 取 100 会把执行历史的可取范围凭空砍掉八成。
  fastify.get('/agent/executions', {
    schema: {
      querystring: {
        type: 'object',
        properties: { planId: numericId, limit: limitField(500) },
      },
    },
  }, async (request) => {
    const planId = request.query?.planId;
    if (planId) {
      return { plan: redactSecretValue(getAgentPlan(planId)), executions: listAgentExecutions(planId, request.query?.limit).map((row) => redactSecretValue(row)) };
    }
    return {
      plans: listAgentPlans(request.query?.limit).map((row) => redactSecretValue(row)),
      executions: listAgentExecutions(null, request.query?.limit).map((row) => redactSecretValue(row)),
    };
  });

  // GET /api/v1/ai/agent/usage —— token usage aggregate for observability, without session content
  fastify.get('/agent/usage', {
    schema: {
      querystring: {
        type: 'object',
        properties: { days: { type: 'integer', minimum: 1, maximum: 365 } },
      },
    },
  }, async (request) => getAiUsageSummary(request.query?.days));

  // GET /api/v1/ai/agent/feedback —— exportable low-score samples for offline review/evals
  fastify.get('/agent/feedback', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: limitField(200) },
      },
    },
  }, async (request) => ({ feedback: listAgentFeedback(request.query?.limit).map((row) => redactSecretValue(row)) }));

  // POST /api/v1/ai/agent/execute-stream —— Tool-calling 原生循环 + SSE 流式推送
  fastify.post('/agent/execute-stream', {
    preHandler: aiRateLimit(15),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: {
          message: { type: 'string', maxLength: 32768 },
          projectId: idField,
          containerId: idField,
          sessionId: numericId,
          role: { type: 'string', maxLength: 32 },
          webSearchEnabled: { type: 'boolean' },
          attachedLogs: { type: 'string', maxLength: 50000 },
          history: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['user', 'assistant'] },
                content: { type: 'string', maxLength: 12000 },
              },
            },
          },
          pageContext: {
            type: 'object',
            additionalProperties: false,
            properties: {
              page: { type: 'string', maxLength: 120 },
              route: { type: 'string', maxLength: 512 },
              mode: { type: 'string', maxLength: 120 },
              summary: { type: 'string', maxLength: 1000 },
              state: { type: 'string', maxLength: 12000 },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { message, projectId, containerId, sessionId, role, webSearchEnabled = false, attachedLogs = '', history = [], pageContext = {} } = request.body || {};
    if (!message || !String(message).trim()) {
      return reply.code(400).send({ error: 'missing_message', message: '缺少 message' });
    }

    // 设置 SSE 响应头
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const abortController = new AbortController();
    const streamWriter = createBoundedSseWriter(reply.raw, {
      maxQueuedBytes: 256 * 1024,
      onOverflow: () => abortController.abort(new DOMException('客户端接收速度过慢，执行已中断', 'AbortError')),
    });
    const send = (event) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      const publicEvent = toPublicAgentEvent(event);
      if (publicEvent) streamWriter.send(publicEvent);
    };

    const agent = getAgent();
    // 审批门会话键:无 sessionId 的直连流每次生成独立键,防止"本会话不再询问"
    // 授权经由共享 default 桶泄漏到其他匿名流。
    const gateKey = sessionId != null && sessionId !== '' ? String(sessionId) : `stream-${randomUUID()}`;
    const context = { projectId, containerId, sessionId, gateKey, role, initiator: 'authenticated-user', webSearchEnabled, attachedLogs, history, pageContext };

    // 客户端断开时中断执行
    let completed = false;
    reply.raw.on('close', () => {
      if (!completed) {
        console.log('[agent:execute-stream] Client disconnected, aborting execution');
        abortController.abort();
      }
    });

    try {
      // 调用 executeWithLoop,事件通过 onEvent 回调推送
      await agent.executeWithLoop(message, context, send, abortController.signal);
    } catch (error) {
      if (error.name === 'AbortError') {
        send({ type: 'interrupted', content: '执行已被用户中断' });
      } else {
        send({ type: 'error', content: error.message });
      }
    } finally {
      // 无论正常结束、确认等待超时还是客户端断开,都补发 done,
      // 保证前端 running 状态一定在 SSE 关闭前清理。
      send({ type: 'done', content: null, closed: true });
      completed = true;
      await streamWriter.end();
    }
  });

  // POST /api/v1/ai/agent/feedback —— 对某次执行点赞/点踩(写回 agent_plans.rating)
  // rating 1 = 点踩(需改进),5 = 点赞;反馈文本可选,用于沉淀失败样本。
  fastify.post('/agent/feedback', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['planId', 'rating'],
        properties: {
          planId: numericId,
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          feedbackText: { type: 'string', maxLength: 2000 },
        },
      },
    },
  }, async (request, reply) => {
    const { planId, rating, feedbackText = '' } = request.body || {};
    const updated = recordAgentFeedback(Number(planId), rating, feedbackText);
    if (!updated) return reply.code(404).send({ error: 'plan_not_found', message: '执行记录不存在或已清理' });
    return { ok: true, planId: Number(planId), rating: Number(rating) };
  });

  // POST /api/v1/ai/agent/approve —— 批准工具调用(支持确认弹窗编辑参数)
  fastify.post('/agent/approve', {
    preHandler: aiRateLimit(60),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['executionId', 'toolCallId', 'approved'],
        properties: {
          executionId: { type: 'string', maxLength: 128 },
          toolCallId: { type: 'string', maxLength: 128 },
          approved: { type: 'boolean' },
          input: { type: 'object' },
          remember: { type: 'string', enum: ['call', 'tool'], maxLength: 16 },
        },
      },
    },
  }, async (request, reply) => {
    const { executionId, toolCallId, approved, input, remember } = request.body || {};
    const agent = getAgent();
    const success = agent.approveToolCall(executionId, toolCallId, approved, input, remember);
    if (!success) {
      return reply.code(404).send({ error: 'execution_not_found', message: '执行会话不存在或已完成' });
    }
    return { success: true };
  });

  // POST /api/v1/ai/agent/approval-mode —— 切换会话审批模式(ask / allow_writes / full)
  fastify.post('/agent/approval-mode', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          sessionId: { type: ['string', 'number'] },
          mode: { type: 'string', enum: ['ask', 'allow_writes', 'full'] },
        },
      },
    },
  }, async (request, reply) => {
    const { sessionId, mode } = request.body || {};
    const { getApprovalGate } = await import('../services/agent/approval-gate.js');
    const ok = getApprovalGate().setMode(sessionId, mode);
    if (!ok) return reply.code(400).send({ error: 'invalid_mode', message: '无效的审批模式' });
    return { success: true, mode };
  });

  // POST /api/v1/ai/agent/compact —— 会话压缩:为分界前历史生成交接摘要并推进分界点。
  // 摘要失败(未配 Key/网络异常)自动回退确定性事实拼接,响应里以 fallback 标记。
  fastify.post('/agent/compact', {
    preHandler: aiRateLimit(10),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: numericId,
          keepRecent: { type: 'number', description: '活跃区至少保留的最近消息数(默认 6)' },
        },
      },
    },
  }, async (request, reply) => {
    const sessionId = Number(request.body?.sessionId);
    const keepRecent = Math.max(Number(request.body?.keepRecent) || 6, 2);
    const { callOpenAI, getAiConfig } = await import('../services/ai.js');
    const cfg = getAiConfig();
    const callModel = cfg.apiKey
      ? ({ messages, signal }) => callOpenAI({ ...cfg, messages, stream: false, signal }).then((res) => res.content)
      : null;
    let result;
    try {
      result = await compactSessionHistory(sessionId, { keepRecent, callModel });
    } catch (error) {
      if (error.code === 'nothing_to_compact') {
        return reply.code(400).send({ error: 'nothing_to_compact', message: '活跃区历史太少,无需压缩' });
      }
      throw error;
    }
    return {
      ok: true,
      sessionId,
      boundary: result.boundary,
      compactedMessages: result.compactedMessages,
      fallback: result.fallback,
      summaryPreview: result.summary.slice(0, 400),
      facts: { userGoal: result.facts.userGoal, projects: result.facts.projects, containers: result.facts.containers, errorCount: result.facts.errorLines.length },
    };
  });

  // GET /api/v1/ai/agent/sessions/:sessionId/compaction —— 查看会话压缩状态(摘要+分界)
  fastify.get('/agent/sessions/:sessionId/compaction', {
    schema: { params: { type: 'object', required: ['sessionId'], properties: { sessionId: numericId } } },
  }, async (request) => {
    const sessionId = Number(request.params.sessionId);
    return {
      sessionId,
      boundary: getAiSessionCompaction(sessionId),
      summary: getAiSessionSummary(sessionId),
    };
  });
}
