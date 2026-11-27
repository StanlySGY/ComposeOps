// A closed stream is not proof that an operation succeeded. Only an explicit
// exit/result frame may confirm completion, and failed verification wins.
const OUTPUT_LIMIT = 65536;
const TRUNCATED = '[输出已截断，以下为最新内容]\n';
export function boundOperationOutput(value) {
  const text = String(value ?? '');
  return text.length <= OUTPUT_LIMIT ? text : TRUNCATED + text.slice(-(OUTPUT_LIMIT - TRUNCATED.length));
}
export function appendOperationOutput(current, value) {
  return boundOperationOutput(String(current ?? '') + String(value ?? ''));
}
export function applyOperationFrame(output, frame) {
  if (frame.type === 'stdout' || frame.type === 'stderr') output.text += frame.data || '';
  else if (frame.type === 'output') output.text = String(frame.data || '');
  else if (frame.type === 'error') {
    output.failureReason = String(frame.data || '操作执行失败').slice(0, 2000);
    output.text += `\n[错误] ${output.failureReason}`;
  } else if (frame.type === 'exit' && Number.isInteger(frame.data?.code)) {
    output.exitCode = frame.data.code;
    output.text += `\n[退出码 ${frame.data.code}]`;
  } else if (frame.type === 'result') {
    output.resultConfirmed = frame.data?.ok === true && frame.data?.upgraded === true && !frame.data?.degraded;
    if (frame.data?.ok === false) output.failureReason = String(frame.data.message || '操作未成功完成').slice(0, 2000);
    else if (frame.data?.degraded) output.failureReason = '升级后容器未通过健康检查，可在活动或备份中回滚';
    if (output.failureReason) output.text += `\n[验收未通过] ${output.failureReason}`;
  }
  output.text = boundOperationOutput(output.text);
}

export function operationSucceeded(output, { requireResult = false } = {}) {
  return output.exitCode === 0 && !output.failureReason && (!requireResult || output.resultConfirmed === true);
}
