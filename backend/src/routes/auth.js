import {
  changePassword,
  clearSession,
  isAuthenticated,
  isConfigured,
  issueSession,
  setPassword,
  verifyPassword,
} from '../lib/auth.js';
import { getSetting, setSetting } from '../lib/db.js';
import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * 口令类字段只做类型与长度上限校验,不搬业务规则(如至少 10 位):
 * 1. setPassword/changePassword 已给出更友好的中文报错与 invalid_password 等机器码,
 *    若在 schema 里重复约束会把它们降级成通用的 validation_failed;
 * 2. /login 的失败计数依赖请求走到处理函数,提前 400 会让失败尝试不被计入限流。
 * maxLength 是必要的:scryptSync 对超长输入代价高,未登录接口需要防放大攻击。
 */
const PASSWORD_MAX = 200;
const passwordField = { type: 'string', maxLength: PASSWORD_MAX };

// 登录失败锁定:持久化到 SQLite(服务重启不重置),内存缓存减少读写。
const LOCKOUT_KEY = 'auth.login_lockouts';
let lockoutCache = null;

// 全局失败上限:TRUST_PROXY=1 时 request.ip 可被 X-Forwarded-For 伪造,
// 攻击者换一个 XFF 就能续 5 次尝试;全局计数不随 IP 变化,兜住总量。
const GLOBAL_LOCKOUT_KEY = '__global__';
const GLOBAL_MAX_FAILURES = 100;

function loadLockouts() {
  if (lockoutCache) return lockoutCache;
  try {
    lockoutCache = new Map(Object.entries(JSON.parse(getSetting(LOCKOUT_KEY, '{}'))));
  } catch {
    lockoutCache = new Map();
  }
  return lockoutCache;
}

function saveLockouts() {
  const map = loadLockouts();
  const now = Date.now();
  for (const [key, entry] of map) {
    if (entry.resetAt <= now) map.delete(key);
  }
  setSetting(LOCKOUT_KEY, JSON.stringify(Object.fromEntries(map)));
}

const isSecure = (req) => req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

export default async function authRoutes(fastify) {
  const attempts = {
    get: (key) => loadLockouts().get(key),
    set: (key, entry) => { loadLockouts().set(key, entry); saveLockouts(); },
    delete: (key) => { if (loadLockouts().delete(key)) saveLockouts(); },
  };
  fastify.get('/status', async (request) => ({
    setupRequired: !isConfigured(),
    authenticated: isAuthenticated(request),
  }));

  fastify.post('/setup', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { password: passwordField, setupToken: { type: 'string', maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    if (isConfigured()) return reply.code(409).send({ error: 'already_configured', message: '系统已完成初始配置' });
    // 初始化抢注防护:设置 SETUP_TOKEN 环境变量后,首次 setup 必须携带该令牌
    // (启动时打印在日志里),防止发布到 0.0.0.0 后被同网段先到先得抢注管理员。
    const expectedToken = process.env.SETUP_TOKEN || '';
    if (expectedToken) {
      const provided = String(request.body?.setupToken || '');
      const a = createHash('sha256').update(provided).digest();
      const b = createHash('sha256').update(expectedToken).digest();
      if (!(a.length === b.length && timingSafeEqual(a, b))) {
        return reply.code(401).send({ error: 'setup_token_required', message: '需要启动引导令牌(SETUP_TOKEN,见服务启动日志)' });
      }
    }
    try {
      setPassword(request.body?.password);
      issueSession(reply, isSecure(request));
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: 'invalid_password', message: error.message });
    }
  });

  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { password: passwordField },
      },
    },
  }, async (request, reply) => {
    if (!isConfigured()) return reply.code(409).send({ error: 'setup_required', message: '系统尚未完成初始配置' });
    const key = request.ip;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const entry = attempts.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    const globalEntry = attempts.get(GLOBAL_LOCKOUT_KEY) || { count: 0, resetAt: now + windowMs };
    if (now > globalEntry.resetAt) { globalEntry.count = 0; globalEntry.resetAt = now + windowMs; }
    if (entry.count >= 5) return reply.code(429).send({ error: 'too_many_attempts', message: '登录失败次数过多，请稍后再试' });
    if (globalEntry.count >= GLOBAL_MAX_FAILURES) return reply.code(429).send({ error: 'too_many_attempts', message: '登录失败次数过多(全站)，请稍后再试' });
    if (!verifyPassword(request.body?.password)) {
      entry.count += 1;
      attempts.set(key, entry);
      globalEntry.count += 1;
      attempts.set(GLOBAL_LOCKOUT_KEY, globalEntry);
      return reply.code(401).send({ error: 'invalid_credentials', message: '密码错误' });
    }
    attempts.delete(key);
    issueSession(reply, isSecure(request));
    return { ok: true };
  });

  fastify.post('/logout', async (request, reply) => {
    clearSession(request, reply);
    return { ok: true };
  });

  fastify.post('/password', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { currentPassword: passwordField, nextPassword: passwordField },
      },
    },
  }, async (request, reply) => {
    try {
      changePassword(request.body?.currentPassword, request.body?.nextPassword);
      issueSession(reply, isSecure(request));
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: 'password_change_failed', message: error.message });
    }
  });
}
