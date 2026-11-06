import { test, expect } from '@playwright/test';

test('日志 → 配置 → 日志保留容器，刷新后返回项目保留筛选', async ({ page }) => {
  await page.goto('./#/services?q=knowledge&filter=attention&sort=name');
  await page.locator('#project-knowledge-base .service-project-card__toggle').click();
  await page.getByRole('link', { name: '查看异常日志', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '项目内导航' });
  await expect(page).toHaveURL(/containerId=demo-wiki-api/);
  await nav.getByRole('link', { name: '配置', exact: true }).click();
  await expect(page.getByLabel('选择 Compose 项目')).toHaveValue('knowledge-base');
  await nav.getByRole('link', { name: '日志', exact: true }).click();
  await expect(page).toHaveURL(/containerId=demo-wiki-api/);
  await page.reload();
  await nav.getByRole('link', { name: '项目', exact: true }).click();
  await expect(page.getByLabel('搜索服务项目')).toHaveValue('knowledge');
  await expect(page.getByLabel('状态筛选', { exact: true })).toHaveValue('attention');
  await expect(page.getByLabel('项目排序')).toHaveValue('name');
  await expect(page.locator('#project-knowledge-base .service-project-card__toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('更多操作支持 Escape、焦点恢复和取消，未确认不执行', async ({ page }) => {
  await page.goto('./#/services?focus=knowledge-base');
  const card = page.locator('#project-knowledge-base');
  const more = card.getByRole('button', { name: '更多操作', exact: true });
  await more.click();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await card.getByRole('button', { name: '停止项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '停止项目', exact: true });
  await expect(dialog).toContainText('服务将不可访问');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('region', { name: '操作执行输出' })).toHaveCount(0);
  await expect(more).toBeFocused();
});

test('项目备注可取消和保存，停止容器不能进入终端', async ({ page }) => {
  await page.goto('./#/services?focus=knowledge-base');
  const card = page.locator('#project-knowledge-base');
  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await card.getByRole('group', { name: '更多操作' }).getByRole('button', { name: '编辑备注', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑项目备注' });
  await dialog.getByLabel('项目备注', { exact: true }).fill('待取消的备注');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(card).not.toContainText('待取消的备注');
  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await card.getByRole('group', { name: '更多操作' }).getByRole('button', { name: '编辑备注', exact: true }).click();
  await dialog.getByLabel('项目备注', { exact: true }).fill('这是项目工作区的测试备注');
  await dialog.getByRole('button', { name: '保存备注' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText('这是项目工作区的测试备注');
  const terminal = card.locator('[data-container="demo-wiki-api"]').getByRole('link', { name: '容器终端' });
  await expect(terminal).toHaveAttribute('aria-disabled', 'true');
  await expect(terminal).not.toHaveAttribute('href');
});

test('未保存配置从项目导航离开会确认，取消保留编辑', async ({ page }) => {
  await page.goto('./#/compose?projectId=knowledge-base&containerId=demo-wiki-api');
  await page.getByRole('button', { name: '可视化', exact: true }).click();
  await page.getByRole('button', { name: '新增服务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增服务', exact: true });
  await dialog.getByLabel('服务名称').fill('ux-test');
  await dialog.getByLabel('镜像').fill('nginx:alpine');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('navigation', { name: '项目内导航' }).getByRole('link', { name: '日志', exact: true }).click();
  const leave = page.getByRole('dialog', { name: '配置尚未保存' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/#\/compose/);
  await expect(page.getByText('ux-test', { exact: true })).toBeVisible();
});

test('服务工作区和更多操作在窄屏不溢出', async ({ page }) => {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto('./#/services?focus=knowledge-base');
    await expect(page.locator('#project-knowledge-base')).toBeVisible();
    const more = page.locator('#project-knowledge-base').getByRole('button', { name: '更多操作', exact: true });
    await more.click();
    const panel = page.locator('#project-knowledge-base').getByRole('group', { name: '更多操作' });
    const box = await panel.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
  }
});
