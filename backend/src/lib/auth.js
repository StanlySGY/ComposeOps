import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { clearSessions, createSession, deleteSession, getSetting, hasSession, setSetting } from './db.js';

const COOKIE_NAME = 'composeops_session';
const SESSION_DAYS = 30;
let cachedPassword = { raw: null, result: false, expiresAt: 0 };

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

export function isConfigured() {
  return !!getSetting('auth.password_hash', '');
}

export function setPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('密码至少需要 10 个字符');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  setSetting('auth.password_hash', `scrypt$${salt}$${hash}`);
  cachedPassword = { raw: null, result: false, expiresAt: 0 };
}

export function verifyPassword(password) {
  if (cachedPassword.raw === password && Date.now() < cachedPassword.expiresAt) return cachedPassword.result;
  const stored = getSetting('auth.password_hash', '');
  const [, salt, expectedHex] = stored.split('$');
  if (!salt || !expectedHex || typeof password !== 'string') return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  const result = actual.length === expected.length && timingSafeEqual(actual, expected);
  cachedPassword = { raw: password, result, expiresAt: Date.now() + 1000 };
  return result;
}

export function changePassword(currentPassword, nextPassword) {
  if (!verifyPassword(currentPassword)) throw new Error('当前密码错误');
  setPassword(nextPassword);
  clearSessions();
}

/**
 * 跨域嵌入模式(EMBED_MODE=1):Cookie 放开 SameSite 以便在 iframe/第三方上下文里保持登录。
 * 默认 Strict:面板有 Shell/容器控制能力,SameSite=None 会让跨站请求带上会话 Cookie,
 * 等 CSRF 面积扩大;只有真的要跨源嵌入时才该打开。
 */
const embedMode = () => process.env.EMBED_MODE === '1';

export function issueSession(reply, secure = false) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  createSession(tokenHash(token), expires.toISOString());
  // SameSite=None 必须 paired Secure,否则浏览器直接拒收;HTTP 部署退回 Lax 保证登录可用。
  const sameSite = embedMode() && secure
    ? 'SameSite=None; Secure; Partitioned'
    : 'SameSite=Lax';
  reply.header('Set-Cookie', [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    sameSite,
    `Max-Age=${SESSION_DAYS * 86400}`,
  ].join('; '));
}

export function clearSession(request, reply) {
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  if (token) deleteSession(tokenHash(token));
  reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
}

export function isAuthenticated(request) {
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  return !!token && hasSession(tokenHash(token));
}

export function validateOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const reqHost = request.headers['x-forwarded-host'] || request.headers.host;
    if (originHost === reqHost) return true;
    // 反向代理背后 host 可能被改写,x-forwarded-host 一致即放行(不受嵌入模式影响)。
    if (embedMode()) {
      // 嵌入场景:显式托管域名与本地调试页放行;substring 匹配太松,一律用后缀判断。
      if (originHost.endsWith('.run.app')) return true;
      if (originHost === 'localhost' || originHost.endsWith('.localhost') || originHost.startsWith('localhost:') || originHost.startsWith('127.0.0.1:')) return true;
      if (originHost === 'google.com' || originHost.endsWith('.google.com')) return true;
    }
    return false;
  } catch {
    return false;
  }
}
