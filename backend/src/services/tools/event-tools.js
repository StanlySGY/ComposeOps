/**
 * 事件中心域工具注册(event.list/update/diagnose)。
 * 让 Agent 能读到告警事件流并对单条事件做处置(确认已读/静默/取消静默),
 * 与前端事件中心(ops/alert-events)共用同一套存储;容器的停/重启
 * 已由 compose.stop / compose.restart 承担,这里不重复造轮子。
 * 静默只是抑制告警噪音,不是恢复动作——工具描述里必须讲清,防止模型
 * 把"静默告警"当成"处理了问题"。
 */
import { listAlertEvents, updateAlertEvent } from '../events.js';
import { diagnoseAlertEvent } from '../guardian.js';

const EVENT_ACTIONS = new Set(['acknowledge', 'mute', 'unmute']);

export function registerEventTools(agent) {
  agent
    .registerTool('event.list', {
      description: '列出最近的告警事件(标题/详情/级别/已读/静默状态,可过滤已静默)',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数(默认 30,上限 200)' },
          includeMuted: { type: 'boolean', description: '是否包含已静默事件(默认 false)' },
        },
      },
      execute: async (params) => {
        const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 200);
        let events = listAlertEvents(limit);
        if (!params.includeMuted) events = events.filter((item) => !item.muted);
        return {
          events: events.map((item) => ({
            id: item.id,
            key: item.key,
            title: item.title,
            detail: item.detail,
            priority: item.priority,
            read: !!item.read,
            muted: !!item.muted,
            diagnosis: item.diagnosis ? '(已有 AI 诊断,可用 event.diagnose 查看/重诊)' : null,
            createdAt: item.created_at,
          })),
          count: events.length,
        };
      },
    })
    .registerTool('event.update', {
      description: '处置告警事件:acknowledge 标记已读 / mute 静默(仅抑制提醒,不代表问题已解决)/ unmute 取消静默',
      category: 'maintenance',
      requiredPermission: 'managed',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'number', description: '事件 ID(event.list 返回的 id)' },
          action: { type: 'string', enum: [...EVENT_ACTIONS], description: '处置动作' },
        },
        required: ['eventId', 'action'],
      },
      execute: async (params) => {
        const eventId = Number(params.eventId);
        if (!Number.isInteger(eventId) || eventId <= 0) {
          throw Object.assign(new Error('无效的事件 ID'), { statusCode: 400 });
        }
        if (!EVENT_ACTIONS.has(params.action)) {
          throw Object.assign(new Error('不支持的处置动作'), { statusCode: 400 });
        }
        const patch = params.action === 'acknowledge' ? { read: 1 } : { muted: params.action === 'mute' ? 1 : 0 };
        const updated = updateAlertEvent(eventId, patch);
        if (!updated) throw Object.assign(new Error('事件不存在或已清理'), { statusCode: 404 });
        return {
          ok: true,
          eventId,
          action: params.action,
          event: { id: updated.id, title: updated.title, read: !!updated.read, muted: !!updated.muted },
        };
      },
    })
    .registerTool('event.diagnose', {
      description: '对一条告警事件执行 AI 诊断(守护模式:读取容器状态与日志给出根因假设与处置建议,只分析不执行)',
      category: 'diagnostic',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'number', description: '事件 ID(event.list 返回的 id)' },
        },
        required: ['eventId'],
      },
      execute: async (params) => {
        const eventId = Number(params.eventId);
        if (!Number.isInteger(eventId) || eventId <= 0) {
          throw Object.assign(new Error('无效的事件 ID'), { statusCode: 400 });
        }
        const event = listAlertEvents(200).find((item) => Number(item.id) === eventId);
        if (!event) throw Object.assign(new Error('事件不存在或已清理'), { statusCode: 404 });
        const result = await diagnoseAlertEvent(event);
        return { ...result, diagnosis: result.diagnosis?.slice(0, 4000) };
      },
    });
  return agent;
}
