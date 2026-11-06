import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
// Only a randomly named temporary project is granted management permissions.
const candidate = process.argv[2] || 'stanly1997/opsdash:latest';
const suffix = randomBytes(4).toString('hex');
const name = 'composeops-ux-candidate-' + suffix;
const projectName = 'composeops-ux-target-' + suffix;
const root = mkdtempSync('/tmp/composeops-ux-target-');
const compose = root + '/compose.yml';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim();
const composeArgs = ['compose', '-p', projectName, '-f', compose];
let browser;
try {
  writeFileSync(compose, 'services:\n  app:\n    image: node:22-alpine\n    command: ["sh", "-c", "echo UX_WORKSPACE_READY; sleep 3600"]\n');
  docker([...composeArgs, 'up', '-d']);
  docker(['run', '-d', '--name', name, '-p', '127.0.0.1::3001', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', root + ':' + root, '-e', 'LOG_LEVEL=error', '-e', 'OPS_EFFECT_WORKER_ENABLED=0', '-e', 'ENABLE_SHELL=1', candidate]);
  const base = 'http://' + docker(['port', name, '3001/tcp']);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await delay(500); }
  const password = randomBytes(24).toString('hex');
  const auth = await fetch(base + '/api/v1/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  async function request(path, method='GET', body) {
    const r = await fetch(base + '/api/v1' + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(r.status, 200, path); return r.json();
  }
  const project = (await request('/projects?refresh=1')).projects.find(p => p.projectName === projectName);
  assert.ok(project, 'test project discovered');
  await request('/projects/management', 'PUT', { projectIds: [project.id], mountProjectIds: [project.id] });
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const divider = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, divider), value: cookie.slice(divider+1), url: base }]);
    const page = await context.newPage(); const errors=[]; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/#/services?q=' + projectName);
    const card = page.locator('[id="project-' + project.id + '"]');
    await card.locator('.service-project-card__toggle').click();
    await card.getByRole('button', { name: '更多操作', exact: true }).click();
    await card.getByRole('group', { name: '更多操作' }).getByRole('button', { name: '编辑备注', exact: true }).click();
    const note = page.getByRole('dialog', { name: '编辑项目备注' });
    const noteText='真实后端保存 '+viewport.width;
    await note.getByLabel('项目备注', { exact: true }).fill(noteText);
    await note.getByRole('button', { name: '保存备注' }).click(); await expect(note).toHaveCount(0);
    await page.reload(); await expect(card).toContainText(noteText);
    await card.locator('.service-project-card__toggle').click();
    await card.getByRole('link', { name: '实时日志', exact: true }).click();
    await expect(page.getByText('UX_WORKSPACE_READY', { exact: false })).toBeVisible();
    const nav=page.getByRole('navigation', { name: '项目内导航' });
    await nav.getByRole('link', { name: '配置', exact: true }).click();
    await page.getByRole('button', { name: '可视化', exact: true }).click();
    await page.getByRole('button', { name: '编辑服务 app', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑服务' });
    const containerName=projectName+'-'+viewport.width;
    await editor.getByLabel('容器名称 (可选)', { exact: true }).fill(containerName);
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await nav.getByRole('link', { name: '日志', exact: true }).click();
    await page.getByRole('dialog', { name: '配置尚未保存' }).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const review=page.getByRole('dialog', { name: /变更/ });
    await expect(review).toBeVisible({ timeout: 15000 });
    await review.getByRole('button', { name: '确认保存', exact: true }).click();
    await expect(page.getByText('保存文件不会自动更新容器。返回项目后选择「应用配置」，再查看状态或日志确认结果。')).toBeVisible();
    assert.ok(readFileSync(compose,'utf8').includes(containerName));
    await page.getByRole('link', { name: '返回项目', exact: true }).click();
    await expect(page.getByLabel('搜索服务项目')).toHaveValue(projectName);
    await card.getByRole('button', { name: '更多操作', exact: true }).click();
    await card.getByRole('button', { name: '应用配置 / 启动', exact: true }).click();
    await page.getByRole('dialog', { name: '应用配置', exact: true }).getByRole('button', { name: '应用配置', exact: true }).click();
    await expect(page.getByText('命令执行成功', { exact: true })).toBeVisible({ timeout: 30000 });
    assert.equal(docker(['inspect', containerName, '--format', '{{.State.Status}}']), 'running');
    await page.getByRole('button', { name: '查看项目状态', exact: true }).click();
    await expect(page.getByLabel('搜索服务项目')).toHaveValue(projectName);
    await card.getByRole('link', { name: '容器终端', exact: true }).click();
    await expect(page.locator('.terminal-session-bar')).toContainText('已连接', { timeout: 10000 });
    await nav.getByRole('link', { name: '项目', exact: true }).click();
    await card.getByRole('button', { name: '更多操作', exact: true }).click();
    await card.getByRole('button', { name: '停止项目', exact: true }).click();
    await page.getByRole('dialog', { name: '停止项目', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(docker(['inspect', containerName, '--format', '{{.State.Status}}']), 'running');
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: '/tmp/composeops-workspace-real-'+viewport.width+'.png' });
    console.log('PASS real backend '+viewport.width+'px: note persistence, logs, config review/save, navigation guard, apply, running state, terminal, cancel stop');
    await context.close();
  }
} finally {
  await browser?.close();
  try { docker(['rm','-f',name]); } catch {}
  try { docker([...composeArgs, 'down', '--remove-orphans']); } catch {}
  rmSync(root, { recursive: true, force: true });
}
