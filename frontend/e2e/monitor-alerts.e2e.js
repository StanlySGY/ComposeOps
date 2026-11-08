import { test, expect } from '@playwright/test';

const modal = page => page.getByRole('dialog', { name: '配置告警规则', exact: true });
const removeModal = page => page.getByRole('dialog', { name: '删除告警规则', exact: true });
const rules = page => page.getByRole('region', { name: '容器告警规则', exact: true });
async function install(page, options = {}) {
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(options => {
    const original = window.fetch;
    window.monitorFixture = { metricsFailure: false, listFailure: false, writeFailure: false, blockedWrite: false, blockedRead: false,
      releaseWrite: null, releaseRead: null, writes: [], reads: 0, metricReads: 0,
      rules: [{ id: 'cpu-rule', projectId: 'cache', service: 'redis', containerId: 'demo-redis', containerName: 'redis', metric: 'cpu', threshold: 80, action: 'notify' }], ...options };
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const method = init.method || 'GET';
      const f = window.monitorFixture;
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (path.startsWith('/api/v1/metrics/container/')) {
        f.metricReads++;
        return f.metricsFailure ? json({ message: '指标源暂不可用' }, 503) : json({ data: { current: 25, unit: '%', trend: 'stable' } });
      }
      if (path === '/api/v1/metrics/historical') return json({ metrics: Array.from({ length: 30 }, (_, i) => ({ timestamp: Date.now() - (30 - i) * 10000, value: 25 + 12 * Math.sin(i / 4) })) });
      if (path === '/api/v1/metrics/anomalies') return json({ anomalies: [] });
      if (path === '/api/v1/metrics/alerts' && method === 'GET') {
        f.reads++;
        if (f.blockedRead) await new Promise(resolve => { f.releaseRead = resolve; });
        return f.listFailure ? json({ message: '规则列表暂不可用' }, 503) : json({ alerts: f.rules });
      }
      if (path === '/api/v1/metrics/alerts' && method === 'POST') {
        const body = JSON.parse(init.body); f.writes.push({ method, body });
        if (f.blockedWrite) await new Promise(resolve => { f.releaseWrite = resolve; });
        if (f.writeFailure) return json({ message: '规则写入暂不可用，请重试' }, 503);
        const rule = { id: `new-${f.writes.length}`, projectId: 'cache', service: 'redis', containerId: body.container, ...body };
        f.rules.push(rule); return json({ ruleId: rule.id, rule });
      }
      if (path.startsWith('/api/v1/metrics/alerts/') && method === 'DELETE') {
        const id = path.split('/').pop(); f.writes.push({ method, id });
        if (f.blockedWrite) await new Promise(resolve => { f.releaseWrite = resolve; });
        if (f.writeFailure) return json({ message: '删除暂不可用，请重试' }, 503);
        f.rules = f.rules.filter(rule => rule.id !== id); return json({ deleted: 1 });
      }
      return original(input, init);
    };
  }, options);
  await page.goto('./#/monitor?tab=history&projectId=cache&containerId=demo-redis');
  await expect(rules(page)).toBeVisible();
}
async function configure(page) {
  await rules(page).getByRole('button', { name: '配置告警', exact: true }).click();
  await expect(modal(page)).toBeVisible();
}

test('历史入口可创建规则，键盘返回并恢复触发焦点', async ({ page }) => {
  await install(page);
  await configure(page);
  await expect(modal(page)).toContainText('redis');
  const close = modal(page).getByRole('button', { name: '关闭', exact: true });
  const submit = modal(page).getByRole('button', { name: '创建规则', exact: true });
  await submit.focus(); await page.keyboard.press('Tab'); await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(submit).toBeFocused();
  await page.keyboard.press('Escape'); await expect(modal(page)).toHaveCount(0);
  await expect(rules(page).getByRole('button', { name: '配置告警', exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
});

test('指标失败不隐藏规则，列表失败保留旧规则且可独立重试', async ({ page }) => {
  await install(page, { metricsFailure: true });
  await expect(page.getByText(/加载指标失败/)).toContainText('指标源暂不可用');
  await expect(rules(page)).toContainText('阈值：80%');
  await page.evaluate(() => { window.monitorFixture.listFailure = true; });
  await rules(page).getByRole('button', { name: '刷新告警规则', exact: true }).click();
  await expect(rules(page).getByRole('alert')).toContainText('规则列表暂不可用');
  await expect(rules(page)).toContainText('阈值：80%');
  const reads = await page.evaluate(() => window.monitorFixture.metricReads);
  await page.evaluate(() => { window.monitorFixture.listFailure = false; });
  await rules(page).getByRole('button', { name: '重新读取规则', exact: true }).click();
  await expect(rules(page).getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => window.monitorFixture.metricReads)).toBe(reads);
  await configure(page);
});

test('首次读取显示等待状态，空列表在读取完成后才出现', async ({ page }) => {
  await install(page, { blockedRead: true, rules: [] });
  await expect(rules(page)).toContainText('正在读取告警规则');
  await expect(rules(page).getByText('暂无告警规则', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.monitorFixture.releaseRead());
  await expect(rules(page).getByText('暂无告警规则', { exact: true })).toBeVisible();
});

test('创建校验、慢请求锁定、失败重试和确认状态保留', async ({ page }) => {
  await install(page); await configure(page);
  const input = modal(page).getByLabel('阈值（%）', { exact: true });
  const submit = modal(page).getByRole('button', { name: '创建规则', exact: true });
  for (const value of ['', '-1', '101']) { await input.fill(value); await expect(submit).toBeDisabled(); }
  await input.fill('92');
  await modal(page).getByLabel('触发后执行', { exact: true }).selectOption('auto_restart');
  await expect(modal(page)).toContainText('可能短暂中断服务');
  await modal(page).getByLabel('触发后执行', { exact: true }).selectOption('notify');
  await page.evaluate(() => { window.monitorFixture.blockedWrite = true; window.monitorFixture.writeFailure = true; });
  await submit.click(); await expect(submit).toBeDisabled();
  await expect(modal(page).getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(modal(page)).toBeVisible();
  expect(await page.evaluate(() => window.monitorFixture.writes)).toHaveLength(1);
  await page.evaluate(() => { window.monitorFixture.blockedWrite = false; window.monitorFixture.releaseWrite(); });
  await expect(modal(page).getByRole('alert')).toContainText('规则写入暂不可用');
  await expect(input).toHaveValue('92');
  await page.evaluate(() => { window.monitorFixture.writeFailure = false; window.monitorFixture.listFailure = true; });
  await submit.click(); await expect(modal(page)).toHaveCount(0);
  await expect(rules(page)).toContainText('阈值：92%');
  await expect(rules(page).getByRole('alert')).toContainText('规则列表暂不可用');
  await expect(rules(page).getByRole('status')).toContainText('创建告警规则');
  await expect(rules(page).getByRole('status')).toBeInViewport();
});

test('删除有确认、可取消，失败原地重试且慢请求不能重复', async ({ page }) => {
  await install(page);
  const remove = rules(page).getByRole('button', { name: '删除CPU 占用(%)告警规则', exact: true });
  await remove.click(); await expect(removeModal(page)).toBeVisible();
  expect(await page.evaluate(() => window.monitorFixture.writes)).toHaveLength(0);
  await page.keyboard.press('Escape'); await expect(remove).toBeFocused();
  await remove.click();
  await page.evaluate(() => { window.monitorFixture.blockedWrite = true; window.monitorFixture.writeFailure = true; });
  await removeModal(page).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(removeModal(page).getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(removeModal(page)).toBeVisible();
  await page.evaluate(() => { window.monitorFixture.blockedWrite = false; window.monitorFixture.releaseWrite(); });
  await expect(removeModal(page).getByRole('alert')).toContainText('删除暂不可用');
  await page.evaluate(() => { window.monitorFixture.writeFailure = false; window.monitorFixture.listFailure = true; });
  await removeModal(page).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(removeModal(page)).toHaveCount(0);
  await expect(rules(page).locator('.alert-rule-card')).toHaveCount(0);
  await expect(rules(page).getByRole('status')).toContainText('已删除');
  await expect(rules(page).getByRole('alert')).toContainText('规则列表暂不可用');
});

test('切换节点关闭旧规则窗口，迟到提交不会污染新上下文', async ({ page }) => {
  await install(page); await configure(page);
  await page.evaluate(() => { window.monitorFixture.blockedWrite = true; });
  await modal(page).getByRole('button', { name: '创建规则', exact: true }).click();
  await expect(modal(page).getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('composeops:host-changed')));
  await expect(modal(page)).toHaveCount(0);
  const reads = await page.evaluate(() => window.monitorFixture.reads);
  await page.evaluate(() => window.monitorFixture.releaseWrite());
  await expect(page.locator('.alert-success')).toHaveCount(0);
  expect(await page.evaluate(() => window.monitorFixture.reads)).toBe(reads);
});

test('离开历史页释放弹窗和滚动锁，迟到创建不反馈到其他页面', async ({ page }) => {
  await install(page); await configure(page);
  await page.evaluate(() => { window.monitorFixture.blockedWrite = true; });
  await modal(page).getByRole('button', { name: '创建规则', exact: true }).click();
  await expect(modal(page).getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.evaluate(() => { location.hash = '#/events'; });
  await expect(page.getByRole('heading', { name: '事件中心', exact: true })).toBeVisible();
  await expect(modal(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('');
  const reads = await page.evaluate(() => window.monitorFixture.reads);
  await page.evaluate(() => window.monitorFixture.releaseWrite());
  expect(await page.evaluate(() => window.monitorFixture.reads)).toBe(reads);
  await expect(page.getByText('告警规则已创建', { exact: true })).toHaveCount(0);
});

test('320px 规则卡和表单无横向溢出，减少动画与自动动作解释可用', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await install(page);
  await rules(page).scrollIntoViewIfNeeded();
  await expect(rules(page).getByRole('button', { name: '配置告警', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('alert-rules-mobile.png') });
  const layout = await page.evaluate(() => {
    const main = document.querySelector('.app-main');
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, mainWidth: main.clientWidth, mainScrollWidth: main.scrollWidth,
      overflowing: [...main.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => ({ tag: element.tagName, class: element.getAttribute('class'), width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right })).slice(0, 20) };
  });
  await testInfo.attach('layout.json', { body: JSON.stringify(layout, null, 2), contentType: 'application/json' });
  expect(layout.documentWidth <= layout.viewport && layout.mainScrollWidth <= layout.mainWidth, JSON.stringify(layout)).toBe(true);
  await configure(page);
  await modal(page).getByLabel('触发后执行', { exact: true }).selectOption('scale');
  await expect(modal(page)).toContainText('需要项目支持 Compose 编辑');
  await expect(modal(page).getByRole('button', { name: '创建规则', exact: true })).toBeInViewport();
  expect(await modal(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('alert-form-mobile.png') });
});
