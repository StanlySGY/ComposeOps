export function incidentStatusLabel(value) {
  return ({ investigating: '待调查', awaiting_approval: '待审批', queued: '等待执行', executing: '正在处置', verifying: '验证恢复中', needs_attention: '需要人工介入', resolved: '已验证恢复' })[value] || '状态待确认';
}
export function incidentStatusTone(value) {
  return value === 'resolved' ? 'text-status-ok' : ['awaiting_approval', 'needs_attention'].includes(value) ? 'text-status-warn' : 'text-sky-300';
}
export function effectStatusLabel(value) {
  return ({ awaiting_approval: '等待你审批', queued: '已批准，等待执行', leased: '已领取，正在校验', executing: '正在执行', succeeded: '处置完成，等待健康验收', failed: '执行失败', rejected: '执行前校验未通过', cancelled: '已取消', outcome_unknown: '执行结果未知，需要核对' })[value] || value;
}
