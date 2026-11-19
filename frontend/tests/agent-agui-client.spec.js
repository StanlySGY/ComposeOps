import { describe, expect, it } from 'vitest';
import { normalizeAgUiEvent } from '../src/api/client.js';

describe('AG-UI frontend event normalization', () => {
  it('maps standard text and run lifecycle events into the existing chat state machine', () => {
    expect(normalizeAgUiEvent({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hello' })).toEqual({ type: 'token', content: 'hello' });
    expect(normalizeAgUiEvent({ type: 'RUN_FINISHED', runId: 'r1' })).toBeNull();
    expect(normalizeAgUiEvent({ type: 'RUN_ERROR', message: 'upstream failed' })).toEqual({ type: 'error', content: 'upstream failed' });
  });

  it('unwraps only ComposeOps custom events and ignores A2UI envelopes in the native renderer path', () => {
    const native = { type: 'ui_present', toolCallId: 'c1', blocks: [{ type: 'notice', title: 'done' }] };
    expect(normalizeAgUiEvent({ type: 'CUSTOM', name: 'composeops.ui_present', value: native })).toEqual(native);
    expect(normalizeAgUiEvent({ type: 'CUSTOM', name: 'a2ui.message', value: { version: 'v1.0' } })).toBeNull();
    expect(normalizeAgUiEvent({ type: 'CUSTOM', name: 'untrusted.extension', value: { script: 'alert(1)' } })).toBeNull();
  });

  it('accepts the allowlisted native ComposeOps SSE envelope as a compatibility fallback', () => {
    const token = { type: 'token', content: 'legacy stream' };
    const approval = { type: 'confirmation_required', tool: 'compose.up', params: { projectId: 'p1' } };
    expect(normalizeAgUiEvent(token)).toEqual(token);
    expect(normalizeAgUiEvent(approval)).toEqual(approval);
    expect(normalizeAgUiEvent({ type: 'untrusted.extension', script: 'alert(1)' })).toBeNull();
  });

  it('does not treat partial tool argument events as executable frontend actions', () => {
    expect(normalizeAgUiEvent({ type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'compose.up' })).toBeNull();
    expect(normalizeAgUiEvent({ type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"projectId":"p"}' })).toBeNull();
    expect(normalizeAgUiEvent({ type: 'TOOL_CALL_END', toolCallId: 'c1' })).toBeNull();
  });
});
