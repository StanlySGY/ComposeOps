import db from '../../lib/db.js';
import { getSreChange } from '../sre-changes.js';
import { getBusinessBackup, getBusinessRun } from '../sre-business-recovery.js';
import { getOnboarding } from '../sre-onboarding.js';
import { redactSecretValue } from '../../lib/secret-redactor.js';

export function durableOperation(kind, row) {
  const running = ['queued', 'running', 'checking', 'executing', 'verifying', 'rolling_back', 'verifying_rollback', 'applying'].includes(row.status);
  const unknown = ['outcome_unknown', 'rollback_failed'].includes(row.status);
  const verified = kind === 'business-run' ? row.status === 'passed' && row.result?.businessRecoveryVerified === true && row.result?.rpoMet === true && row.result?.rtoMet === true && row.result?.cleanupComplete === true
    : kind === 'change' ? row.status === 'succeeded' : false;
  return { operation: { kind, view: kind === 'change' && row.review?.recipe === 'pinned-image-v1' ? 'changes' : kind === 'change' ? 'releases' : kind === 'onboarding' ? 'onboarding' : 'business', id: row.id, status: row.status, hostId: row.hostId || row.snapshot?.plan?.hostId, projectId: row.projectId || row.snapshot?.plan?.projectId,
    running, needsReconciliation: unknown, businessVerified: verified, canReplay: false },
    verification: { status: running ? 'pending' : unknown ? 'unknown' : verified ? 'passed' : 'not_verified',
      reason: running ? '已提交，尚未完成业务验收；可刷新状态或查看执行证据。' : unknown ? '执行结果未知，必须核对实际资源，禁止自动重放。' : verified ? '专用执行器已完成验收。' : kind === 'onboarding' ? (row.status === 'complete' ? '接入配置已保存；应用健康与恢复能力仍需后续观测和演练验证。' : '接入尚未完成，请查看已保存步骤并重新审阅。') : '请依据记录证据判断；备份校验、回退或关闭记录不代表本次目标业务已验收。' }, record: row };
}

export function readDurableOperation(p) {
  const getter = { change: getSreChange, 'business-backup': getBusinessBackup, 'business-run': getBusinessRun, onboarding: getOnboarding }[p.kind];
  if (!getter) throw Object.assign(new Error('任务类型无效'), { statusCode: 400 });
  const row = getter(p.id), target = row.snapshot?.plan || row;
  if (target.hostId !== p.hostId || target.projectId !== p.projectId) throw Object.assign(new Error('记录不属于指定节点与项目'), { statusCode: 403 });
  const result = durableOperation(p.kind, row);
  if (p.kind === 'business-backup' && row.snapshot?.drillAfter) {
    const children = db.prepare('SELECT id FROM sre_business_runs WHERE plan_id=? AND json_extract(snapshot_json, \'$.backup.id\')=? ORDER BY created_at DESC LIMIT 20').all(row.planId, row.id);
    result.relatedOperations = children.map(child => readDurableOperation({ ...p, kind: 'business-run', id: child.id }));
    if (row.status === 'verified' && !children.length) {
      result.operation.needsReconciliation = true;
      result.verification = { status: 'unknown', reason: row.result?.recoveryQueueError ? '备份已校验，但恢复演练未入队：' + row.result.recoveryQueueError : '备份已校验，但后续恢复演练记录不可用，请核对；未自动重放。' };
    }
  }
  return result;
}

/** Rebuild a session's durable operation references after reconnect, without replaying tools. */
export function listSessionOperations(sessionId) {
  const rows = db.prepare(`SELECT e.result FROM agent_executions e JOIN agent_plans p ON p.id=e.plan_id
    WHERE p.session_id=? AND e.result IS NOT NULL AND e.tool_name LIKE 'sre.%'
    ORDER BY e.created_at DESC,e.rowid DESC LIMIT 200`).all(sessionId);
  const seen = new Set(), operations = [];
  function append(current) {
    const key = current.operation.kind + ':' + current.operation.id;
    if (seen.has(key) || operations.length >= 20) return;
    seen.add(key); operations.push({ operation: current.operation, verification: current.verification });
    for (const child of current.relatedOperations || []) append(child);
  }
  for (const row of rows) {
    let ref; try { ref = JSON.parse(row.result)?.operation; } catch { continue; }
    if (!ref?.id || seen.has(ref.kind + ':' + ref.id)) continue;
    try { append(readDurableOperation(ref)); }
    catch { append({ operation: { kind: ref.kind, view: ref.view, id: ref.id, hostId: ref.hostId, projectId: ref.projectId, status: 'unavailable', running: false, needsReconciliation: true, businessVerified: false, canReplay: false }, verification: { status: 'unknown', reason: '无法读取记录，请在可靠性页面核对；未重放任务。' } }); }
    if (operations.length >= 20) break;
  }
  return redactSecretValue({ operations });
}
