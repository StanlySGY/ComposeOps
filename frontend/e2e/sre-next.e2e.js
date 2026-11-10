import { test, expect } from '@playwright/test';
test('多服务发布明确兼容性和反序回退授权，并保留失败证据', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/reliability'); await page.getByRole('button', { name: '添加应用目标', exact: true }).click();
  await page.getByRole('combobox', { name: '纳管项目' }).selectOption('local:knowledge-base');
  await page.getByRole('combobox', { name: 'Compose 服务', exact: true }).selectOption('postgres');
  await page.getByRole('textbox', { name: 'HTTP 健康检查地址' }).fill('https://wiki.example/database-health');
  await page.getByRole('button', { name: '保存目标', exact: true }).click();
  await page.getByRole('button', { name: '应用发布', exact: true }).click();
  await page.getByRole('button', { name: '评审应用发布', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '评审多服务发布' });
  for (const service of ['postgres', 'wiki-api']) {
    const row = dialog.locator('article').filter({ has: page.getByRole('checkbox', { name: service, exact: true }) });
    await row.getByRole('checkbox', { name: service, exact: true }).check();
    await row.getByRole('textbox', { name: '节点上已准备的新镜像' }).fill(service + ':next');
    await row.getByRole('textbox', { name: '兼容依据与核验说明' }).fill('已核对新旧版本保持数据兼容');
  }
  await dialog.getByRole('button', { name: '生成完整应用评审' }).click();
  await page.getByRole('button', { name: '审阅并批准' }).click();
  const approval = page.getByRole('dialog', { name: '批准多服务发布' });
  await expect(approval.getByRole('checkbox', { name: /授权失败时反序回退/ })).not.toBeChecked();
  await approval.getByRole('checkbox', { name: /已核对各服务的数据迁移说明/ }).check();
  await approval.getByRole('checkbox', { name: /授权失败时反序回退/ }).check();
  await approval.getByRole('button', { name: '批准当前评审并执行' }).click();
  await expect(page.getByText('已回退并验收', { exact: true })).toBeVisible();
  await expect(page.getByText(/中间服务未通过 HTTP 验收/)).toBeVisible();
  await expect(page.getByText('发布验收通过', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]);
});
test('接入向导完整流程默认关闭修复，待配置项清楚保留', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/reliability?tab=onboarding'); await page.getByRole('button', { name: '接入一个应用', exact: true }).click();
  await page.getByRole('combobox', { name: '应用与节点' }).selectOption('local:knowledge-base');
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('textbox', { name: '待配置原因' }).fill('离线示例暂不接入数据库'); await page.getByRole('button', { name: '下一步', exact: true }).click(); await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '对本应用目标启用有界自动重启' })).not.toBeChecked(); await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '确认配置并接入' }).click(); await expect(page.getByText('接入配置已提交', { exact: true })).toBeVisible(); await expect(page.getByText(/业务恢复：待配置/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]);
});
test('遥测凭据绑定服务范围并只显示一次，关联页面保留假设边界', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/reliability?tab=telemetry'); await page.getByRole('button', { name: '创建接入凭据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建范围受限的遥测凭据' }); await dialog.getByRole('textbox', { name: '凭据名称' }).fill('测试接入'); await dialog.getByRole('combobox', { name: '节点与应用' }).selectOption('local:knowledge-base');
  await dialog.getByRole('checkbox', { name: 'wiki-api' }).check(); await dialog.getByRole('button', { name: '创建凭据', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '遥测接入凭据' })).toHaveValue('离线演示凭据，无法用于真实接入'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '停用该凭据' }).click(); await expect(page.getByText('已停用', { exact: true })).toBeVisible();
  await page.goto('./#/oncall?incident=demo-incident'); await page.getByRole('button', { name: '关联日志、指标与依赖' }).click(); await expect(page.getByText(/待验证假设：数据库不可用/)).toBeVisible(); await expect(page.getByText(/尚未通过干预验证因果/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]);
});
test('业务恢复创建固定断言，HTTP 未通过不展示成功', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/reliability?tab=business'); await page.getByRole('button', { name: '添加业务恢复计划', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加业务恢复计划' }); await dialog.getByRole('combobox', { name: '纳管应用', exact: true }).selectOption('local:knowledge-base');
  await dialog.getByRole('combobox', { name: '数据库服务', exact: true }).selectOption('postgres'); await dialog.getByRole('combobox', { name: '无状态应用服务', exact: true }).selectOption('wiki-api');
  await dialog.getByRole('textbox', { name: '业务数据库名' }).fill('wiki'); await dialog.getByRole('textbox', { name: '表名（可含 schema）' }).fill('public.items'); await dialog.getByRole('textbox', { name: '响应必须包含' }).fill('known');
  await dialog.getByRole('button', { name: '保存固定目标与验收条件' }).click(); await page.getByRole('button', { name: '创建业务备份', exact: true }).click(); await page.getByRole('button', { name: '选择备份并演练' }).click();
  await page.getByRole('button', { name: '确认执行隔离恢复' }).click(); await expect(page.getByText(/业务数据已还原，但 HTTP 业务断言未通过/)).toBeVisible(); await expect(page.getByText('业务恢复通过', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]);
});
test('平台观测与诊断质量页面桌面手机可读', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./#/reliability?tab=platform'); await expect(page.getByRole('heading', { name: '应用可靠性', exact: true })).toBeVisible(); await expect(page.getByText(/平台健康/).first()).toBeVisible();
  await page.goto('./#/reliability?tab=evaluations'); await expect(page.getByText('执行完成 · 质量需改进', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(errors).toEqual([]);
});
