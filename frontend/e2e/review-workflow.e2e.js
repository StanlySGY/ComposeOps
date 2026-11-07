import { test, expect } from '@playwright/test';

async function openReview(page) {
  await page.goto('./#/review');
  await expect(page.getByRole('heading', { name: '变更与回滚', exact: true })).toBeVisible();
  await expect(page.getByLabel('选择项目')).toBeVisible();
}

test('评审与回滚切换保留各自项目和结果，浏览器返回恢复标签', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openReview(page);
  await page.getByLabel('选择项目').selectOption('cache');
  await expect(page.getByRole('heading', { name: /规则风险等级/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: '规则检查建议' })).toBeVisible();
  await expect(page.getByText('分数不代表部署成功率。', { exact: false })).toBeVisible();
  const before = await page.getByText(/cache · 检查于/).textContent();
  await page.getByRole('tab', { name: '自动回滚' }).click();
  await page.getByLabel('选择项目').selectOption('knowledge-base');
  await page.getByRole('tab', { name: '变更评审' }).click();
  await expect(page.getByLabel('选择项目')).toHaveValue('cache');
  await expect(page.getByText(before, { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tab', { name: '自动回滚' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('选择项目')).toHaveValue('knowledge-base');
  await page.goForward();
  await expect(page.getByLabel('选择项目')).toHaveValue('cache');
  await page.getByRole('button', { name: '确认部署…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认部署', exact: true })).toContainText('cache');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('延迟和失败不显示通过状态，重试成功后才开放确认', async ({ page }) => {
  await openReview(page);
  await page.evaluate(() => {
    const original = window.fetch;
    window.__reviewFetch = original;
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/projects/cache/compose?')) {
        await new Promise(resolve => { window.__failReview = resolve; });
        return new Response(JSON.stringify({ message: '测试连接中断' }), { status: 503 });
      }
      return original(...args);
    };
  });
  await page.getByLabel('选择项目').selectOption('cache');
  await expect(page.getByRole('heading', { name: '正在检查当前项目' })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认部署…', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /规则风险等级/ })).toHaveCount(0);
  await page.evaluate(() => window.__failReview());
  await expect(page.getByRole('alert').filter({ hasText: '测试连接中断' })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认部署…', exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.fetch = window.__reviewFetch; });
  await page.getByRole('button', { name: '重新评审', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认部署…', exact: true })).toBeEnabled();
});

test('迟到项目响应和配置变化不会导致错误部署，320px 无横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await openReview(page);
  await page.evaluate(() => {
    const original = window.fetch; window.__reviewFetch = original;
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/projects/cache/compose?')) await new Promise(resolve => { window.__resumeReview = resolve; });
      return original(...args);
    };
  });
  await page.getByLabel('选择项目').selectOption('cache');
  await expect(page.getByRole('heading', { name: '正在检查当前项目' })).toBeVisible();
  await page.getByLabel('选择项目').selectOption('knowledge-base');
  await expect(page.getByText(/knowledge-base · 检查于/)).toBeVisible();
  await page.evaluate(() => { window.__resumeReview(); window.fetch = window.__reviewFetch; });
  await expect(page.getByLabel('选择项目')).toHaveValue('knowledge-base');
  await expect(page.getByText(/knowledge-base · 检查于/)).toBeVisible();
  await page.getByRole('button', { name: '确认部署…', exact: true }).click();
  await page.evaluate(() => {
    const original = window.fetch; window.__deployRequests = 0;
    window.fetch = (...args) => {
      if (String(args[0]).includes('/actions')) window.__deployRequests++;
      if (String(args[0]).includes('/projects/knowledge-base/compose?')) return Promise.resolve(new Response(JSON.stringify({ hostId: 'local', content: 'services: {}' }), { headers: { 'Content-Type': 'application/json' } }));
      return original(...args);
    };
  });
  await page.getByRole('dialog', { name: '确认部署', exact: true }).getByRole('button', { name: '确认部署', exact: true }).click();
  const output = page.getByRole('dialog', { name: /部署输出/ });
  await expect(output).toContainText('本次未部署');
  expect(await page.evaluate(() => window.__deployRequests)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
