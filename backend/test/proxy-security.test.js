import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const tempDir = mkdtempSync(join(tmpdir(), 'composeops-proxy-security-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.SERVE_FRONTEND = '0';
process.env.EMBED_MODE = '0';
process.env.TRUST_PROXY = '0';

const { buildApp } = await import('../src/app.js');

const app = await buildApp({ logger: false });
const trustedApps = [];
await app.ready();

test('proxy security: untrusted forwarded host cannot bypass Origin validation', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: {
      host: 'internal.local:3001',
      origin: 'https://attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    },
    payload: { password: 'not-used-before-origin-check' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'origin_rejected');
});

test('proxy security: untrusted X-Forwarded-Proto cannot cause an insecure request to issue Secure cookies', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: {
      host: 'internal.local:3001',
      origin: 'http://internal.local:3001',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    },
    payload: { password: 'proxy-security-test-password' },
  });
  assert.equal(response.statusCode, 200);
  const cookie = String(response.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /;\s*Secure(?:;|$)/i);
});

test('proxy security: configured reverse proxy host/protocol are trusted and HTTPS cookies are Secure', async () => {
  await app.close();
  process.env.TRUST_PROXY = '1';
  const trustedApp = await buildApp({ logger: false });
  trustedApps.push(trustedApp);
  await trustedApp.ready();

  const headers = {
    host: 'internal.local:3001',
    origin: 'https://compose.example.test',
    'x-forwarded-host': 'compose.example.test',
    'x-forwarded-proto': 'https',
  };
  const response = await trustedApp.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers,
    payload: { password: 'proxy-security-test-password' },
  });
  assert.equal(response.statusCode, 200);
  const cookie = String(response.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);

  const logout = await trustedApp.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { ...headers, cookie: cookie.split(';', 1)[0] },
  });
  assert.equal(logout.statusCode, 200);
  assert.match(String(logout.headers['set-cookie']), /Secure/);
});

test.after(async () => {
  await Promise.all(trustedApps.map((instance) => instance.close()));
  rmSync(tempDir, { recursive: true, force: true });
});

