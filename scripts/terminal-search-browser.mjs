// Exercise the production bundle against a real Docker exec, using only a temporary project.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const { chromium, expect } = createRequire(new URL('../frontend/package.json', import.meta.url))('@playwright/test');
const image = process.argv[2];
assert.ok(image, 'Usage: node scripts/terminal-search-browser.mjs IMAGE');
const suffix = randomBytes(4).toString('hex'), name = `composeops-search-${suffix}`, projectName = `${name}-target`;
const root = mkdtempSync('/tmp/composeops-search-'), composeFile = `${root}/compose.yml`;
const artifacts = process.env.TERMINAL_SEARCH_ARTIFACTS || `${root}-artifacts`;
mkdirSync(artifacts, { recursive: true });
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim();
const compose = args => docker(['compose', '-p', projectName, '-f', composeFile, ...args]);
let browser;
let currentSession;
try {
  writeFileSync(composeFile, 'services:\n  app:\n    image: node:22-alpine\n    command: ["sleep", "3600"]\n');
  compose(['up', '-d']);
  docker(['run', '-d', '--name', name, '-p', '127.0.0.1::3001', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-e', 'LOG_LEVEL=error', '-e', 'OPS_EFFECT_WORKER_ENABLED=0', '-e', 'ENABLE_SHELL=1', image]);
  const base = `http://${docker(['port', name, '3001/tcp'])}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await delay(500); }
  const password = randomBytes(24).toString('hex');
  const auth = await fetch(`${base}/api/v1/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200, path); return response.json();
  };
  const project = (await request('/projects?refresh=1')).projects.find(p => p.projectName === projectName);
  assert.ok(project);
  await request('/projects/management', 'PUT', { projectIds: [project.id], mountProjectIds: [] });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), headless: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const [cookieName, cookieValue] = cookie.split('=');
    await context.addCookies([{ name: cookieName, value: cookieValue, url: base }]);
    const page = await context.newPage(), errors = [], inputFrames = [], outputFrames = [];
    currentSession = { viewport, errors, inputFrames, outputFrames };
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => {
      if (socket.url().includes('/ws/exec?')) socket.on('framereceived', ({ payload }) => outputFrames.push(String(payload)));
      if (socket.url().includes('/ws/exec?')) socket.on('framesent', ({ payload }) => {
        // Cursor-position reports answer the shell's DSR requests; they are not user input.
        const text = String(payload), cursorReport = text.startsWith('\x1b[') && /^\d+;\d+R$/.test(text.slice(2));
        if (!text.startsWith('{') && !cursorReport) inputFrames.push(text);
      });
    });
    await page.goto(`${base}/#/shell?projectId=${encodeURIComponent(project.id)}&containerId=${project.containers[0].id}`);
    await expect(page.locator('.terminal-session-bar strong')).toHaveText('已连接', { timeout: 15000 });
    const terminal = page.locator('.xterm-helper-textarea');
    // BusyBox ash requests the cursor position before finishing its initial prompt.
    // Wait for its redraw acknowledgement before injecting an entire command at once.
    await expect.poll(() => outputFrames.join('')).toContain('\x1b[J');
    await terminal.pressSequentially("printf '\\n%s%s first\\n%s%s second\\n%s%s third\\n' TERM FIND term find TERM FIND; i=0; while [ $i -lt 120 ]; do echo line-$i; i=$((i+1)); done");
    await terminal.press('Enter');
    // Input delivery and Docker output are asynchronous on hosted CI runners.
    // Start searching only after the real command has produced its full output.
    await expect.poll(() => outputFrames.join(''), { timeout: 15000 }).toContain('TERMFIND first');
    await expect.poll(() => outputFrames.join(''), { timeout: 15000 }).toContain('line-119');
    await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
    const query = page.getByRole('textbox', { name: '终端查找内容' }), result = page.locator('.shell-search-result');
    await query.fill('TERMFIND'); await expect(result).toHaveText(/\d \/ 3/);
    await page.getByRole('button', { name: '区分大小写' }).click(); await expect(result).toHaveText(/\d \/ 2/);
    await query.press('Escape'); await expect(terminal).toBeFocused();
    await terminal.pressSequentially('echo pending-');
    const sent = inputFrames.length;
    await terminal.press('Control+f'); await expect(query).toBeFocused();
    await query.press('Enter'); await query.press('Shift+Enter');
    await page.getByRole('button', { name: '下一个匹配' }).click();
    await page.screenshot({ path: `${artifacts}/real-search-${viewport.width}.png`, fullPage: true });
    await page.getByRole('button', { name: '回到最新终端输出' }).click();
    await expect(terminal).toBeFocused(); assert.equal(inputFrames.length, sent, 'Search actions must not send shell input');
    await terminal.pressSequentially('preserved'); await terminal.press('Enter');
    assert.ok(inputFrames.join('').includes('echo pending-preserved\r'), 'Search must preserve the unfinished command');
    await page.getByRole('button', { name: '断开', exact: true }).click();
    await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
    await query.fill('TERMFIND'); await expect(result).toHaveText(/\d \/ 2/);
    assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    console.log(`PASS real Docker exec ${viewport.width}px: search, case, navigation, input isolation, pending command, retained output`);
    await context.close();
  }
} catch (error) {
  writeFileSync(`${artifacts}/failure-session.json`, JSON.stringify(currentSession || {}, null, 2), { mode: 0o600 });
  console.error('Terminal session evidence:', JSON.stringify(currentSession || {}));
  throw error;
} finally {
  await browser?.close();
  try { docker(['rm', '-f', name]); } catch {}
  try { compose(['down', '--remove-orphans']); } catch {}
  rmSync(root, { recursive: true, force: true });
}
