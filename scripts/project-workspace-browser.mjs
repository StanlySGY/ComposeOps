import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
// Only a randomly named temporary project is granted management permissions.
const candidate = process.argv[2] || 'stanly1997/opsdash:latest';
const workspaceMode = process.argv.includes('--workspace');
let targetProjectId;
const suffix = randomBytes(4).toString('hex');
const name = 'composeops-ux-candidate-' + suffix;
const projectName = 'composeops-ux-target-' + suffix;
const root = mkdtempSync('/tmp/composeops-ux-target-');
const compose = root + '/compose.yml';
const override = root + '/override.yml';
const envFile = root + '/.env';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim();
const composeArgs = ['compose', '-p', projectName, '-f', compose, '-f', override];
let browser;
try {
  writeFileSync(compose, 'services:\n  app:\n    image: node:22-alpine\n    command: ["sh", "-c", "echo UX_WORKSPACE_READY; sleep 3600"]\n');
  writeFileSync(override, 'services:\n  app:\n    environment:\n      REVIEW_MARKER: ${REVIEW_MARKER}\n');
  writeFileSync(envFile, 'REVIEW_MARKER=reviewed\n');
  docker([...composeArgs, 'up', '-d']);
  docker(['run', '-d', '--name', name, '-p', '127.0.0.1::3001', '-v', '/var/run/docker.sock:/var/run/docker.sock', ...(workspaceMode ? [] : ['-v', root + ':' + root]), '-e', 'LOG_LEVEL=error', '-e', 'OPS_EFFECT_WORKER_ENABLED=0', '-e', 'ENABLE_SHELL=1', candidate]);
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
  targetProjectId = project.id;
  await request('/projects/management', 'PUT', { projectIds: [project.id], mountProjectIds: [project.id] });
  const managed = await request('/projects/' + project.id);
  assert.equal(managed.mounted, !workspaceMode, 'test the intended execution mode');
  const reviewPath = '/projects/' + project.id + '/deployment-review';
  const reviewed = await request(reviewPath, 'POST', {});
  assert.equal(reviewed.files.length, 2, 'review covers both files in the actual execution context');
  assert.ok(reviewed.content.includes('[REDACTED]'), 'effective environment values stay hidden');
  writeFileSync(envFile, 'REVIEW_MARKER=changed\n');
  const action = token => fetch(base + '/api/v1/projects/' + project.id + '/actions', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'up', reviewToken: token }),
  });
  const rejected = await action(reviewed.token);
  assert.equal(rejected.status, 409, await rejected.text());
  assert.ok(docker(['inspect', ...docker([...composeArgs, 'ps', '-q']).split('\n'), '--format', '{{json .Config.Env}}']).includes('REVIEW_MARKER=reviewed'));
  writeFileSync(envFile, 'REVIEW_MARKER=reviewed\n');
  const accepted = await action((await request(reviewPath, 'POST', {})).token);
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /"type":"exit","data":\{"code":0\}/);
  console.log('PASS real backend ' + (workspaceMode ? 'workspace' : 'direct') + ': merged review, environment drift rejection and reviewed deployment');
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(); const errors=[]; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    const passwordInput = page.getByLabel('管理员密码', { exact: true });
    await expect(passwordInput).toBeVisible();
    await page.screenshot({ path: '/tmp/composeops-polish-login-'+viewport.width+'.png', animations: 'disabled' });
    await passwordInput.fill(password);
    await page.getByRole('button', { name: '显示密码', exact: true }).click();
    await expect(passwordInput).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
    await expect(passwordInput).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: '安全登录', exact: true }).click();
    await expect(passwordInput).toHaveCount(0);
    const heartbeatFrames = [];
    page.on('websocket', socket => {
      if (/\/ws\/(logs|aggregated-logs)/.test(socket.url())) socket.on('framereceived', event => {
        if (String(event.payload) === '{"type":"pong"}') heartbeatFrames.push(event.payload);
      });
    });
    await page.goto(base + '/#/services?q=' + projectName);
    const card = page.locator('[id="project-' + project.id + '"]');
    if (await card.locator('.service-project-card__toggle').getAttribute('aria-expanded') !== 'true') await card.locator('.service-project-card__toggle').click();
    await card.getByRole('button', { name: '更多操作', exact: true }).click();
    await card.getByRole('group', { name: '更多操作' }).getByRole('button', { name: '编辑备注', exact: true }).click();
    const note = page.getByRole('dialog', { name: '编辑项目备注' });
    const noteText='真实后端保存 '+viewport.width;
    await note.getByLabel('项目备注', { exact: true }).fill(noteText);
    await note.getByRole('button', { name: '保存备注' }).click(); await expect(note).toHaveCount(0);
    await page.reload(); await expect(card).toContainText(noteText);
    if (await card.locator('.service-project-card__toggle').getAttribute('aria-expanded') !== 'true') await card.locator('.service-project-card__toggle').click();
    await card.getByRole('link', { name: '实时日志', exact: true }).click();
    await expect(page.getByText('UX_WORKSPACE_READY', { exact: false })).toBeVisible();
    if (viewport.width === 1440) {
      await expect.poll(() => heartbeatFrames.length, { timeout: 20000 }).toBeGreaterThan(0);
      const target = docker([...composeArgs, 'ps', '-q', 'app']);
      for (const mode of ['aggregate', 'single']) {
        const aggregate = page.getByTitle('当前为聚合模式,点击切换为单容器', { exact: true });
        if ((await aggregate.count() > 0) !== (mode === 'aggregate')) {
          await page.getByTitle(mode === 'aggregate' ? '聚合所有选中容器' : '当前为聚合模式,点击切换为单容器', { exact: true }).click();
        }
        if (mode === 'single') {
          // Exercise the visible mode/source controls so the actual project's
          // returnTo (which itself contains a query) remains intact.
          await page.locator('.container-chip').first().click();
        }
        const connect = page.getByRole('button', { name: '连接', exact: true });
        if (await connect.isVisible()) await connect.click();
        await expect(page.getByText('已连接', { exact: true })).toBeVisible();
        const search = page.getByRole('textbox', { name: '搜索和过滤实时日志' });
        // An anchor immediately before the outage must appear only once after replay.
        docker(['exec', target, 'sh', '-c', `printf "UX_ANCHOR_${mode}\\n" > /proc/1/fd/1`]);
        await expect(page.getByText('UX_ANCHOR_' + mode, { exact: true })).toBeVisible();
        await context.setOffline(true);
        await expect(page.getByText('网络离线', { exact: true })).toBeVisible();
        // Exceed the initial 200-line tail while the browser is actually offline.
        docker(['exec', target, 'sh', '-c', `i=0; while [ "$i" -lt 360 ]; do printf "UX_OUTAGE_${mode}_%03d\\n" "$i"; i=$((i+1)); done > /proc/1/fd/1`]);
        await context.setOffline(false);
        await expect(page.getByText('已连接', { exact: true })).toBeVisible();
        await expect(page.locator('.log-reconnect-notice')).toContainText('从上次位置补读并去重');
        await search.fill('UX_OUTAGE_' + mode + '_');
        await expect(page.locator('.log-status-strip').getByText('360 条', { exact: true })).toBeVisible();
        await search.fill('UX_OUTAGE_' + mode + '_000');
        await expect(page.getByText('UX_OUTAGE_' + mode + '_000', { exact: true })).toBeVisible();
        await search.fill('UX_OUTAGE_' + mode + '_359');
        await expect(page.getByText('UX_OUTAGE_' + mode + '_359', { exact: true })).toBeVisible();
        await search.fill('UX_ANCHOR_' + mode);
        await expect(page.getByText('UX_ANCHOR_' + mode, { exact: true })).toHaveCount(1);
        await search.fill('');
      }
      docker(['exec', target, 'sh', '-c', 'printf "UX_AFTER_RECONNECT\\n" > /proc/1/fd/1']);
      await expect(page.getByText('UX_AFTER_RECONNECT', { exact: true })).toBeVisible();
    }
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
    await expect(page.getByText('已核对：当前容器全部运行', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('region', { name: '执行后状态核对' })).toContainText('未配置健康检查');
    assert.equal(docker(['inspect', containerName, '--format', '{{.State.Status}}']), 'running');
    assert.equal(docker(['inspect', containerName, '--format', '{{index .Config.Labels "com.docker.compose.project"}}']), projectName, 'apply must keep the original project identity');
    const sameRoot = docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project.working_dir=' + root]).split('\n').filter(Boolean);
    assert.equal(sameRoot.length, 1, 'apply must replace the original container without creating another stack');
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
    console.log('PASS real backend '+(workspaceMode ? 'workspace ' : 'direct ')+viewport.width+'px: login and password visibility, note persistence, logs'+(viewport.width === 1440 ? ', heartbeat, 360 offline lines recovered in both aggregate/single modes, deduplication, fresh Docker log after reconnect' : '')+', config review/save, navigation guard, apply, running state verification, terminal, cancel stop');
    await context.close();
  }
} finally {
  await browser?.close();
  try { docker(['rm','-f',name]); } catch {}
  try { docker([...composeArgs, 'down', '--remove-orphans']); } catch {}
  // Cleanup also covers the regression where Compose used the directory name
  // instead of the original -p name. Only this exact temporary root is eligible.
  try {
    const leftovers = docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project.working_dir=' + root]).split('\n').filter(Boolean);
    const helpers = targetProjectId ? docker(['ps', '-aq', '--filter', 'label=composeops.helper=compose-workspace', '--filter', 'label=composeops.project=' + targetProjectId]).split('\n').filter(Boolean) : [];
    if (helpers.length) docker(['rm', '-f', ...helpers]);
    const projects = new Set([projectName]);
    for (const id of leftovers) projects.add(docker(['inspect', id, '--format', '{{index .Config.Labels "com.docker.compose.project"}}']));
    if (leftovers.length) docker(['rm', '-f', ...leftovers]);
    for (const value of projects) {
      const networks = docker(['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + value]).split('\n').filter(Boolean);
      if (networks.length) docker(['network', 'rm', ...networks]);
    }
  } catch {}
  rmSync(root, { recursive: true, force: true });
}
