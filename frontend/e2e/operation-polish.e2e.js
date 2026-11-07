import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function installOperationFixture(page, { code = 0, health = 'healthy', omitExit = false } = {}) {
  await page.evaluate(({ code, health, omitExit }) => {
    const original = window.fetch;
    let operated = false;
    let action = '';
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/projects/cache/actions') {
        operated = true;
        action = JSON.parse(init.body).action;
        const frames = [{ type: 'stdout', data: '测试操作输出\n' + Array.from({ length: 80 }, (_, i) => `步骤 ${i + 1}`).join('\n') }];
        if (!omitExit) frames.push({ type: 'exit', data: { code } });
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const response = await original(input, init);
      if (path === '/api/v1/projects' && operated) {
        const data = await response.json();
        const project = data.projects.find(item => item.id === 'cache');
        project.status = action === 'stop' ? 'stopped' : 'running';
        project.containers.forEach(container => { container.state = action === 'stop' ? 'exited' : 'running'; container.health = action === 'stop' ? '' : health; });
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      }
      return response;
    };
  }, { code, health, omitExit });
}
async function services(page, fixture = {}) {
  await page.goto('./#/services');
  await expect(page.locator('#project-cache .project-detail')).toBeVisible();
  await installOperationFixture(page, fixture);
}
async function run(page, label, confirmation) {
  const card = page.locator('#project-cache');
  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  await card.getByRole('button', { name: label, exact: true }).click();
  if (confirmation) await page.getByRole('dialog', { name: confirmation, exact: true }).getByRole('button', { name: confirmation, exact: true }).click();
  return page.getByRole('dialog', { name: /cache 操作输出/ });
}
test('环境简报直达异常日志且能返回总览，布局无溢出', async ({ page }) => {
  await page.goto('./#/dashboard');
  const brief = page.getByRole('region', { name: '1 个项目需要你关注' });
  await expect(brief).toBeVisible();
  await brief.getByRole('link', { name: '查看首个异常日志' }).click();
  await expect(page.getByRole('heading', { name: '实时日志', exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toContain('containerId=demo-wiki-api');
  await page.getByRole('button', { name: /返回.*总览/ }).first().click();
  await expect(brief).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('操作后核对容器、回看输出、下载并进入日志返回项目', async ({ page }) => {
  await services(page);
  const drawer = await run(page, '重启项目', '重启项目');
  await expect(drawer.getByText('已核对：当前容器全部运行')).toBeVisible();
  await expect(drawer.getByText(/请继续确认业务访问/)).toBeVisible();
  const output = drawer.getByRole('region', { name: '操作执行输出' });
  await output.evaluate(element => { element.scrollTop = 0; });
  await expect(drawer.getByRole('button', { name: '回到最新' })).toBeVisible();
  await drawer.getByRole('button', { name: '回到最新' }).click();
  await expect.poll(() => output.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(32);
  await page.screenshot({ path: test.info().outputPath('operation-result.png'), animations: 'disabled' });
  const downloadPromise = page.waitForEvent('download');
  await drawer.getByRole('button', { name: '下载输出' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^composeops-cache-.*\.log$/);
  const exported = await readFile(await download.path(), 'utf8');
  expect(exported).toContain('测试操作输出');
  expect(exported).toContain('步骤 80');
  await drawer.getByRole('button', { name: '关闭输出面板' }).click();
  const receipt = page.locator('.operation-receipt');
  await expect(receipt).toContainText('重启 · cache');
  await receipt.click();
  await expect(drawer.getByText('已核对：当前容器全部运行')).toBeVisible();
  await drawer.getByRole('button', { name: '查看日志', exact: true }).click();
  await expect(page.getByRole('heading', { name: '实时日志', exact: true })).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page.getByRole('button', { name: '返回服务总览' }).click();
  await expect(receipt).toBeVisible();
});
test('健康检查初始化与失败命令独立呈现，不伪报恢复', async ({ page }) => {
  await services(page, { code: 1, health: 'starting' });
  const drawer = await run(page, '重启项目', '重启项目');
  await expect(drawer.locator('[data-state="failed"]')).toContainText('执行失败');
  await expect(drawer.getByText('容器已运行，等待健康检查')).toBeVisible();
  await expect(drawer.getByRole('button', { name: '一键 AI 诊断' })).toBeVisible();
  await drawer.getByRole('button', { name: '重新核对' }).click();
  await expect(drawer.getByText('容器已运行，等待健康检查')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('断流无退出码仍保留未知结果，停止操作按停止状态核对', async ({ page }) => {
  await services(page, { omitExit: true });
  let drawer = await run(page, '重启项目', '重启项目');
  await expect(drawer.locator('[data-state="unknown"]')).toContainText('尚未确认执行结果');
  await drawer.getByRole('button', { name: '关闭输出面板' }).click();
  await page.reload();
  await expect(page.locator('#project-cache .project-detail')).toBeVisible();
  await installOperationFixture(page);
  drawer = await run(page, '停止项目', '停止项目');
  await expect(drawer.getByText('已核对：容器全部停止')).toBeVisible();
  await expect(drawer.getByRole('button', { name: '查看日志', exact: true })).toHaveCount(0);
});
test('拉取完成引导检查配置，不将下载成功当成已部署', async ({ page }) => {
  await services(page);
  const drawer = await run(page, '拉取镜像');
  await expect(drawer.getByText('镜像已拉取，尚未应用到容器')).toBeVisible();
  await drawer.getByRole('button', { name: '检查配置' }).click();
  await expect(page.getByRole('heading', { name: 'Compose 配置', exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toContain('projectId=cache');
  await expect(page.getByRole('dialog', { name: /操作输出/ })).toHaveCount(0);
});
test('服务卡菜单可越过卡片边界，末项可直接点击', async ({ page }) => {
  await services(page);
  const card = page.locator('#project-cache');
  await card.evaluate(element => {
    const main = document.querySelector('.app-main');
    main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 4;
  });
  await card.getByRole('button', { name: '更多操作', exact: true }).click();
  const stop = card.getByRole('button', { name: '停止项目', exact: true });
  await stop.scrollIntoViewIfNeeded();
  expect(await stop.evaluate(button => {
    const rect = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  await stop.click();
  await page.getByRole('dialog', { name: '停止项目', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
});
