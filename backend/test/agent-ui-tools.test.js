import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAgentUiBlocks } from '../src/services/tools/ui-tools.js';
import { toPublicAgentEvent } from '../src/lib/agent-public-events.js';

test('trusted UI catalog normalizes supported blocks and bounds collection sizes', () => {
  const blocks = normalizeAgentUiBlocks([
    { type: 'status', title: 'API', status: 'healthy', detail: '响应正常' },
    { type: 'metrics', title: '资源', items: [{ label: 'CPU', value: '42', unit: '%' }, { label: '内存', value: '1.2', unit: 'GB' }] },
    { type: 'table', title: '服务', columns: ['名称', '状态'], rows: [['api', '运行中']] },
    { type: 'steps', title: '执行进度', items: [{ title: '检查', status: 'done' }, { title: '部署', status: 'active' }] },
  ]);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].status, 'healthy');
  assert.equal(blocks[1].items[0].unit, '%');
  assert.deepEqual(blocks[2].rows[0], ['api', '运行中']);
  assert.equal(blocks[3].items[1].status, 'active');
});

test('trusted UI catalog rejects arbitrary HTML and redacts secret-looking values', () => {
  assert.throws(() => normalizeAgentUiBlocks([{ type: 'html', html: '<script>alert(1)</script>' }]), /不受信任/);
  const [block] = normalizeAgentUiBlocks([{ type: 'notice', text: 'token=sk-abcdefgh12345678' }]);
  assert.equal(block.text.includes('sk-abcdefgh12345678'), false);
  assert.throws(() => normalizeAgentUiBlocks([]), /1–8/);
});

test('public Agent events only expose the normalized structured UI payload', () => {
  const event = toPublicAgentEvent({
    type: 'tool_result', tool: 'ui.present',
    result: { success: true, result: { blocks: [{ type: 'notice', title: '完成', text: '结果' }], note: 'internal' } },
  });
  assert.deepEqual(event, { type: 'ui_present', blocks: [{ type: 'notice', title: '完成', text: '结果' }] });
});
