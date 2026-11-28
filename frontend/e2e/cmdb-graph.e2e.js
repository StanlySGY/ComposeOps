import { test, expect } from '@playwright/test';
async function install(page, flags = {}) {
  await page.goto('./#/dashboard'); await expect(page.locator('.app-header')).toBeVisible();
  await page.evaluate(flags => {
    const original = window.fetch;
    // 该验收只用合成 HTTP 快照，隔离演示 WebSocket 推送的另一套项目数据。
    window.WebSocket = class extends EventTarget {
      static OPEN = 1; readyState = 0; send() {} close() { this.readyState = 3; }
    };
    const f = window.graphFixture = { failRead: false, version: 1, activeHost: 'local', switched: [], ...flags };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const snapshot = () => ({
      assets: [
        { id: 'host:local', kind: 'host', name: 'local', displayName: '本机验收节点', hostId: 'local' },
        { id: 'host:remote', kind: 'host', name: 'remote', displayName: '远端验收节点 ' + f.version, hostId: 'remote' },
        { id: 'project:local-app', kind: 'project', name: 'local-app', displayName: '本机验收项目', hostId: 'local', status: 'stopped' },
        { id: 'project:remote-app', kind: 'project', name: 'remote-app', displayName: '远端验收项目', hostId: 'remote', status: 'running' },
        { id: 'container:local-c', kind: 'container', name: 'local-c', displayName: '本机验收容器', hostId: 'local', status: 'stopped' },
        { id: 'container:remote-c', kind: 'container', name: 'remote-c', displayName: '远端验收容器', hostId: 'remote', status: 'running' },
        { id: 'volume:local:data', kind: 'volume', name: 'data', hostId: 'local' },
        { id: 'volume:remote:data', kind: 'volume', name: 'data', hostId: 'remote' },
      ],
      relations: [
        { sourceId: 'project:local-app', targetId: 'host:local', relation: 'runs_on' },
        { sourceId: 'project:remote-app', targetId: 'host:remote', relation: 'runs_on' },
        { sourceId: 'container:local-c', targetId: 'project:local-app', relation: 'runs_on' },
        { sourceId: 'container:remote-c', targetId: 'project:remote-app', relation: 'runs_on' },
        { sourceId: 'container:local-c', targetId: 'volume:local:data', relation: 'mounts' },
        { sourceId: 'container:remote-c', targetId: 'volume:remote:data', relation: 'mounts' },
      ],
    });
    window.fetch = async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path === '/api/v1/cmdb/topology') return f.failRead ? json({ message: '图谱合成读取失败' }, 503) : json(snapshot());
      if (path === '/api/v1/hosts') return json({ hosts: ['local', 'remote'].map(id => ({ id, name: id === 'local' ? '本机验收节点' : '远端验收节点', type: 'local', status: 'online', active: f.activeHost === id })) });
      if (path === '/api/v1/hosts/active') { f.activeHost = JSON.parse(init.body).hostId; f.switched.push(f.activeHost); return json({ ok: true, activeHostId: f.activeHost }); }
      if (path === '/api/v1/projects') return json({ projects: [{ id: f.activeHost + '-app', hostId: f.activeHost, projectName: f.activeHost === 'remote' ? '远端验收项目' : '本机验收项目', owner: '验收', managed: false, editable: false, containers: [], status: 'stopped' }] });
      return original(input, init);
    };
  }, flags);
  await page.goto('./#/cmdb?tab=graph'); await expect(page.getByRole('heading', { name: '实体全景拓扑' })).toBeVisible();
}

test('图谱同名卷独立且不伪报实时健康，血缘树按宿主分组', async ({ page }) => {
  await install(page); const graph = page.getByRole('img', { name: '运维资产关系图谱' });
  await expect(graph.locator('[data-key]')).toHaveCount(6);
  await expect(graph.locator('[data-key="volume:local:data"]')).toHaveCount(1); await expect(graph.locator('[data-key="volume:remote:data"]')).toHaveCount(1);
  await expect(page.getByText('6 个实体', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无活动告警', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '资产血缘树', exact: true }).click();
  const remote = page.getByRole('region', { name: '节点 远端验收节点 1', exact: true });
  await expect(remote).toContainText('远端验收项目'); await expect(remote).not.toContainText('本机验收项目'); await expect(remote).toContainText('1 个项目');
  await expect(page.getByRole('region', { name: '节点 本机验收节点', exact: true })).toContainText('已停止');
});

test('跨节点进入正确服务并返回图谱页签', async ({ page }) => {
  await install(page); await page.getByRole('button', { name: '资产血缘树', exact: true }).click();
  const link = page.getByRole('link', { name: '进入服务 远端验收项目', exact: true });
  await expect(link).toHaveAttribute('href', /hostId=remote/); await link.click();
  await expect(page).toHaveURL(/#\/services\?focus=remote-app&hostId=remote&from=cmdb/);
  await expect(page.getByRole('heading', { name: '服务总览', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.graphFixture.switched)).toEqual(['remote']);
  await expect(page.getByText('远端验收项目', { exact: true }).first()).toBeVisible();
  await page.getByRole('group', { name: '浏览历史', exact: true }).getByRole('button', { name: '返回资产中心', exact: true }).click();
  await expect(page).toHaveURL(/#\/cmdb\?tab=graph/); await expect(page.getByRole('heading', { name: '资产层级血缘结构' })).toBeVisible();
});

test('读取失败不显示空成功态，重试及缓存页返回会读取新快照', async ({ page }) => {
  await install(page, { failRead: true }); await expect(page.getByRole('alert').filter({ hasText: '图谱合成读取失败' })).toBeVisible();
  await expect(page.getByText('暂无资产图谱', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.graphFixture.failRead = false; }); await page.getByRole('button', { name: '重试图谱', exact: true }).click();
  await expect(page.getByRole('img', { name: '运维资产关系图谱' }).locator('[data-key="host:remote"]')).toContainText('远端验收节点 1');
  await page.goto('./#/dashboard'); await expect(page.getByRole('heading', { name: '运维总览', exact: true })).toBeVisible();
  await page.evaluate(() => { window.graphFixture.version = 2; }); await page.goto('./#/cmdb?tab=graph');
  await expect(page.getByRole('img', { name: '运维资产关系图谱' }).locator('[data-key="host:remote"]')).toContainText('远端验收节点 2');
});

test('320px 图谱工具和血缘树可用，不产生整页横向溢出', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 }); await install(page);
  await expect(page.getByRole('button', { name: '资产血缘树', exact: true })).toBeVisible();
  expect(await page.locator('.app-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: '资产血缘树', exact: true }).click();
  await page.getByRole('region', { name: '节点 远端验收节点 1', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('link', { name: '进入服务 远端验收项目', exact: true })).toBeInViewport();
  expect(await page.locator('.app-main').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cmdb-tree-320.png'), fullPage: true });
});
