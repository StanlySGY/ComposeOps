import { test, expect } from '@playwright/test';

async function expectHeaderAlignment(page) {
  const geometry = await page.locator('.app-header').evaluate(header => {
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, center: rect.top + rect.height / 2, height: rect.height };
    };
    const visible = element => element.getClientRects().length && getComputedStyle(element).display !== 'none';
    const controls = [...header.querySelectorAll('.header-control, .header-actions > .icon-btn, .header-actions > .relative > .icon-btn')].filter(visible).map(box);
    const brand = header.querySelector('.app-brand');
    const title = header.querySelector('.brand-title');
    return {
      mark: box(header.querySelector('.brand-mark')),
      title: visible(title) ? { ...box(title), opacity: getComputedStyle(title).opacity } : null,
      brand: box(brand), controls,
      viewport: innerWidth,
      contentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(geometry.controls.length).toBeGreaterThanOrEqual(5);
  for (const control of geometry.controls) {
    expect(Math.abs(control.center - geometry.mark.center)).toBeLessThanOrEqual(1);
    expect(control.height).toBeGreaterThanOrEqual(36);
    expect(control.right).toBeLessThanOrEqual(geometry.viewport);
  }
  expect(Math.max(...geometry.controls.map(control => control.height)) - Math.min(...geometry.controls.map(control => control.height))).toBeLessThanOrEqual(1);
  expect(geometry.brand.right).toBeLessThanOrEqual(geometry.controls[0].left);
  expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.viewport);
  if (geometry.title) {
    expect(Math.abs(geometry.title.center - geometry.mark.center)).toBeLessThanOrEqual(1);
    expect(geometry.title.opacity).toBe('1');
  }
}

test('品牌与工具栏始终对齐，滚动和紧凑模式不会隐藏或挪动品牌', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./#/services');
  await expect(page.locator('#project-cache')).toBeVisible();
  // 路由入场结束后才恢复页面滚动；等待恢复完成再模拟用户滚动。
  await expect(page.locator('.page-fade-enter-active')).toHaveCount(0);
  await expectHeaderAlignment(page);
  const before = await page.locator('.brand-title').boundingBox();
  await page.locator('.app-main').evaluate(element => { element.scrollTop = 300; });
  await expect(page.locator('.app-header')).toHaveClass(/scrolled/);
  await expectHeaderAlignment(page);
  expect(await page.locator('.brand-title').boundingBox()).toEqual(before);
  await page.getByRole('button', { name: '紧凑布局', exact: true }).click();
  await expectHeaderAlignment(page);
  await page.locator('.app-header').screenshot({ path: test.info().outputPath('header-desktop.png'), animations: 'disabled' });
});

test('各断点控件可见且同高，节点名不会在平板消失，窄屏触控目标完整', async ({ page }) => {
  await page.goto('./#/dashboard');
  await expect(page.locator('.app-brand')).toBeVisible();
  for (const width of [320, 360, 390, 640, 641, 767, 768, 900, 1024, 1280, 1440, 2048]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectHeaderAlignment(page);
    const nodeName = page.locator(width <= 767 ? '.host-name-short' : '.host-name');
    await expect(nodeName).toBeVisible();
    await expect(nodeName).not.toHaveText('');
    if (width <= 640) {
      for (const label of ['打开快速跳转', '快速切换项目', '切换 Docker 节点', '打开事件中心', '退出登录']) {
        expect((await page.getByRole('button', { name: label, exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(40);
      }
    }
    if (width === 390) await page.locator('.app-header').screenshot({ path: test.info().outputPath('header-mobile.png'), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
  await expectHeaderAlignment(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.header-chevron').first().evaluate(element => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(0.001);
});

test('统一顶栏保留搜索、项目与节点选择的键盘和焦点闭环', async ({ page }) => {
  await page.goto('./#/dashboard');
  const search = page.getByRole('button', { name: '打开快速跳转', exact: true });
  await search.click();
  await expect(page.getByRole('dialog', { name: '快速跳转与操作' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  for (const [label, panel] of [['快速切换项目', '#project-switcher-panel'], ['切换 Docker 节点', '#docker-host-switcher-panel'], ['打开事件中心', '#event-center-panel']]) {
    const trigger = page.getByRole('button', { name: label, exact: true });
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(panel)).toBeVisible();
    const rect = await page.locator(panel).boundingBox();
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize().width);
    if (panel === '#event-center-panel') {
      const title = await page.locator('#event-center-title').boundingBox();
      const options = await page.locator('.event-panel-options').boundingBox();
      expect(title.width).toBeGreaterThan(180);
      expect(options.y).toBeGreaterThan(title.y + title.height);
    }
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.mouse.click(page.viewportSize().width / 2, page.viewportSize().height - 80);
    await expect(page.locator(panel)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await page.getByRole('button', { name: '快速切换项目', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索项目', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索项目', exact: true }).fill('cache');
  await page.locator('#project-switcher-panel').getByRole('button', { name: /^cache / }).click();
  await expect(page).toHaveURL(/#\/services\?.*focus=cache/);
  await page.getByRole('button', { name: '切换 Docker 节点', exact: true }).click();
  await page.locator('.host-item[aria-current="true"]').click();
  await expect(page.locator('#docker-host-switcher-panel')).toHaveCount(0);
});

test('Logo 返回总览且尊重未保存配置保护', async ({ page }) => {
  await page.goto('./#/services');
  const home = page.getByRole('link', { name: 'ComposeOps，返回运维总览', exact: true });
  await home.click();
  await expect(page).toHaveURL(/#\/dashboard$/);
  await page.goto('./#/compose?projectId=knowledge-base');
  await page.getByRole('button', { name: '可视化', exact: true }).click();
  await page.getByRole('button', { name: '新增服务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新增服务', exact: true });
  await editor.getByLabel('服务名称').fill('header-draft');
  await editor.getByLabel('镜像').fill('nginx:alpine');
  await editor.getByRole('button', { name: '创建', exact: true }).click();
  await home.click();
  const leave = page.getByRole('dialog', { name: '配置尚未保存' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/#\/compose/);
  await expect(page.getByText('header-draft', { exact: true })).toBeVisible();
});
