import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import path from 'path';
import { fileURLToPath } from 'url';
import serviceRoutes from './routes/services.js';
import projectRoutes from './routes/projects.js';
import aiRoutes from './routes/ai.js';
import agentRoutes from './routes/agent.js';
import systemRoutes from './routes/system.js';
import wsRoutes from './routes/ws.js';
import authRoutes from './routes/auth.js';
import personalRoutes from './routes/personal.js';
import jobRoutes from './routes/jobs.js';
import hostRoutes from './routes/hosts.js';
import opsRoutes from './routes/ops.js';
import inspectionRoutes from './routes/inspection.js';
import cronRoutes from './routes/cron.js';
import metricsRoutes from './routes/metrics.js';
import gitopsRoutes from './routes/gitops.js';
import marketplaceRoutes from './routes/marketplace.js';
import costAnalysisRoutes from './routes/cost-analysis.js';
import cmdbRoutes from './routes/cmdb.js';
import workflowRoutes from './routes/workflow.js';
import eventCenterRoutes from './routes/event-center.js';
import mcpRoutes from './routes/mcp.js';
import docker from './services/docker.js';
import { isAuthenticated, isConfigured, setPassword, validateOrigin } from './lib/auth.js';
import { stopAlertMonitor } from './services/alert-monitor.js';
import { stopHealthAlerter } from './services/health-alerter.js';
import { stopCronScheduler } from './services/cron-scheduler.js';
import { closeAllWorkspaceRunners } from './services/compose-workspace.js';
import { stopAllGitOpsWatchers } from './services/gitops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 无需登录即可访问的认证端点(状态查询/首次设置/登录)。 */
const PUBLIC_AUTH_PATHS = ['/api/v1/auth/status', '/api/v1/auth/setup', '/api/v1/auth/login'];

/**
 * 组装 Fastify 应用但不监听端口,便于 fastify.inject() 做路由级测试。
 * 端口监听与后台任务启动留给 index.js,保持"构建"与"运行"分离。
 * @param {Object} [options]
 * @param {boolean|Object} [options.logger] 传 false 可在测试里静音日志
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp({ logger = { level: process.env.LOG_LEVEL || 'info' } } = {}) {
  const fastify = Fastify({
    trustProxy: true,
    logger,
  });

  // 实时日志与终端共享同一认证边界。
  await fastify.register(websocket, {
    options: { maxPayload: 10 * 1024 * 1024 },
  });

  // dockerode 实例挂载到 fastify 上供 ws 路由使用
  fastify.decorate('docker', docker);

  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss: https:; img-src 'self' data: https: blob:; media-src 'self' https:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; worker-src 'self' blob:; frame-ancestors *;");
    return payload;
  });

  if (!isConfigured() && process.env.ADMIN_PASSWORD) {
    setPassword(process.env.ADMIN_PASSWORD);
  }

  fastify.addHook('onRequest', async (request, reply) => {
    const protectedPath = request.url.startsWith('/api/v1/') || request.url.startsWith('/ws/');
    const pathname = request.url.split('?')[0];
    const publicAuthPath = PUBLIC_AUTH_PATHS.includes(pathname);
    // GitOps webhook 有独立的 token 校验(未配置 token 时端点直接 403),不走会话认证。
    const gitopsWebhookPath = pathname.startsWith('/api/v1/gitops/webhook/');
    if (protectedPath && !publicAuthPath && !gitopsWebhookPath && !isAuthenticated(request)) {
      return reply.code(401).send({ error: 'unauthorized', message: '请先登录' });
    }
    if (request.url.startsWith('/ws/') && !validateOrigin(request)) {
      return reply.code(403).send({ error: 'origin_rejected', message: 'WebSocket 请求来源不可信' });
    }
    if (protectedPath && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !validateOrigin(request)) {
      return reply.code(403).send({ error: 'origin_rejected', message: '请求来源不可信' });
    }
  });

  // Fastify 默认把校验失败渲染成 { error: 'Bad Request' },丢掉了全站统一的机器可读 code。
  // 这里统一收敛成 { error, message },前端 client.js 读 message || error 才能拿到有效提示。
  fastify.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      const context = error.validationContext || 'body';
      const first = error.validation[0] || {};
      const field = String(first.instancePath || '').replace(/^\//, '').replace(/\//g, '.');
      const detail = field ? `${field} ${first.message}` : first.message || error.message;
      return reply.code(400).send({
        error: 'validation_failed',
        message: `请求参数校验失败(${context}):${detail}`,
      });
    }
    const statusCode = Number(error.statusCode) >= 400 ? Number(error.statusCode) : 500;
    if (statusCode >= 500) {
      // 未捕获异常的原文只进日志,响应里不外泄内部细节。
      fastify.log.error({ err: error.message, stack: error.stack, url: request.url }, 'unhandled route error');
      return reply.code(statusCode).send({ error: 'internal_error', message: '服务器内部错误,请查看后端日志' });
    }
    return reply.code(statusCode).send({
      error: error.code ? String(error.code).toLowerCase() : 'request_failed',
      message: error.message || '请求处理失败',
    });
  });

  // REST API 前缀：/api/v1
  await fastify.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(serviceRoutes, { prefix: '/services' });
      await api.register(projectRoutes, { prefix: '/projects' });
      await api.register(aiRoutes, { prefix: '/ai' });
      await api.register(agentRoutes, { prefix: '/ai' });
      await api.register(systemRoutes, { prefix: '/system' });
      await api.register(personalRoutes, { prefix: '/personal' });
      await api.register(jobRoutes, { prefix: '/jobs' });
      await api.register(hostRoutes, { prefix: '/hosts' });
      await api.register(opsRoutes, { prefix: '/ops' });
      await api.register(inspectionRoutes, { prefix: '/ops' });
      await api.register(cronRoutes, { prefix: '/cron' });
      await api.register(metricsRoutes, { prefix: '/metrics' });
      await api.register(gitopsRoutes, { prefix: '/gitops' });
      await api.register(marketplaceRoutes, { prefix: '/marketplace' });
      await api.register(costAnalysisRoutes, { prefix: '/cost-analysis' });
      await api.register(cmdbRoutes, { prefix: '/cmdb' });
      await api.register(workflowRoutes, { prefix: '/workflows' });
      await api.register(eventCenterRoutes, { prefix: '/events' });
    },
    { prefix: '/api/v1' }
  );

  // WebSocket 路由前缀（不经过 /api/v1，便于代理区分）
  await fastify.register(wsRoutes, { prefix: '/ws' });

  // MCP 协议端点(不经过 /api/v1 会话鉴权:使用独立 token,见 routes/mcp.js 安全模型)
  await fastify.register(mcpRoutes, { prefix: '/mcp' });

  // 健康检查:探测 Docker socket 连通性,失败返回 503 便于编排层重启/摘流。
  fastify.get('/health', async (request, reply) => {
    const started = Date.now();
    try {
      await Promise.race([
        docker.ping(),
        new Promise((_, rejectPing) => setTimeout(() => rejectPing(new Error('docker ping 超时')), 3000).unref()),
      ]);
      return { status: 'ok', docker: 'ok', latencyMs: Date.now() - started, ts: Date.now() };
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'health check: docker unreachable');
      return reply.code(503).send({
        status: 'degraded',
        docker: 'unreachable',
        error: err.message,
        latencyMs: Date.now() - started,
        ts: Date.now(),
      });
    }
  });

  // 生产环境静态托管前端 dist。
  if (process.env.SERVE_FRONTEND !== '0') {
    const staticRoot = path.join(__dirname, '../../frontend/dist');
    try {
      const fastifyStatic = (await import('@fastify/static')).default;
      // decorateReply 保持默认 true:下方 SPA fallback 依赖 reply.sendFile。
      await fastify.register(fastifyStatic, {
        root: staticRoot,
        prefix: '/',
      });
      // SPA fallback
      fastify.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
          return reply.code(404).send({ error: 'not_found' });
        }
        return reply.sendFile('index.html');
      });
    } catch {
      fastify.log.warn('frontend dist not found, skipping static serving');
    }
  }

  fastify.addHook('onClose', async () => {
    stopAlertMonitor();
    stopHealthAlerter();
    stopCronScheduler();
    stopAllGitOpsWatchers();
    await closeAllWorkspaceRunners();
  });

  return fastify;
}

export default buildApp;
