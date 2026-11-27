import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref, h, KeepAlive } from 'vue';
const client = vi.hoisted(() =>
  Object.fromEntries(
    [
      'getMaintenance',
      'getSyncTargets',
      'prepareMaintenance',
      'executeMaintenance',
      'saveMaintenanceSettings',
      'saveSyncTarget',
      'setSyncAutomatic',
      'startBackupSync',
      'authorize115',
      'pollAuthorize115',
      'recoverMaintenanceTask',
      'getProjectUpdates',
      'saveImageCheckSettings',
      'testImageCheckProxy',
      'prepareFullRestore',
      'executeFullRestore',
    ].map((k) => [k, vi.fn()])
  )
);
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const route = vi.hoisted(() => ({ current: null }));
vi.mock('../src/api/client.js', () => ({ api: client }));
vi.mock('vue-router', () => ({ useRoute: () => route.current, useRouter: () => router }));
import MaintenanceView from '../src/views/MaintenanceView.vue';
let wrapper;
const id = 'a'.repeat(64);
const overview = () => ({
  hostId: 'local',
  settings: { backupPath: '/backups/apps' },
  containers: [{ id, name: 'app-web', image: 'example:1', projectName: 'app', state: 'running' }],
  tasks: [],
  backups: [],
});
const backupPlan = () => ({
  token: 'token',
  hostId: 'local',
  backupPath: '/backups/apps',
  action: 'backup',
  selected: [{ id, name: 'app-web' }],
  members: [
    { id, name: 'app-web' },
    { id: 'db', name: 'app-db' },
  ],
  sources: [{ kind: 'bind', source: '/apps/data' }],
  warnings: [],
  blockers: [],
  coverageVerified: true,
  estimatedBytes: 100,
  freeBytes: 1000,
  downtime: '停机归档',
});
beforeEach(() => {
  Object.values(client).forEach((fn) => fn.mockReset());
  router.replace.mockReset();
  route.current = reactive({ query: {} });
  client.getMaintenance.mockResolvedValue(overview());
  client.getSyncTargets.mockResolvedValue({ targets: [] });
  client.prepareMaintenance.mockResolvedValue(backupPlan());
  client.executeMaintenance.mockResolvedValue({ id: 'job' });
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});
async function show() {
  wrapper = mount(MaintenanceView, {
    global: {
      stubs: {
        OperationsCenterView: true,
        BaseModal: { props: ['show'], template: '<section v-if="show"><slot /></section>' },
        ConfirmDialog: true,
      },
    },
  });
  await flushPromises();
}
const button = (text) => wrapper.findAll('button').find((b) => b.text() === text);
describe('完整备份界面的真实确认条件', () => {
  it('可更新筛选保留同 Compose 全部容器，搜索与全选只操作当前显示的应用', async () => {
    const containers = [
      { id, name: 'app-web', service: 'web', projectId: 'app', projectName: 'app', image: 'web:1', state: 'running' },
      { id: 'db', name: 'app-db', service: 'db', projectId: 'app', projectName: 'app', image: 'postgres:15', state: 'running' },
      { id: 'current', name: 'current-web', service: 'web', projectId: 'current', projectName: 'current', image: 'web:1' },
      { id: 'failed', name: 'failed-web', service: 'web', projectId: 'failed', projectName: 'failed', image: 'web:1' },
    ];
    client.getMaintenance.mockResolvedValue({ ...overview(), containers });
    client.getProjectUpdates.mockImplementation(async projectId => {
      if (projectId === 'failed') throw new Error('仓库不可用');
      return { images: projectId === 'app' ? [
        { service: 'web', status: 'updated', hasUpdate: true },
        { service: 'db', status: 'current', hasUpdate: false },
      ] : [{ service: 'web', status: 'current', hasUpdate: false }] };
    });
    await show();
    const selectAll = wrapper.findAll('label').find(label => label.text() === '选择当前应用').get('input');
    await selectAll.setValue(true);
    await wrapper.get('select[aria-label="镜像更新筛选"]').setValue('updatable');
    expect(wrapper.findAll('.maintenance-group')).toHaveLength(1);
    expect(wrapper.text()).toContain('显示 1 / 3 个应用');
    expect(wrapper.text()).toContain('当前列表已选 1 个应用 · 2 个容器');
    await wrapper.get('input[aria-label="搜索容器、应用或镜像"]').setValue('app-db');
    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.text()).toContain('app-web');
    expect(client.prepareMaintenance).not.toHaveBeenCalled();
    await button('备份所选应用').trigger('click');
    await flushPromises();
    expect(client.prepareMaintenance).toHaveBeenCalledExactlyOnceWith({ action: 'backup', containerIds: [id, 'db'], backupPath: '/backups/apps' });
  });
  it('检查中筛选按结果陆续显示，空结果有提示，切节点重置筛选', async () => {
    let finish;
    client.getMaintenance.mockResolvedValue({ ...overview(), containers: [{ ...overview().containers[0], projectId: 'app', service: 'web' }] });
    client.getProjectUpdates.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await show();
    await wrapper.get('select[aria-label="镜像更新筛选"]').setValue('updatable');
    expect(wrapper.findAll('.maintenance-group')).toHaveLength(0);
    expect(wrapper.text()).toContain('可更新的应用会陆续显示');
    finish({ images: [{ service: 'web', status: 'updated', hasUpdate: true }] });
    await flushPromises();
    expect(wrapper.findAll('.maintenance-group')).toHaveLength(1);
    await wrapper.get('input[aria-label="搜索容器、应用或镜像"]').setValue('not-found');
    expect(wrapper.text()).toContain('没有符合条件的可更新应用');
    expect(button('备份所选应用').element.disabled).toBe(true);
    window.dispatchEvent(new Event('composeops:host-changed'));
    await flushPromises();
    expect(wrapper.get('select[aria-label="镜像更新筛选"]').element.value).toBe('all');
  });
  it('旧自动更新链接不提交备份或执行，发布继续走主线评审', async () => {
    route.current.query = { action: 'update', projectId: 'app', hostId: 'local' };
    await show();
    expect(client.prepareMaintenance).not.toHaveBeenCalled();
    expect(client.executeMaintenance).not.toHaveBeenCalled();
    expect(button('更新')).toBeUndefined();
  });
  it('预检阻断完整备份，必须先解决覆盖问题', async () => {
    client.prepareMaintenance.mockResolvedValue({ ...backupPlan(), blockers: ['磁盘空间不足'], coverageVerified: false });
    await show(); await button('备份').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('磁盘空间不足');
    expect(button('开始完整备份').element.disabled).toBe(true);
    expect(client.executeMaintenance).not.toHaveBeenCalled();
  });
  it('默认按 Compose 收起，搜索保留整组及操作范围，刷新保留展开、切节点重置', async () => {
    const dbId = 'b'.repeat(64);
    const containers = [
      { ...overview().containers[0], projectId: 'app', service: 'web' },
      { id: dbId, name: 'app-db', image: 'postgres:15', projectId: 'app', projectName: 'app', service: 'db', state: 'exited' },
      { id: 'other', name: 'other-web', image: 'nginx:latest', projectId: 'other', projectName: 'other', state: 'running' },
    ];
    client.getMaintenance.mockResolvedValue({ ...overview(), containers });
    await show();
    expect(wrapper.findAll('.maintenance-group')).toHaveLength(2);
    expect(wrapper.findAll('.maintenance-table')).toHaveLength(0);
    const group = wrapper.get('article[aria-label="app 运维"]');
    expect(group.text()).toContain('2 个容器');
    expect(group.text()).toContain('1 / 2 运行中');
    expect(group.get('button[aria-expanded]').attributes('aria-expanded')).toBe('false');
    await group.get('button[aria-expanded]').trigger('click');
    expect(group.findAll('tbody tr')).toHaveLength(2);
    await button('刷新').trigger('click');
    await flushPromises();
    expect(wrapper.get('article[aria-label="app 运维"] button[aria-expanded]').attributes('aria-expanded')).toBe('true');
    await wrapper.get('input[aria-label="搜索容器、应用或镜像"]').setValue('app-web');
    expect(wrapper.findAll('.maintenance-group')).toHaveLength(1);
    expect(wrapper.text()).toContain('app-db');
    await wrapper.get('input[aria-label="选择应用 app"]').setValue(true);
    await button('备份所选应用').trigger('click');
    await flushPromises();
    expect(client.prepareMaintenance).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'backup', containerIds: [id, dbId] }));
    window.dispatchEvent(new Event('composeops:host-changed'));
    await flushPromises();
    expect(wrapper.findAll('.maintenance-table')).toHaveLength(0);
  });
  it('同名不同项目不合并，含面板自身的组禁用整组选中和操作，辅助容器独立展示', async () => {
    client.getMaintenance.mockResolvedValue({
      ...overview(), containers: [
        { ...overview().containers[0], projectId: 'first' },
        { id: 'second', name: 'app-two', projectId: 'second', projectName: 'app', state: 'running' },
        { id: 'panel', name: 'panel', self: true, projectId: 'panel', projectName: 'panel' },
        { id: 'peer', name: 'peer', projectId: 'panel', projectName: 'panel' },
        { id: 'helper', name: 'temporary', helper: true, projectId: 'first', projectName: 'app' },
      ],
    });
    await show();
    expect(wrapper.findAll('.maintenance-group')).toHaveLength(3);
    const panel = wrapper.get('article[aria-label="panel 运维"]');
    expect(panel.get('input').element.disabled).toBe(true);
    expect(panel.findAll('.maintenance-row-actions button').every((b) => b.element.disabled)).toBe(true);
    await wrapper.findAll('label').find((label) => label.text() === '选择当前应用').get('input').setValue(true);
    expect(wrapper.text()).toContain('已选 2 个应用');
    await button('备份所选应用').trigger('click');
    await flushPromises();
    expect(client.prepareMaintenance).toHaveBeenLastCalledWith(expect.objectContaining({ containerIds: [id, 'second'] }));
  });
  it('发起运维会中止镜像检查并显示预检等待状态，避免争用工作区', async () => {
    client.getMaintenance.mockResolvedValue({
      ...overview(),
      containers: [{ ...overview().containers[0], projectId: 'p', service: 'web', updateCheckAvailable: true }],
    });
    let signal, resolvePlan;
    client.getProjectUpdates.mockImplementation((_id, _force, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    client.prepareMaintenance.mockImplementation(() => new Promise((resolve) => { resolvePlan = resolve; }));
    await show();
    expect(signal.aborted).toBe(false);
    await button('备份').trigger('click');
    expect(signal.aborted).toBe(true);
    expect(wrapper.text()).toContain('正在预检完整范围');
    expect(button('备份').element.disabled).toBe(true);
    resolvePlan(backupPlan());
    await flushPromises();
    expect(wrapper.text()).not.toContain('正在预检完整范围');
    expect(button('开始完整备份')).toBeDefined();
  });
  it('隔离恢复先预览映射并确认，节点切换后关闭旧计划', async () => {
    route.current.query = { tab: 'backups' };
    client.getMaintenance.mockResolvedValue({ ...overview(), backups: [{ id: 'backup1', names: ['app'], path: '/backups/apps/b1', bytes: 100 }] });
    client.prepareFullRestore.mockResolvedValue({ token: 'restore-token', root: '/new/unique', mappings: [{ file: 'one', source: 'prod_db', target: '/new/unique/db' }], blockers: [] });
    client.executeFullRestore.mockResolvedValue({ id: 'restore-job' });
    await show(); await button('隔离恢复').trigger('click');
    const input = wrapper.findAll('label').find(l => l.text().includes('已存在的宿主机父目录')).get('input');
    await input.setValue('/new'); await button('校验备份并预览映射').trigger('click'); await flushPromises();
    expect(client.prepareFullRestore).toHaveBeenCalledWith({ backupId: 'backup1', destination: '/new', expectedHostId: 'local' });
    expect(wrapper.text()).toContain('prod_db → /new/unique/db');
    expect(button('执行隔离恢复').element.disabled).toBe(true);
    await wrapper.findAll('label').find(l => l.text().includes('确认上述新目录')).get('input').setValue(true);
    await button('执行隔离恢复').trigger('click'); await flushPromises();
    expect(client.executeFullRestore).toHaveBeenCalledWith({ token: 'restore-token', confirmed: true, start: false });
    window.dispatchEvent(new Event('composeops:host-changed')); await flushPromises();
    expect(button('执行隔离恢复')).toBeUndefined();
  });
  it('恢复预检期间修改目录，旧映射不能重新出现或用于确认', async () => {
    route.current.query = { tab: 'backups' };
    client.getMaintenance.mockResolvedValue({ ...overview(), backups: [{ id: 'backup1', names: ['app'], path: '/backups/apps/b1' }] });
    let finish;
    client.prepareFullRestore.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await show(); await button('隔离恢复').trigger('click');
    const input = wrapper.get('input[placeholder="/srv/restore"]');
    await input.setValue('/old');
    await button('校验备份并预览映射').trigger('click');
    await input.setValue('/new');
    finish({ token: 'old-token', root: '/old/unique', mappings: [], blockers: [] });
    await flushPromises();
    expect(button('执行隔离恢复')).toBeUndefined();
    expect(wrapper.text()).toContain('目录已修改');
    expect(client.executeFullRestore).not.toHaveBeenCalled();
    client.prepareFullRestore.mockResolvedValueOnce({ token: 'new-token', root: '/new/unique', mappings: [], blockers: [] });
    await button('校验备份并预览映射').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('/new/unique');
    expect(button('执行隔离恢复').element.disabled).toBe(true);
  });
  it('备份重新预检期间再次修改路径，旧结果不能恢复确认权限', async () => {
    await show(); await button('备份').trigger('click'); await flushPromises();
    const input = wrapper.get('input[aria-label="本次备份保存路径"]');
    await input.setValue('/backups/second');
    let finish;
    client.prepareMaintenance.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await button('重新预检路径及范围').trigger('click');
    await input.setValue('/backups/third');
    finish({ ...backupPlan(), backupPath: '/backups/second' });
    await flushPromises();
    for (const check of wrapper.findAll('input[type="checkbox"]')) await check.setValue(true);
    expect(button('开始完整备份').element.disabled).toBe(true);
    expect(wrapper.text()).toContain('目录已修改');
    expect(client.executeMaintenance).not.toHaveBeenCalled();
  });
  it('代理测试不会保存地址，保存后才强制重新检查', async () => {
    client.getMaintenance.mockResolvedValue({
      ...overview(),
      imageCheck: { proxyUrl: '' },
      containers: [
        { ...overview().containers[0], projectId: 'p', service: 'web', updateCheckAvailable: true },
      ],
    });
    client.getProjectUpdates.mockResolvedValue({ images: [{ service: 'web', status: 'current' }] });
    client.testImageCheckProxy.mockResolvedValue({
      ok: true,
      results: [{ name: 'Docker Hub', ok: true, milliseconds: 700 }],
    });
    client.saveImageCheckSettings.mockResolvedValue({
      proxyUrl: 'http://host.docker.internal:7890',
    });
    await show();
    await button('代理设置').trigger('click');
    await wrapper
      .get('input[aria-label="镜像检查代理地址"]')
      .setValue('http://host.docker.internal:7890');
    await button('测试连接').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('授权及镜像清单读取成功');
    expect(client.saveImageCheckSettings).not.toHaveBeenCalled();
    await wrapper
      .findAll('form')
      .find((f) => f.text().includes('HTTP / HTTPS 代理地址'))
      .trigger('submit');
    await flushPromises();
    expect(client.saveImageCheckSettings).toHaveBeenCalledWith({
      proxyUrl: 'http://host.docker.internal:7890',
    });
    expect(client.getProjectUpdates).toHaveBeenLastCalledWith('p', true, expect.any(Object));
    expect(wrapper.text()).toContain('通过代理检查镜像');
  });
  it('自动逐应用检查，快结果先显示，失败给出原因且不锁定备份操作', async () => {
    const containers = ['a', 'b'].map((key) => ({
      id: key.repeat(64),
      name: key + '-web',
      image: key + ':latest',
      projectName: key,
      projectId: key,
      service: 'web',
      state: 'running',
      updateCheckAvailable: true,
    }));
    client.getMaintenance.mockResolvedValue({ ...overview(), containers });
    let finishSlow;
    client.getProjectUpdates.mockImplementation((projectId) =>
      projectId === 'a'
        ? Promise.resolve({
            checkedAt: 123,
            images: [{ service: 'web', status: 'current', hasUpdate: false }],
          })
        : new Promise((resolve, reject) => {
            finishSlow = { resolve, reject };
          })
    );
    await show();
    expect(client.getProjectUpdates).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('已是最新');
    expect(wrapper.text()).toContain('检查中…');
    expect(wrapper.text()).toContain('已完成 1 / 2');
    expect(button('备份').element.disabled).toBe(false);
    finishSlow.reject(new Error('镜像仓库连接超时'));
    await flushPromises();
    expect(wrapper.text()).toContain('检查失败');
    expect(wrapper.text()).not.toContain('镜像仓库连接超时');
    await wrapper.get('button[aria-label="展开 b"]').trigger('click');
    await wrapper.get('button[aria-label="b-web：检查失败，查看详情"]').trigger('click');
    expect(wrapper.text()).toContain('镜像仓库连接超时');
    expect(wrapper.text()).toContain('已检查 2 个应用');
    expect(button('重试')).toBeDefined();
    expect(wrapper.text()).not.toContain('待检查');
  });
  it('隐藏辅助容器，当前筛选全选排除面板自身和辅助容器', async () => {
    client.getMaintenance.mockResolvedValue({
      ...overview(),
      containers: [
        ...overview().containers,
        { id: 'h', name: 'random-helper', image: 'panel', helper: true, state: 'running' },
        { id: 's', name: 'panel', image: 'panel', self: true, state: 'running' },
      ],
    });
    await show();
    expect(wrapper.text()).not.toContain('random-helper');
    await wrapper.get('input[aria-label="搜索容器、应用或镜像"]').setValue('app-web');
    const select = wrapper
      .findAll('label')
      .find((label) => label.text() === '选择当前应用')
      .get('input');
    await select.setValue(true);
    expect(wrapper.text()).toContain('已选 1 个应用');
    await button('备份所选应用').trigger('click');
    await flushPromises();
    expect(client.prepareMaintenance).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerIds: [id] })
    );
  });
  it('35 秒超时会中止请求并结束检查，切节点后迟到结果不能覆盖新节点', async () => {
    vi.useFakeTimers();
    try {
      const containers = [
        { ...overview().containers[0], projectId: 'p', service: 'web', updateCheckAvailable: true },
      ];
      client.getMaintenance.mockResolvedValue({ ...overview(), containers });
      let requestSignal, late;
      client.getProjectUpdates.mockImplementationOnce(
        (_id, _force, { signal }) =>
          new Promise((_resolve, reject) => {
            requestSignal = signal;
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('timeout', 'AbortError')),
              { once: true }
            );
          })
      );
      await show();
      await vi.advanceTimersByTimeAsync(35_000);
      await flushPromises();
      expect(requestSignal.aborted).toBe(true);
      expect(wrapper.text()).not.toContain('检查超过 35 秒');
      await wrapper.get('button[aria-label="展开 app"]').trigger('click');
      await wrapper.get('button[aria-label="app-web：检查失败，查看详情"]').trigger('click');
      expect(wrapper.text()).toContain('检查超过 35 秒');
      client.getProjectUpdates.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            late = resolve;
          })
      );
      await button('重试').trigger('click');
      client.getMaintenance.mockResolvedValue({ ...overview(), containers: [], hostId: 'remote' });
      window.dispatchEvent(new Event('composeops:host-changed'));
      await flushPromises();
      late({ images: [{ service: 'web', status: 'updated', hasUpdate: true }] });
      await flushPromises();
      expect(wrapper.findAll('.maintenance-group')).toHaveLength(0);
      expect(button('停止检查')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it('已打开运维页时，旧入口及浏览器导航仍切换目标页签并退出旧确认', async () => {
    await show();
    await button('备份').trigger('click');
    await flushPromises();
    expect(button('开始完整备份')).toBeDefined();
    route.current.query = { tab: 'tasks' };
    await flushPromises();
    expect(button('开始完整备份')).toBeUndefined();
    expect(wrapper.get('#maintenance-tab-tasks').attributes('aria-selected')).toBe('true');
    expect(wrapper.text()).toContain('原定时运维计划');
    route.current.query = {};
    await flushPromises();
    expect(wrapper.get('#maintenance-tab-containers').attributes('aria-selected')).toBe('true');
    expect(client.executeMaintenance).not.toHaveBeenCalled();
  });
  it('紧凑列表将简短更新状态与运行状态放在同一格，技术说明只在详情展示', async () => {
    const reason = '已按当前平台的镜像内容与容器实际使用的镜像比较';
    client.getMaintenance.mockResolvedValue({
      ...overview(),
      containers: [
        {
          ...overview().containers[0],
          projectId: 'app',
          service: 'web',
          updateCheckAvailable: true,
        },
      ],
    });
    client.getProjectUpdates.mockResolvedValue({
      checkedAt: 1000,
      images: [{ service: 'web', status: 'updated', hasUpdate: true, reason }],
    });
    await show();
    expect(wrapper.find('.maintenance-status-cell').exists()).toBe(false);
    await wrapper.get('button[aria-label="展开 app"]').trigger('click');
    const cell = wrapper.get('.maintenance-status-cell');
    expect(cell.text()).toContain('可更新');
    expect(cell.text()).toContain('运行中');
    expect(cell.find('.maintenance-state-dot').exists()).toBe(true);
    expect(wrapper.find('.maintenance-update-detail').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(reason);
    await cell.get('button').trigger('click');
    expect(wrapper.text()).toContain(reason);
    expect(wrapper.get('.maintenance-group-header').text()).toContain('Compose 应用');
  });
  it('完整范围先展示，停机影响与密钥保存必须都确认才能执行', async () => {
    await show();
    await button('备份').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('app-db');
    expect(wrapper.text()).toContain('命名卷及匿名卷');
    expect(button('开始完整备份').element.disabled).toBe(true);
    const checks = wrapper.findAll('input[type="checkbox"]');
    await checks[1].setValue(true);
    await checks[2].setValue(true);
    expect(button('开始完整备份').element.disabled).toBe(false);
    await button('开始完整备份').trigger('click');
    await flushPromises();
    expect(client.executeMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true, keySaved: true, token: 'token' })
    );
    expect(wrapper.get('#maintenance-tab-tasks').attributes('aria-selected')).toBe('true');
  });
  it('任何未覆盖项阻止执行，修改保存目录后必须重新预检', async () => {
    const plan = backupPlan();
    plan.blockers = ['挂载不支持完整保存'];
    plan.coverageVerified = false;
    client.prepareMaintenance.mockResolvedValueOnce(plan);
    await show();
    await button('备份').trigger('click');
    await flushPromises();
    const checks = wrapper.findAll('input[type="checkbox"]');
    await checks[1].setValue(true);
    await checks[2].setValue(true);
    expect(button('开始完整备份').element.disabled).toBe(true);
    expect(wrapper.text()).toContain('预检未通过');
    await wrapper.get('input[aria-label="本次备份保存路径"]').setValue('/backups/new');
    expect(button('开始完整备份').element.disabled).toBe(true);
    await button('重新预检路径及范围').trigger('click');
    await flushPromises();
    expect(client.prepareMaintenance).toHaveBeenLastCalledWith(
      expect.objectContaining({ backupPath: '/backups/new' })
    );
    expect(button('开始完整备份').element.disabled).toBe(true);
  });
  it('节点切换清空旧的选择和确认计划', async () => {
    await show();
    await button('备份').trigger('click');
    await flushPromises();
    window.dispatchEvent(new Event('composeops:host-changed'));
    await flushPromises();
    expect(button('开始完整备份')).toBeUndefined();
    expect(client.executeMaintenance).not.toHaveBeenCalled();
  });
  it('115 直接授权入口和自动同步受认证及测试状态约束', async () => {
    client.getSyncTargets.mockResolvedValue({
      targets: [
        {
          id: 't',
          name: '115异地',
          type: '115',
          remotePath: '/backups',
          authorized: false,
          tested: false,
          auto: false,
        },
      ],
    });
    client.authorize115.mockResolvedValue({ id: 'session', qrImage: 'data:image/png;base64,AA==' });
    await show();
    await button('同步').trigger('click');
    await flushPromises();
    expect(button('立即同步').element.disabled).toBe(true);
    await button('扫码授权 115').trigger('click');
    await flushPromises();
    expect(client.authorize115).toHaveBeenCalledWith('t');
    expect(wrapper.find('img[alt="115 授权二维码"]').exists()).toBe(true);
    wrapper.unmount();
    wrapper = null;
  });
});

it('缓存页面停用后停止轮询和镜像请求，重新激活恢复且不重复计时', async () => {
  vi.useFakeTimers();
  const visible = ref(true);
  try {
    wrapper = mount({ setup: () => () => h(KeepAlive, null, () => visible.value ? h(MaintenanceView) : null) }, {
      global: { stubs: { OperationsCenterView: true, FullBackupPlanPanel: true, BaseModal: true, ConfirmDialog: true } },
    });
    await flushPromises();
    expect(client.getMaintenance).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(client.getMaintenance).toHaveBeenCalledTimes(2);
    visible.value = false;
    await flushPromises();
    await vi.advanceTimersByTimeAsync(15000);
    window.dispatchEvent(new Event('composeops:host-changed'));
    await flushPromises();
    expect(client.getMaintenance).toHaveBeenCalledTimes(2);
    visible.value = true;
    await flushPromises();
    expect(client.getMaintenance).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(client.getMaintenance).toHaveBeenCalledTimes(4);
  } finally { wrapper.unmount(); wrapper = null; vi.useRealTimers(); }
});

it('缓存页面离开时作废未完成预检，换节点返回后解除忙碌并重新确认', async () => {
  const visible = ref(true);
  let finish;
  client.prepareMaintenance.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  wrapper = mount({ setup: () => () => h(KeepAlive, null, () => visible.value ? h(MaintenanceView) : null) }, {
    global: { stubs: { OperationsCenterView: true, FullBackupPlanPanel: true, BaseModal: true, ConfirmDialog: true } },
  });
  await flushPromises(); await button('备份').trigger('click');
  visible.value = false; await flushPromises();
  client.getMaintenance.mockResolvedValue({ ...overview(), hostId: 'other', settings: { backupPath: '/other/backups' } });
  window.dispatchEvent(new Event('composeops:host-changed'));
  finish(backupPlan()); await flushPromises();
  visible.value = true; await flushPromises();
  expect(button('开始完整备份')).toBeUndefined();
  expect(wrapper.text()).not.toContain('正在预检完整范围');
  expect(button('备份').element.disabled).toBe(false);
  await button('备份').trigger('click'); await flushPromises();
  expect(client.prepareMaintenance).toHaveBeenLastCalledWith(expect.objectContaining({ backupPath: '/other/backups' }));
});
