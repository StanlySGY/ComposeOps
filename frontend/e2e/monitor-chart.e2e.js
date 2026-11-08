import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function install(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = window.fetch;
    window.chartFixture = { count: 30 };
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      if (path.startsWith('/api/v1/metrics/container/')) return json({ data: { current: 29, unit: '%', trend: 'increasing' } });
      if (path === '/api/v1/metrics/historical') return json({ metrics: Array.from({ length: window.chartFixture.count }, (_, index) => ({ timestamp: 1794140000000 + index * 10000, value: index })) });
      if (path === '/api/v1/metrics/anomalies') return json({ anomalies: [] });
      if (path === '/api/v1/metrics/alerts') return json({ alerts: [] });
      return original(input, init);
    };
  });
  await page.goto('./#/monitor?tab=history&projectId=cache&containerId=demo-redis');
  await expect(page.locator('svg.chart-canvas')).toBeVisible();
  return errors;
}
async function hoverSample(page, fraction = 1) {
  const svg = page.locator('svg.chart-canvas');
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width * (50 + fraction * 729) / 800, box.y + box.height / 2);
}

test('图表切换改变实际绘制，并正确标识选中类型', async ({ page }) => {
  const errors = await install(page);
  await page.getByRole('button', { name: '柱状图', exact: true }).click();
  await expect(page.locator('.chart-bar')).toHaveCount(30);
  await expect(page.getByRole('button', { name: '柱状图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '折线图', exact: true }).click();
  await expect(page.locator('.chart-bar')).toHaveCount(0);
  await expect(page.locator('.chart-area')).toHaveCount(0);
  await expect(page.locator('.chart-line')).toHaveCount(1);
  await page.getByRole('button', { name: '面积图', exact: true }).click();
  await expect(page.locator('.chart-area')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('320px 末端选点与悬浮提示保持在图表边界内', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const errors = await install(page);
  await hoverSample(page);
  await expect(page.locator('.tooltip-value')).toHaveText('29.0%');
  const bounds = await page.locator('.chart-tooltip').evaluate(element => {
    const tip = element.getBoundingClientRect(); const chart = element.closest('.chart-canvas-wrapper').getBoundingClientRect();
    return { left: tip.left, right: tip.right, chartLeft: chart.left, chartRight: chart.right };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(bounds.chartLeft - 1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.chartRight + 1);
  expect(await page.locator('.app-main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('chart-tooltip-mobile.png') });
  expect(errors).toEqual([]);
});

test('拖选连续放大按当前范围计算，重置恢复所有样本', async ({ page }) => {
  const errors = await install(page);
  const svg = page.locator('svg.chart-canvas');
  for (const expected of ['已放大 2.0 倍', '已放大 4.0 倍']) {
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width * (50 + 730 * 0.25) / 800, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (50 + 730 * 0.75) / 800, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.chart-zoom-summary')).toContainText(expected);
  }
  await page.getByRole('button', { name: '重置图表缩放', exact: true }).click();
  await expect(page.locator('.chart-zoom-summary')).toHaveText('30 个样本');
  await expect(page.getByRole('button', { name: '缩小图表', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('普通滚轮可滚动页面，Ctrl 滚轮才缩放图表', async ({ page, browserName, isMobile }) => {
  test.skip(browserName === 'webkit' && isMobile, 'Playwright 的手机 WebKit 不支持鼠标滚轮；手机交互由触屏和缩放按钮场景验证。');
  await page.setViewportSize({ width: 960, height: 700 });
  await install(page);
  await hoverSample(page, 0.5);
  const main = page.locator('.app-main');
  const before = await main.evaluate(element => element.scrollTop);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => main.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
  await expect(page.locator('.chart-zoom-summary')).toHaveText('30 个样本');
  await hoverSample(page, 0.5);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control');
  await expect(page.locator('.chart-zoom-summary')).toContainText('已放大');
});

test('触屏可选择末端样本，缩放按钮与重置持续可用', async ({ page, isMobile }) => {
  test.skip(!isMobile, '此场景需要触屏设备配置。');
  const errors = await install(page);
  const svg = page.locator('svg.chart-canvas');
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  await page.touchscreen.tap(box.x + box.width * 779 / 800, box.y + box.height / 2);
  await expect(page.locator('.tooltip-value')).toHaveText('29.0%');
  await page.getByRole('button', { name: '放大图表', exact: true }).tap();
  await expect(page.locator('.chart-zoom-summary')).toContainText('已放大 1.5 倍');
  await page.getByRole('button', { name: '重置图表缩放', exact: true }).tap();
  await expect(page.locator('.chart-zoom-summary')).toHaveText('30 个样本');
  expect(errors).toEqual([]);
});

test('键盘选点与导出菜单逐层退出，不截获表单方向键', async ({ page }) => {
  const errors = await install(page);
  const svg = page.locator('svg.chart-canvas');
  await svg.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tooltip-value')).toHaveText('15.0%');
  await page.keyboard.press('ArrowRight'); await expect(page.locator('.tooltip-value')).toHaveText('16.0%');
  const exp = page.getByRole('button', { name: '导出数据', exact: true });
  await exp.click(); await expect(page.getByRole('button', { name: '导出 CSV', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(exp).toBeFocused();
  await expect(page.locator('.export-menu')).toHaveCount(0);
  await page.getByRole('button', { name: '配置告警', exact: true }).click();
  const input = page.getByLabel('阈值（%）', { exact: true });
  await input.focus();
  const prevented = await input.evaluate(element => {
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    element.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.locator('.chart-tooltip')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('悬停后改为单点或空数据不会产生渲染异常', async ({ page }) => {
  const errors = await install(page);
  await hoverSample(page); await expect(page.locator('.tooltip-value')).toHaveText('29.0%');
  await page.evaluate(() => { window.chartFixture.count = 1; });
  await page.getByRole('button', { name: '1分钟', exact: true }).click();
  await expect(page.locator('.chart-zoom-summary')).toHaveText('1 个样本');
  await expect(page.locator('.chart-single-point')).toHaveCount(1);
  await expect(page.locator('.chart-tooltip')).toHaveCount(0);
  expect(await page.locator('svg.chart-canvas').innerHTML()).not.toMatch(/Infinity|NaN/);
  await page.evaluate(() => { window.chartFixture.count = 0; });
  await page.getByRole('button', { name: '1小时', exact: true }).click();
  await expect(page.getByText('当前时间范围暂无历史数据', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('CSV 和 PNG 导出生成真实文件且关闭菜单', async ({ page }, testInfo) => {
  const errors = await install(page);
  await page.getByRole('button', { name: '导出数据', exact: true }).click();
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
  const csv = await csvDownload; await csv.saveAs(testInfo.outputPath('chart.csv'));
  const text = await readFile(testInfo.outputPath('chart.csv'), 'utf8');
  expect(text.trim().split('\n')).toHaveLength(31); expect(text).toContain(',29.00');
  await expect(page.locator('.export-menu')).toHaveCount(0);
  await page.getByRole('button', { name: '导出数据', exact: true }).click();
  const pngDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
  const png = await pngDownload; await png.saveAs(testInfo.outputPath('chart-export.png'));
  const bytes = await readFile(testInfo.outputPath('chart-export.png'));
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.readUInt32BE(16)).toBe(1600); expect(bytes.readUInt32BE(20)).toBe(600);
  expect(errors).toEqual([]);
});

test('PNG 编码失败显示原因，可在原位置重试下载', async ({ page }) => {
  const errors = await install(page);
  await page.evaluate(() => {
    window.nativeChartToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null); };
  });
  await page.getByRole('button', { name: '导出数据', exact: true }).click();
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
  await expect(page.locator('.interactive-chart-wrapper').getByRole('alert')).toContainText('无法编码 PNG');
  await expect(page.getByRole('button', { name: '导出数据', exact: true })).toBeEnabled();
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = window.nativeChartToBlob; });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '重试导出', exact: true }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.png$/);
  await expect(page.locator('.interactive-chart-wrapper').getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.interactive-chart-wrapper').getByRole('status')).toContainText('PNG 已生成');
  expect(errors).toEqual([]);
});
