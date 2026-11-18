/** Trusted, declarative UI blocks inspired by A2UI; never accepts HTML, CSS, JS or arbitrary component names. */
import { redactSecretValue } from '../../lib/secret-redactor.js';

const UI_TYPES = new Set(['notice', 'status', 'metrics', 'table', 'steps']);
const cleanText = (value, max = 240) => String(redactSecretValue(String(value ?? ''))).slice(0, max);

function normalizeUiBlock(block) {
  if (!block || typeof block !== 'object' || !UI_TYPES.has(block.type)) {
    throw Object.assign(new Error('结构化 UI 组件类型不受信任'), { statusCode: 400 });
  }
  const title = cleanText(block.title, 120);
  if (block.type === 'notice') {
    const tone = ['info', 'success', 'warning', 'danger'].includes(block.tone) ? block.tone : 'info';
    return { type: 'notice', title, text: cleanText(block.text, 1200), tone };
  }
  if (block.type === 'status') {
    const status = ['healthy', 'warning', 'error', 'unknown'].includes(block.status) ? block.status : 'unknown';
    return { type: 'status', title, status, detail: cleanText(block.detail, 600) };
  }
  if (block.type === 'metrics') {
    const items = Array.isArray(block.items) ? block.items.slice(0, 6) : [];
    return { type: 'metrics', title, items: items.map((item) => ({
      label: cleanText(item?.label, 80), value: cleanText(item?.value, 80),
      unit: cleanText(item?.unit, 24), detail: cleanText(item?.detail, 120),
    })) };
  }
  if (block.type === 'table') {
    const columns = Array.isArray(block.columns) ? block.columns.slice(0, 6).map((item) => cleanText(item, 80)) : [];
    const rows = Array.isArray(block.rows) ? block.rows.slice(0, 10).map((row) =>
      Array.isArray(row) ? row.slice(0, columns.length || 6).map((cell) => cleanText(cell, 240)) : []) : [];
    return { type: 'table', title, columns, rows };
  }
  const items = Array.isArray(block.items) ? block.items.slice(0, 8) : [];
  return { type: 'steps', title, items: items.map((item) => ({
    title: cleanText(item?.title, 120), detail: cleanText(item?.detail, 300),
    status: ['done', 'active', 'pending', 'error'].includes(item?.status) ? item.status : 'pending',
  })) };
}

export function normalizeAgentUiBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 8) {
    throw Object.assign(new Error('结构化 UI 最多支持 1–8 个组件'), { statusCode: 400 });
  }
  return blocks.map(normalizeUiBlock);
}

export function registerUiTools(agent) {
  agent.registerTool('ui.present', {
    description: '向用户展示安全的结构化运维 UI。适用于状态摘要、指标卡、对比表、步骤进度和提醒；只允许 notice/status/metrics/table/steps 组件，禁止 HTML/JS/CSS/任意组件名。每次最多 8 个组件。',
    category: 'context',
    requiredPermission: 'readonly',
    confirmationRequired: false,
    requiresProject: false,
    parameters: {
      type: 'object',
      properties: {
        blocks: { type: 'array', minItems: 1, maxItems: 8, items: {
          type: 'object', additionalProperties: false, required: ['type'],
          properties: {
            type: { type: 'string', enum: ['notice', 'status', 'metrics', 'table', 'steps'] },
            title: { type: 'string', maxLength: 120 }, text: { type: 'string', maxLength: 1200 },
            tone: { type: 'string', enum: ['info', 'success', 'warning', 'danger'] },
            status: { type: 'string', enum: ['healthy', 'warning', 'error', 'unknown', 'done', 'active', 'pending'] },
            detail: { type: 'string', maxLength: 600 },
            items: { type: 'array', maxItems: 8, items: { type: 'object', properties: {
              label: { type: 'string', maxLength: 80 }, value: { type: 'string', maxLength: 80 },
              unit: { type: 'string', maxLength: 24 }, title: { type: 'string', maxLength: 120 },
              detail: { type: 'string', maxLength: 300 }, status: { type: 'string', maxLength: 16 },
            } } },
            columns: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 80 } },
            rows: { type: 'array', maxItems: 10, items: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 240 } } },
          },
        } },
      },
      required: ['blocks'],
    },
    execute: async (params) => ({ ok: true, blocks: normalizeAgentUiBlocks(params.blocks), note: '仅使用受信组件目录渲染；未接受任何 HTML、脚本或样式代码。' }),
  });
  return agent;
}
