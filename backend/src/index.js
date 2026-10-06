import { buildApp } from './app.js';
import { startAlertMonitor } from './services/alert-monitor.js';

try { process.loadEnvFile?.(); } catch {}
import { startHealthAlerter } from './services/health-alerter.js';
import { startCronScheduler } from './services/cron-scheduler.js';
import { startInspectionScheduler } from './services/inspection.js';
import { initializeBackgroundJobs } from './services/background-jobs.js';
import { initGitOps } from './services/gitops.js';
import { startMetricsCollection } from './services/metrics-collector.js';
import { startDataMaintenance } from './services/maintenance.js';
import { getCostAnalysisReport } from './services/cost-analysis.js';

const PORT = parseInt(process.env.APP_PORT || (process.env.PORT && process.env.PORT !== '8080' ? process.env.PORT : '3000'), 10);
const HOST = process.env.HOST || '0.0.0.0';

// 成本页首访要逐容器拉 stats、跑 docker df,较慢;后台按缓存 TTL 预热,
// 用户打开成本页时直接命中缓存(缓存见 cost-analysis.js 的 withCostCache)
const COST_WARMUP_MS = 2 * 60 * 1000;
function startCostWarmup() {
  const run = () => getCostAnalysisReport().catch(() => {});
  run();
  const timer = setInterval(run, COST_WARMUP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// 进程级兜底:代码里存在多处 fire-and-forget(void fn()),一旦某条路径漏 catch,
// 没有这个网就是进程级崩溃。unhandledRejection 记日志不退出(单用户面板可用性优先);
// uncaughtException 记日志后走优雅退出——异常状态下继续运行风险更大。
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[process] Uncaught exception:', error);
  void shutdown('uncaughtException');
});

const fastify = await buildApp();

// 各后台定时器的停止句柄:此前 metrics/巡检/成本预热的定时器启动后无人持有,
// 优雅退出期间仍可能触发一轮 Docker 采集/DB 写。
let stopMetricsTimers = null;
let stopCostWarmup = null;

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
    const metricsTimers = startMetricsCollection(metricsIntervalSeconds); // 默认 30 秒,可通过环境变量调整(最小 5 秒)
    stopMetricsTimers = () => {
      if (metricsTimers?.intervalId) clearInterval(metricsTimers.intervalId);
      if (metricsTimers?.pruneIntervalId) clearInterval(metricsTimers.pruneIntervalId);
    };
    startDataMaintenance(); // 周期清理 ai_history / operation_history / agent_plans / compose_backups
    stopCostWarmup = startCostWarmup();
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
  try { stopMetricsTimers?.(); } catch { /* 未启动时无需清理 */ }
  try { stopCostWarmup?.(); } catch { /* 未启动时无需清理 */ }
  try {
    const { stopInspectionScheduler } = await import('./services/inspection.js');
    stopInspectionScheduler();
  } catch { /* 巡检模块加载失败时无需清理 */ }
  await Promise.race([
    fastify.close().catch((error) => fastify.log.error(error)),
    // SSE 长连接可能让 close 久等:10 秒后强制退出,容器编排不依赖无限等待
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

start();
