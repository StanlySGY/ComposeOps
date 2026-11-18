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
    type: 'tool_result', toolCallId: 'ui-call-1', tool: 'ui.present',
    result: { success: true, result: { blocks: [{ type: 'notice', title: '完成', text: '结果' }], note: 'internal' } },
  });
  assert.deepEqual(event, { type: 'ui_present', toolCallId: 'ui-call-1', blocks: [{ type: 'notice', title: '完成', text: '结果' }] });
});

test('browser preview is bounded, only emitted for web.interact, and excludes raw page DOM from the public payload', () => {
  const screenshotBase64 = 'A'.repeat(1024);
  const event = toPublicAgentEvent({
    type: 'tool_result', toolCallId: 'browser-call-1', tool: 'web.interact',
    result: { success: true, durationMs: 25, result: { untrusted: true, page: { title: 'Example', url: 'https://example.com/', snapshot: 'private page body', screenshotBase64 } } },
  });
  assert.equal(event.type, 'tool_result');
  assert.equal(event.browserPreview.title, 'Example');
  assert.equal(event.browserPreview.screenshotBase64, screenshotBase64);
  assert.equal(JSON.stringify(event).includes('private page body'), false);
  const oversized = toPublicAgentEvent({
    type: 'tool_result', toolCallId: 'browser-call-2', tool: 'web.interact',
    result: { success: true, result: { page: { screenshotBase64: 'A'.repeat(120001) } } },
  });
  assert.equal(oversized.browserPreview, undefined);
});
