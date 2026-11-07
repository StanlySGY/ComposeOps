// A closed stream is not proof that an operation succeeded. Only an explicit
// exit/result frame may confirm completion, and failed verification wins.
export function applyOperationFrame(output, frame) {
  if (frame.type === 'stdout' || frame.type === 'stderr') output.text += frame.data || '';
  else if (frame.type === 'error') {
    output.failureReason = String(frame.data || '操作执行失败');
    output.text += `\n[错误] ${output.failureReason}`;
  } else if (frame.type === 'exit' && Number.isInteger(frame.data?.code)) {
    output.exitCode = frame.data.code;
    output.text += `\n[退出码 ${frame.data.code}]`;
  } else if (frame.type === 'result') {
    output.resultConfirmed = frame.data?.ok === true && frame.data?.upgraded === true && !frame.data?.degraded;
    if (frame.data?.ok === false) output.failureReason = frame.data.message || '操作未成功完成';
    else if (frame.data?.degraded) output.failureReason = '升级后容器未通过健康检查，可在活动或备份中回滚';
    if (output.failureReason) output.text += `\n[验收未通过] ${output.failureReason}`;
  }
}

export function operationSucceeded(output, { requireResult = false } = {}) {
  return output.exitCode === 0 && !output.failureReason && (!requireResult || output.resultConfirmed === true);
}
