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

export function issueSession(reply, secure = false) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  createSession(tokenHash(token), expires.toISOString());
  reply.header('Set-Cookie', [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_DAYS * 86400}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; '));
}

export function clearSession(request, reply) {
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  if (token) deleteSession(tokenHash(token));
  reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
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
    if (originHost.endsWith('.run.app') || originHost.includes('localhost') || originHost.includes('127.0.0.1')) return true;
    return false;
  } catch {
    return false;
  }
}
