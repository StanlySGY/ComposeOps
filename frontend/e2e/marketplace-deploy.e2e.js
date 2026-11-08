import { test, expect } from '@playwright/test';

async function install(page, options = {}) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(options => {
    const original = window.fetch;
    const f = window.marketDeployFixture = { requests: [], aborted: false, scanFails: false, state: options.state || 'running', health: options.health ?? null, mode: options.mode || 'manual' };
    const template = { id: 'minio', name: 'MinIO', category: 'Database', description: '为项目提供独立的对象存储，分别配置 API 与控制台端口。', envSchema: [{ key: 'CONTAINER_NAME', default: 'minio' }, { key: 'API_PORT', label: 'API 端口', default: '9000', type: 'port' }, { key: 'CONSOLE_PORT', label: '控制台端口', default: '9001', type: 'port' }, { key: 'MINIO_USER', label: '管理员账号', default: 'minioadmin' }, { key: 'MINIO_PASSWORD', label: '管理员密码', secret: true }], defaultCompose: 'services:\n  storage:\n    image: minio/minio:latest\n' };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    f.project = () => ({ id: 'market-project', projectName: 'minio', hostId: 'local', managed: true, editable: true, status: 'running', owner: '应用部署', composeFiles: ['/projects/minio/docker-compose.yml'], workingDir: '/projects/minio', containers: [{ id: 'market-container', name: 'minio', service: 'storage', state: f.state, health: f.health, ports: [], image: 'minio/minio:latest' }] });
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/v1/marketplace/templates/search') return json({ results: [template] });
      if (url.pathname === '/api/v1/ops/blueprints/deploy') {
        f.requests.push(JSON.parse(init.body));
        return new Response(new ReadableStream({ start(controller) {
          let closed = false;
          f.send = frame => { if (!closed) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)); };
          f.close = () => { if (!closed) { closed = true; controller.close(); } };
          init.signal?.addEventListener('abort', () => { f.aborted = true; f.close(); });
          f.send({ type: 'phase', data: { phase: 'checking', projectId: 'market-project', workingDir: '/projects/minio' } });
          if (f.mode === 'eof') f.close();
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (url.pathname === '/api/v1/projects') return f.scanFails ? json({ message: '状态接口暂时不可用' }, 503) : json({ projects: [f.project()] });
      if (url.pathname === '/api/v1/projects/market-project/compose') return json({ content: template.defaultCompose, path: '/projects/minio/docker-compose.yml', filePath: '/projects/minio/docker-compose.yml', fileIndex: 0 });
      return original(input, init);
    };
    location.hash = '#/marketplace';
  }, options);
  await expect(page.getByRole('heading', { name: '应用市场', exact: true })).toBeVisible();
  await expect(page.locator('.template-card h2')).toHaveText('MinIO');
  await page.locator('.template-card').getByRole('button', { name: '部署', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '部署应用：MinIO' })).toBeVisible();
  return errors;
}

async function finish(page, data = {}) {
  await page.evaluate(data => {
    const f = window.marketDeployFixture;
    f.send({ type: 'result', data: { ok: true, code: 0, projectId: 'market-project', projectName: 'minio', hostId: 'local', workingDir: '/projects/minio', filesCreated: true, directoryCreated: true, ...data } });
    f.close();
  }, data);
}

test('部署表单明确默认值、私密字段和键盘校验', async ({ page }) => {
  const errors = await install(page); const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveValue('minio');
  await expect(dialog.getByLabel('API 端口', { exact: true })).toHaveValue('9000');
  const password = dialog.locator('#market-deploy-variable-MINIO_PASSWORD');
  await expect(password).toHaveAttribute('type', 'password'); expect((await password.inputValue()).length).toBe(48);
  await dialog.getByRole('button', { name: '显示管理员密码', exact: true }).click(); await expect(password).toHaveAttribute('type', 'text');
  await dialog.getByRole('button', { name: '隐藏管理员密码', exact: true }).click();
  await dialog.getByLabel('项目名称', { exact: true }).fill('../Invalid');
  await dialog.getByRole('button', { name: '部署', exact: true }).click();
  await expect(dialog.getByLabel('项目名称', { exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.marketDeployFixture.requests.length)).toBe(0);
  expect(errors).toEqual([]);
});

test('实时阶段与输出可读，停止等待保留结果归属', async ({ page }) => {
  const errors = await install(page); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '部署', exact: true }).click();
  await page.evaluate(() => { const f = window.marketDeployFixture; f.send({ type: 'phase', data: { phase: 'starting' } }); f.send({ type: 'stdout', data: 'Pulling storage image…\nLayer 1 / 4 downloaded\n' }); });
  await expect(dialog.getByRole('heading', { name: '正在启动服务', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('部署输出内容')).toContainText('Layer 1 / 4');
  await expect(dialog.getByLabel('项目名称', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '停止等待', exact: true }).click();
  await expect(dialog).toContainText('结果待核对'); await expect(dialog.getByLabel('部署输出内容')).toContainText('Layer 1 / 4');
  expect(await page.evaluate(() => window.marketDeployFixture.aborted)).toBe(true);
  await expect(dialog.locator('.btn-save')).toHaveCount(0); expect(errors).toEqual([]);
});

test('启动完成与健康分开说明，日志入口能返回市场', async ({ page }) => {
  const errors = await install(page); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '部署', exact: true }).click(); await finish(page);
  await expect(dialog).toContainText('启动命令已完成'); await expect(dialog).toContainText('未配置健康检查');
  await dialog.locator('summary').click(); await expect(dialog.getByLabel('管理员密码', { exact: true })).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: '查看日志', exact: true }).click();
  await expect(page).toHaveURL(/logs\?projectId=market-project&from=marketplace/);
  await page.getByRole('button', { name: '返回应用市场', exact: true }).click();
  await expect(page.getByRole('heading', { name: '应用市场', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(errors).toEqual([]);
});

test('真实退出失败保留目录和输出，状态读取失败可单独重试', async ({ page }) => {
  const errors = await install(page); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '部署', exact: true }).click();
  await page.evaluate(() => { window.marketDeployFixture.scanFails = true; });
  await finish(page, { ok: false, code: 17, message: '镜像启动失败', output: 'OCI runtime create failed\n' });
  await expect(dialog).toContainText('部署未完成'); await expect(dialog).toContainText('退出码 17');
  await expect(dialog).toContainText('状态接口暂时不可用'); await expect(dialog.getByLabel('部署输出内容')).toContainText('OCI runtime');
  await expect(dialog.locator('.btn-save')).toHaveCount(0);
  await page.evaluate(() => { window.marketDeployFixture.scanFails = false; window.marketDeployFixture.health = 'unhealthy'; });
  await dialog.getByRole('button', { name: '重新核对', exact: true }).click();
  await expect(dialog).toContainText('健康检查未通过'); expect(errors).toEqual([]);
});

test('连接无结果结束时明确未知，不以成功收场', async ({ page }) => {
  const errors = await install(page, { mode: 'eof' }); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '部署', exact: true }).click();
  await expect(dialog).toContainText('结果待核对'); await expect(dialog.locator('.btn-save')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('长输出有界并支持回看与恢复跟随', async ({ page }) => {
  const errors = await install(page); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '部署', exact: true }).click();
  await page.evaluate(() => window.marketDeployFixture.send({ type: 'stdout', data: Array.from({ length: 300 }, (_, i) => `layer ${i} downloaded\n`).join('') }));
  const output = dialog.getByLabel('部署输出内容'); await expect(output).toContainText('layer 299');
  await output.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(dialog.getByRole('button', { name: '跟随最新', exact: true })).toBeVisible();
  await page.evaluate(() => window.marketDeployFixture.send({ type: 'stdout', data: 'newest-output\n' }));
  expect(await output.evaluate(element => element.scrollTop)).toBe(0);
  await dialog.getByRole('button', { name: '跟随最新', exact: true }).click();
  await expect.poll(() => output.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(32);
  await page.evaluate(() => window.marketDeployFixture.send({ type: 'stdout', data: 'x'.repeat(70000) + 'tail' }));
  await expect(dialog).toContainText('较早输出已省略'); expect((await output.textContent()).length).toBe(65536);
  await dialog.getByRole('button', { name: '停止等待', exact: true }).click(); expect(errors).toEqual([]);
});

test('320px 与减少动画设置下表单、凭据和结果动作可达', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await install(page); const dialog = page.getByRole('dialog');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(dialog.getByRole('button', { name: '部署', exact: true })).toBeInViewport();
  await dialog.getByRole('button', { name: '部署', exact: true }).click(); await finish(page, { output: 'Service created\nWaiting for application readiness…\n' });
  await expect(dialog.getByRole('button', { name: '返回市场', exact: true })).toBeInViewport();
  await dialog.getByRole('button', { name: '查看服务', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: '查看服务', exact: true })).toBeInViewport();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const bounds = await dialog.getByRole('button', { name: '查看服务', exact: true }).boundingBox(); expect(bounds.height).toBeGreaterThanOrEqual(40);
  expect(errors).toEqual([]);
});

test('离开部署页清理弹窗与连接，返回后可恢复上次输出', async ({ page }) => {
  const errors = await install(page); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '部署', exact: true }).click();
  await page.evaluate(() => window.marketDeployFixture.send({ type: 'stdout', data: 'retained across navigation\n' }));
  await expect(dialog.getByLabel('部署输出内容')).toContainText('retained across navigation');
  await page.goBack();
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  expect(await page.evaluate(() => window.marketDeployFixture.aborted)).toBe(true);
  await page.goForward();
  await page.getByRole('button', { name: /查看上次部署.*MinIO/ }).click();
  await expect(page.getByRole('dialog')).toContainText('结果待核对');
  await expect(page.getByRole('dialog').getByLabel('部署输出内容')).toContainText('retained across navigation');
  await expect(page.getByRole('dialog').locator('.btn-save')).toHaveCount(0);
  expect(await page.evaluate(() => window.marketDeployFixture.requests.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('从详情进入配置可退回详情，离页则同时清理两层窗口', async ({ page }) => {
  const errors = await install(page);
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  const trigger = page.locator('.template-card').getByRole('button', { name: '查看', exact: true });
  await trigger.click();
  await page.getByRole('dialog').getByRole('button', { name: '配置并部署', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '返回详情', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'MinIO', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '配置并部署', exact: true }).click();
  await page.goBack(); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  await page.goForward(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.marketDeployFixture.requests.length)).toBe(0); expect(errors).toEqual([]);
});

test('终帧无需等待连接关闭即可返回，恢复记录不会重复启动', async ({ page }) => {
  const errors = await install(page); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '部署', exact: true }).click();
  await page.evaluate(() => window.marketDeployFixture.send({ type: 'result', data: { ok: true, code: 0, projectId: 'market-project', projectName: 'minio', filesCreated: true, output: 'stage complete '.repeat(40) + 'completed once' } }));
  await expect(dialog).toContainText('启动命令已完成');
  await expect.poll(() => dialog.getByLabel('部署输出内容').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(32);
  await page.setViewportSize({ width: 320, height: 740 });
  await expect.poll(() => dialog.getByLabel('部署输出内容').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(32);
  await dialog.getByLabel('部署输出内容').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.getByLabel('部署输出内容').evaluate(element => element.scrollTop)).toBe(0);
  await dialog.getByRole('button', { name: '返回市场', exact: true }).click();
  await page.getByRole('button', { name: /查看上次部署.*MinIO/ }).click();
  await expect(dialog.getByLabel('部署输出内容')).toContainText('completed once');
  await expect(dialog.locator('.deployment-credentials')).toHaveCount(0);
  await expect(dialog.locator('.btn-save')).toHaveCount(0);
  expect(await page.evaluate(() => window.marketDeployFixture.requests.length)).toBe(1); expect(errors).toEqual([]);
});
