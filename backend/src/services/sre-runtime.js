import db from '../lib/db.js';
import { workerHeartbeat } from './sre-heartbeats.js';
import { executeDiagnosisEvaluation, recoverDiagnosisEvaluations } from './diagnosis-evaluation.js';
import { executeSreChange, recoverSreChanges } from './sre-changes.js';
import { executeRecoveryRun, scheduleRecoveryRuns, recoverRecoveryRuns } from './sre-recovery.js';
import { executeBusinessBackup, executeBusinessRun, scheduleBusinessRecovery, recoverBusinessJobs } from './sre-business-recovery.js';
import { recoverOnboarding } from './sre-onboarding.js';
export function recoverSreRuntime() {
  const changes = recoverSreChanges(), drills = recoverRecoveryRuns();
  recoverDiagnosisEvaluations();
  recoverBusinessJobs();
  recoverOnboarding();
  db.prepare("UPDATE sre_retrospectives SET status='failed',error='复盘生成被进程中断，可重新发起' WHERE status='generating'").run();
  return { changes, drills };
}
export function createSreRuntime({ change = executeSreChange, drill = executeRecoveryRun, evaluate = executeDiagnosisEvaluation, businessBackup = executeBusinessBackup, businessRun = executeBusinessRun, schedule = scheduleRecoveryRuns, scheduleBusiness = scheduleBusinessRecovery, logger = console, intervalMs = 5000 } = {}) {
  let timer, pending = null, stopped = true, workStartedAt = null;
  function runOnce() {
    if (!pending) pending = (async () => {
      workStartedAt = Date.now();
      workerHeartbeat('sre-runtime', { state: 'working', workStartedAt });
      schedule();
      scheduleBusiness();
      const next = db.prepare("SELECT id FROM sre_changes WHERE status='queued' ORDER BY created_at LIMIT 1").get();
      if (next) return change(next.id);
      const recovery = db.prepare("SELECT id FROM sre_recovery_runs WHERE status='queued' ORDER BY created_at LIMIT 1").get();
      if (recovery) return drill(recovery.id);
      const backup = db.prepare("SELECT id FROM sre_business_backups WHERE status='queued' ORDER BY created_at LIMIT 1").get();
      if (backup) return businessBackup(backup.id);
      const business = db.prepare("SELECT id FROM sre_business_runs WHERE status='queued' ORDER BY created_at LIMIT 1").get();
      if (business) return businessRun(business.id);
      const evaluation = db.prepare("SELECT id FROM sre_diagnosis_evaluations WHERE status='queued' ORDER BY created_at LIMIT 1").get();
      if (evaluation) return evaluate(evaluation.id);
      return null;
    })().finally(() => { pending = null; workStartedAt = null; workerHeartbeat('sre-runtime', { state: stopped ? 'stopped' : 'idle', progress: true }); });
    return pending;
  }
  const tick = () => { if (stopped) return; workerHeartbeat('sre-runtime', { state: pending ? 'working' : 'idle', workStartedAt }); void runOnce().catch(error => { workerHeartbeat('sre-runtime', { state: 'error', error: error.message }); logger.warn?.({ message: error.message }, '可靠性执行器暂未完成'); }); };
  return { runOnce, start() { if (!stopped) return; stopped = false; tick(); timer = setInterval(tick, intervalMs); timer.unref?.(); }, async stop() { stopped = true; clearInterval(timer); await pending; } };
}
let runtime;
export function startSreRuntime(options) { if (!runtime) { runtime = createSreRuntime(options); runtime.start(); } }
export async function stopSreRuntime() { const current = runtime; runtime = null; await current?.stop(); }
