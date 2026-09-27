import { buildApp } from './app.js';
import { startAlertMonitor } from './services/alert-monitor.js';
import { startHealthAlerter } from './services/health-alerter.js';
import { startCronScheduler } from './services/cron-scheduler.js';
import { startInspectionScheduler } from './services/inspection.js';
import { initializeBackgroundJobs } from './services/background-jobs.js';
import { initGitOps } from './services/gitops.js';
import { startMetricsCollection } from './services/metrics-collector.js';
import { startDataMaintenance } from './services/maintenance.js';
import { getCostAnalysisReport } from './services/cost-analysis.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

// 成本页首访要逐容器拉 stats、跑 docker df,较慢;后台按缓存 TTL 预热,
// 用户打开成本页时直接命中缓存(缓存见 cost-analysis.js 的 withCostCache)
const COST_WARMUP_MS = 2 * 60 * 1000;
function startCostWarmup() {
  const run = () => getCostAnalysisReport().catch(() => {});
  run();
  const timer = setInterval(run, COST_WARMUP_MS);
  timer.unref?.();
}

const fastify = await buildApp();

const start = async () => {
  try {
    const interruptedJobs = initializeBackgroundJobs();
    if (interruptedJobs.length) fastify.log.warn({ jobs: interruptedJobs }, 'marked unfinished background jobs as interrupted');
    await fastify.listen({ port: PORT, host: HOST });
    startAlertMonitor();
    startHealthAlerter();
    startCronScheduler();
    startInspectionScheduler(); // 自动巡检(默认关闭,按 setting 的间隔触发,见 inspection.js)
    initGitOps();
    const metricsIntervalSeconds = Number(process.env.METRICS_INTERVAL_SECONDS || 30);
    startMetricsCollection(metricsIntervalSeconds); // 默认 30 秒,可通过环境变量调整(最小 5 秒)
    startDataMaintenance(); // 周期清理 ai_history / operation_history / agent_plans / compose_backups
    startCostWarmup();
    fastify.log.info(`OpsDash backend listening on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info({ signal }, 'shutting down');
  await fastify.close().catch((error) => fastify.log.error(error));
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

start();
