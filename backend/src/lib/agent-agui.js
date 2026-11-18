/** Minimal AG-UI event adapter for the existing Agent Tool Loop stream. */
export function createAgUiAdapter({ threadId = 'default', runId = 'run' } = {}) {
  const state = { started: false, messageStarted: false, finished: false, messageId: `assistant-${runId}` };
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
  return {
    map(event) {
      if (!event || typeof event !== 'object' || state.finished) return [];
      const output = started();
      if (event.type === 'token') {
        output.push(...messageStart());
        if (event.content) output.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: state.messageId, delta: String(event.content) });
        return output;
      }
      if (event.type === 'done') {
        if (!state.messageStarted && event.content) {
          output.push(...messageStart());
          output.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: state.messageId, delta: String(event.content) });
        }
        if (state.messageStarted) output.push({ type: 'TEXT_MESSAGE_END', messageId: state.messageId });
        output.push({ type: 'RUN_FINISHED', threadId: String(threadId), runId: String(runId) });
        state.finished = true;
        return output;
      }
      if (event.type === 'error') {
        output.push({ type: 'RUN_ERROR', message: String(event.content || event.error || 'Agent execution failed'), code: 'AGENT_EXECUTION_FAILED' });
        state.finished = true;
        return output;
      }
      output.push({ type: 'CUSTOM', name: `composeops.${String(event.type || 'event').slice(0, 64)}`, value: event });
      return output;
    },
  };
}
