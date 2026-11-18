/** AG-UI 1.0 adapter for the ComposeOps Tool Loop. Only public, redacted events enter this adapter. */
import { toA2UiMessages } from './agent-a2ui.js';

export function createAgUiAdapter({ threadId = 'default', runId = 'run' } = {}) {
  const state = { started: false, messageStarted: false, finished: false, messageId: 'assistant-' + runId, activeTools: new Map(), step: 0 };
  const started = () => {
    if (state.started) return [];
    state.started = true;
    return [{ type: 'RUN_STARTED', threadId: String(threadId), runId: String(runId) }];
  };
  const messageStart = () => {
    if (state.messageStarted) return [];
    state.messageStarted = true;
    return [{ type: 'TEXT_MESSAGE_START', messageId: state.messageId, role: 'assistant' }];
  };
  const messageEnd = () => {
    if (!state.messageStarted) return [];
    state.messageStarted = false;
    return [{ type: 'TEXT_MESSAGE_END', messageId: state.messageId }];
  };
  const custom = (event) => ({ type: 'CUSTOM', name: 'composeops.' + String(event.type || 'event').slice(0, 64), value: event });

  return {
    map(event) {
      if (!event || typeof event !== 'object' || state.finished) return [];
      const output = started();
      if (event.type === 'token') {
        output.push(...messageStart());
        if (event.content) output.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: state.messageId, delta: String(event.content) });
        return output;
      }
      if (event.type === 'tool_requested') {
        output.push(...messageStart());
        const toolCallId = String(event.toolCallId || ('tool-' + state.step++));
        const toolCallName = String(event.tool || 'unknown').slice(0, 128);
        state.activeTools.set(toolCallId, { toolCallName, messageId: state.messageId });
        output.push({ type: 'TOOL_CALL_START', toolCallId, toolCallName, parentMessageId: state.messageId });
        const args = String(event.paramsText || '{}').slice(0, 800);
        if (args) output.push({ type: 'TOOL_CALL_ARGS', toolCallId, delta: args });
        output.push({ type: 'TOOL_CALL_END', toolCallId });
        output.push(custom(event));
        return output;
      }
      if (event.type === 'tool_result' || event.type === 'tool_error' || event.type === 'tool_rejected') {
        const toolCallId = String(event.toolCallId || '');
        const active = state.activeTools.get(toolCallId);
        if (active) {
          const content = JSON.stringify({
            success: event.type === 'tool_result' && !!event.success,
            status: event.type === 'tool_result' ? (event.success ? 'completed' : 'failed') : event.type === 'tool_rejected' ? 'rejected' : 'failed',
            summary: String(event.summary || '').slice(0, 600),
            error: String(event.error || event.reason || '').slice(0, 400),
            durationMs: Number(event.durationMs || 0),
          });
          output.push({ type: 'TOOL_CALL_RESULT', toolCallId, messageId: 'tool-result-' + toolCallId, content });
        }
        output.push({ type: 'STEP_FINISHED', stepName: active?.toolCallName || String(event.tool || 'tool') });
        if (toolCallId) state.activeTools.delete(toolCallId);
        output.push(custom(event));
        return output;
      }
      if (event.type === 'tool_executing') {
        output.push({ type: 'STEP_STARTED', stepName: String(event.tool || 'tool') });
        output.push(custom(event));
        return output;
      }
      if (event.type === 'done') {
        if (!state.messageStarted && event.content) {
          output.push(...messageStart());
          output.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: state.messageId, delta: String(event.content) });
        }
        output.push(custom(event));
        output.push(...messageEnd());
        output.push({ type: 'RUN_FINISHED', threadId: String(threadId), runId: String(runId) });
        state.finished = true;
        return output;
      }
      if (event.type === 'error') {
        output.push(...messageEnd());
        output.push({ type: 'RUN_ERROR', message: String(event.content || event.error || 'Agent execution failed').slice(0, 1000), code: 'AGENT_EXECUTION_FAILED' });
        state.finished = true;
        return output;
      }
      if (event.type === 'ui_present' && Array.isArray(event.blocks)) {
        const toolCallId = String(event.toolCallId || '');
        if (toolCallId && state.activeTools.has(toolCallId)) {
          output.push({ type: 'TOOL_CALL_RESULT', toolCallId, messageId: 'tool-result-' + toolCallId, content: '结构化 UI 已生成' });
          output.push({ type: 'STEP_FINISHED', stepName: state.activeTools.get(toolCallId).toolCallName });
          state.activeTools.delete(toolCallId);
        }
        output.push(custom(event));
        for (const message of toA2UiMessages(event.blocks, runId + '-' + (event.toolCallId || 'ui-' + state.step++))) output.push({ type: 'CUSTOM', name: 'a2ui.message', value: message });
        return output;
      }
      if (event.type === 'context_data') {
        const toolCallId = String(event.toolCallId || '');
        const active = state.activeTools.get(toolCallId);
        if (toolCallId && active) {
          output.push({ type: 'TOOL_CALL_RESULT', toolCallId, messageId: 'tool-result-' + toolCallId, content: '上下文数据已返回' });
          output.push({ type: 'STEP_FINISHED', stepName: active.toolCallName });
          state.activeTools.delete(toolCallId);
        }
        output.push(custom(event));
        return output;
      }
      if (event.type === 'trace') {
        output.push({ type: 'ACTIVITY_DELTA', activityType: 'composeops.trace', activityId: String(event.phase || 'agent'), delta: String(event.content || '').slice(0, 200) });
        return output;
      }
      if (event.type === 'thinking') {
        output.push({ type: 'STEP_STARTED', stepName: 'thinking-' + (Number(event.round) || 1) });
        output.push(custom(event));
        return output;
      }
      output.push(custom(event));
      return output;
    },
  };
}