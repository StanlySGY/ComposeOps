import db from '../lib/db.js';
import { executeSreChange, recoverSreChanges } from './sre-changes.js';
import { executeRecoveryRun, scheduleRecoveryRuns, recoverRecoveryRuns } from './sre-recovery.js';
export function recoverSreRuntime() {
  const changes = recoverSreChanges(), drills = recoverRecoveryRuns();
  db.prepare("UPDATE sre_retrospectives SET status='failed',error='复盘生成被进程中断，可重新发起' WHERE status='generating'").run();
  return { changes, drills };
}
export function createSreRuntime({ change = executeSreChange, drill = executeRecoveryRun, schedule = scheduleRecoveryRuns, logger = console, intervalMs = 5000 } = {}) {
  let timer, pending = null, stopped = true;
  function runOnce() {
    if (!pending) pending = (async () => {
      schedule();
      const next = db.prepare("SELECT id FROM sre_changes WHERE status='queued' ORDER BY created_at LIMIT 1").get();
      if (next) return change(next.id);
      const recovery = db.prepare("SELECT id FROM sre_recovery_runs WHERE status='queued' ORDER BY created_at LIMIT 1").get();
      if (recovery) return drill(recovery.id);
      return null;
    })().finally(() => { pending = null; });
    return pending;
  }
  const tick = () => { if (!stopped) void runOnce().catch(error => logger.warn?.({ message: error.message }, '可靠性执行器暂未完成')); };
  return { runOnce, start() { if (!stopped) return; stopped = false; tick(); timer = setInterval(tick, intervalMs); timer.unref?.(); }, async stop() { stopped = true; clearInterval(timer); await pending; } };
}
let runtime;
export function startSreRuntime(options) { if (!runtime) { runtime = createSreRuntime(options); runtime.start(); } }
export async function stopSreRuntime() { const current = runtime; runtime = null; await current?.stop(); }
