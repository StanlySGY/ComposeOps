import { test, expect } from '@playwright/test';

const previewBase = process.env.PREVIEW_BASE_URL || 'http://127.0.0.1:4174/ComposeOps/';
function observe(page) {
  const errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (!request.url().startsWith(previewBase) && url.protocol !== 'data:') network.push(request.url());
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') network.push(request.url());
  });
  return { errors, network };
}
const routes = {
  dashboard: '运维总览', services: '服务总览', compose: 'Compose 配置', logs: '实时日志', agent: 'AI 智能运维 Agent',
  shell: '容器终端', monitor: '实时监控', resources: '存储清理', settings: '设置', topology: '服务拓扑中心', events: '事件中心',
  inspection: 'AI 巡检中心', 'agent/history': 'Agent 执行历史', 'ops-center': '运维任务中心', workflows: '工作流中心',
  cron: '定时任务', gitops: 'GitOps 集成', review: '变更与回滚', cmdb: '资产中心 (CMDB)', 'node-groups': '节点组管理',
  marketplace: '应用市场', cost: '成本分析',
};
test('真实应用导航和全部页面可访问，没有后端流量或渲染错误', async ({ page }) => {
  test.setTimeout(60000);
  const observed = observe(page);
  for (const [route, title] of Object.entries(routes)) {
    await page.goto('./?route=' + encodeURIComponent(route) + '#/' + route);
    await expect(page.locator('.app-header')).toBeVisible();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.locator('.loading-mark')).toHaveCount(0);
    await expect(page.locator('.alert-error,.runtime-error-bar')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const unnamedControls = await page.locator('button:visible, a:visible').evaluateAll((elements) => elements
      .filter((element) => ![
        element.getAttribute('aria-label'), element.getAttribute('aria-labelledby'), element.getAttribute('title'),
        element.innerText, element.textContent,
      ].some((value) => String(value || '').trim()))
      .map((element) => ({ tag: element.tagName.toLowerCase(), className: String(element.className || '').slice(0, 80), html: element.outerHTML.slice(0, 180) })));
    expect(unnamedControls, `存在缺少可识别名称的按钮/链接：${route}`).toEqual([]);
  }
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('真实 Agent 审批门可拒绝、确认，刷新后重置示例', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/agent');
  const input = page.locator('.agent-composer textarea');
  await input.fill('排查 wiki-api');
  await input.press('Enter');
  await expect(page.getByText('需要确认后执行')).toBeVisible();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByText('已拒绝模拟操作，配置与服务状态保持原样。', { exact: false })).toBeVisible();
  await input.fill('继续排查 wiki-api');
  await input.press('Enter');
  await expect(page.getByText('需要确认后执行')).toBeVisible();
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByText('模拟修复完成：wiki-api 已恢复运行，数据库连接检查通过。', { exact: false })).toBeVisible();
  await page.evaluate(() => { location.hash = '/services'; });
  await expect(page.locator('#project-knowledge-base')).toContainText('运行中');
  await page.getByRole('button', { name: '重置演示', exact: true }).click();
  await expect(page.locator('#project-knowledge-base')).toContainText('部分异常');
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('真实多渠道表单支持独立保存、显隐示例密钥与顺序调整', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/settings?tab=ai');
  const channel = page.locator('[data-channel-id="primary-demo"]');
  await channel.locator('[data-field="name"]').fill('我的示例主渠道');
  await channel.getByRole('button', { name: '保存此渠道' }).click();
  await expect(channel.getByText('此渠道已保存')).toBeVisible();
  await channel.locator('[data-action="reveal"]').click();
  await expect(channel.getByRole('textbox', { name: '已保存的 API Key' })).toHaveValue('demo-key-not-a-real-credential');
  await channel.locator('[data-action="reveal"]').click();
  await expect(channel.getByRole('textbox', { name: '已保存的 API Key' })).toHaveCount(0);
  await channel.getByRole('button', { name: '降低优先级' }).click();
  await expect(page.locator('[data-channel-id]').first()).toHaveAttribute('data-channel-id', 'backup-demo');
  await page.reload();
  await expect(page.locator('[data-channel-id]').first()).toHaveAttribute('data-channel-id', 'primary-demo');
  await expect(channel.locator('[data-field="name"]')).toHaveValue('主渠道（示例）');
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('真实服务搜索、日志与卷备份界面可交互', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/services');
  await page.getByPlaceholder('搜索项目、容器、镜像或路径').fill('missing');
  await expect(page.getByText('没有匹配当前条件的项目')).toBeVisible();
  await page.getByPlaceholder('搜索项目、容器、镜像或路径').fill('redis');
  await expect(page.locator('article[id^="project-"]')).toHaveCount(1);
  await page.goto('./#/logs?projectId=knowledge-base&containerId=demo-wiki-api');
  await expect(page.getByText(/ENOTFOUND db-old/)).toBeVisible();
  await page.goto('./#/resources');
  await page.getByRole('button', { name: '卷备份' }).click();
  await expect(page.getByText('cache-data-demo.tar.gz')).toBeVisible();
  await page.getByRole('button', { name: '验证备份 cache-data-demo.tar.gz' }).click();
  await expect(page.getByText('✓ 128 文件')).toBeVisible();
  await page.getByRole('button', { name: '安装部署', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '安装 ComposeOps' })).toContainText('releases/latest/download/compose.yml');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('配置页直达项目、切换视图和重新选择项目后编辑器仍显示内容', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/compose?projectId=knowledge-base');
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect(page.locator('.monaco-editor')).toContainText('db-old');
  await page.getByRole('button', { name: '可视化', exact: true }).click();
  await expect(page.getByText('服务列表', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '代码', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toContainText('db-old');
  await page.getByTitle('清除当前选择,回到引导页').click();
  await expect(page.getByText('请先选择一个已挂载的项目')).toBeVisible();
  await page.locator('main select').first().selectOption('cache');
  await expect(page.locator('.monaco-editor')).toContainText('redis:7.4-alpine');
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

// A configured channel URL must never become an actual outbound request.
test('未知与外部请求在离线适配器中失败，不回退到真实网络', async ({ page }) => {
  const observed = observe(page);
  await page.goto('./#/dashboard');
  await expect(page.getByRole('heading', { name: '运维总览' })).toBeVisible();
  const responses = await page.evaluate(async () => {
    const external = await fetch('https://must-not-contact.example.invalid/v1/chat/completions', { method: 'POST' });
    const unknown = await fetch('/api/v1/preview-unknown', { method: 'DELETE' });
    return [external.status, unknown.status];
  });
  expect(responses).toEqual([501, 501]);
  expect(observed.errors).toEqual([]);
  expect(observed.network).toEqual([]);
});

test('快速跳转支持键盘搜索、执行与 Escape 关闭', async ({ page }) => {
  const trigger = page.getByRole('button', { name: '打开快速跳转' });
  await page.goto('./#/dashboard');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '快速跳转与操作' });
  await expect(dialog).toBeVisible();
  const search = dialog.getByRole('combobox', { name: '搜索命令' });
  await expect(search).toBeFocused();
  await search.fill('设置');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await expect(dialog.getByRole('option').first()).toContainText('系统设置');
  await search.press('Enter');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('移动端更多功能抽屉可导航、Escape 可关闭且页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/dashboard');
  const more = page.getByRole('button', { name: '更多功能' });
  await more.click();
  const drawer = page.getByRole('dialog', { name: '更多功能' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('link', { name: '设置' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await more.click();
  await drawer.getByRole('link', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(drawer).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('数据卷恢复和删除均先展示明确的确认门，取消后不执行破坏性操作', async ({ page }) => {
  await page.goto('./#/resources');
  await page.getByRole('button', { name: '卷备份' }).click();
  await expect(page.getByText('cache-data-demo.tar.gz')).toBeVisible();
  await page.getByRole('button', { name: '恢复卷 cache_data 的备份' }).click();
  const restoreDialog = page.getByRole('dialog', { name: '恢复数据卷' });
  await expect(restoreDialog).toContainText('仅演练通过后才会');
  await restoreDialog.getByRole('button', { name: '取消' }).click();
  await expect(restoreDialog).toHaveCount(0);
  await page.getByRole('button', { name: '删除备份 cache-data-demo.tar.gz' }).click();
  const deleteDialog = page.getByRole('dialog', { name: '删除备份' });
  await expect(deleteDialog).toContainText('该操作不可恢复');
  await deleteDialog.getByRole('button', { name: '取消' }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(page.getByText('cache-data-demo.tar.gz')).toBeVisible();
});

test('定时任务创建表单先做本地校验，离线不支持的提交会明确报错且保留草稿', async ({ page }) => {
  await page.goto('./#/cron');
  await page.getByRole('button', { name: '新建定时任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建定时任务' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '创建任务' }).click();
  await expect(dialog.getByText('请填写任务名称')).toBeVisible();
  const name = dialog.getByPlaceholder('例如:每天凌晨自动备份数据库');
  await name.fill('回归测试任务');
  await dialog.getByRole('button', { name: '创建任务' }).click();
  await expect(dialog.getByText(/未在离线预览中模拟/)).toBeVisible();
  await expect(name).toHaveValue('回归测试任务');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('工作流编辑器能拦截空名称和重复节点 ID', async ({ page }) => {
  await page.goto('./#/workflows');
  await page.getByRole('button', { name: '新建工作流' }).click();
  const dialog = page.getByRole('dialog', { name: '新建工作流' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('请填写工作流名称')).toBeVisible();
  await dialog.getByPlaceholder('如:故障自动处理').fill('回归测试工作流');
  const nodeIds = dialog.getByPlaceholder('节点 ID');
  await nodeIds.nth(1).fill('trigger');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('节点 ID 重复:trigger')).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('GitOps 添加仓库表单阻止缺少必填字段的提交', async ({ page }) => {
  await page.goto('./#/gitops');
  await page.getByRole('button', { name: '添加仓库' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加仓库' });
  await expect(dialog).toBeVisible();
  const required = dialog.locator('form input[required], form select[required]');
  expect(await required.count()).toBeGreaterThanOrEqual(4);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await required.evaluateAll((fields) => fields.some((field) => !field.checkValidity()))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
