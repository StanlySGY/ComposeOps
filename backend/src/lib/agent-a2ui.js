/** Convert only the trusted ComposeOps UI catalog into A2UI v1.0 envelopes. */
const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const text = (id, value) => ({ id, component: 'Text', text: String(value ?? '').slice(0, 1200) });

function blockComponents(block, index) {
  const prefix = 'b' + index;
  const children = [];
  const components = [];
  const addText = (suffix, value) => {
    const id = prefix + '_' + suffix;
    components.push(text(id, value));
    children.push(id);
  };
  if (block.type === 'notice') {
    addText('title', block.title || '提示');
    addText('body', block.text || '');
  } else if (block.type === 'status') {
    addText('title', block.title || '状态');
    addText('status', String(block.status || 'unknown') + (block.detail ? ' · ' + block.detail : ''));
  } else if (block.type === 'metrics') {
    addText('title', block.title || '指标');
    for (const [i, item] of (block.items || []).slice(0, 6).entries()) {
      addText('metric_' + i, String(item.label || '') + ': ' + String(item.value || '') + String(item.unit || '') + (item.detail ? ' · ' + item.detail : ''));
    }
  } else if (block.type === 'table') {
    addText('title', block.title || '数据表');
    if (Array.isArray(block.columns) && block.columns.length) addText('columns', block.columns.join(' | '));
    for (const [i, row] of (block.rows || []).slice(0, 10).entries()) addText('row_' + i, (row || []).join(' | '));
  } else if (block.type === 'steps') {
    addText('title', block.title || '步骤');
    for (const [i, item] of (block.items || []).slice(0, 8).entries()) {
      addText('step_' + i, String(item.status || 'pending') + ' · ' + String(item.title || '') + (item.detail ? ' · ' + item.detail : ''));
    }
  }
  const cardId = prefix + '_card';
  components.push({ id: cardId, component: 'Card', child: prefix + '_content' });
  components.push({ id: prefix + '_content', component: 'Column', children });
  return { cardId, components };
}

export function toA2UiMessages(blocks, runId = 'run') {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 8) return [];
  const normalized = blocks.filter((block) => block && ['notice', 'status', 'metrics', 'table', 'steps'].includes(block.type));
  if (!normalized.length) return [];
  const surfaceSuffix = String(runId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'run';
  const surfaceId = 'composeops_' + surfaceSuffix;
  const components = [];
  const cards = [];
  normalized.forEach((block, index) => {
    const result = blockComponents(block, index);
    cards.push(result.cardId);
    components.push(...result.components);
  });
  components.unshift({ id: 'root', component: 'Column', children: cards });
  return [{
    version: 'v1.0',
    createSurface: {
      surfaceId,
      catalogId: CATALOG,
      sendDataModel: false,
      components,
      dataModel: {},
    },
  }];
}