import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import CustomComposeProjectModal from '../src/components/services/CustomComposeProjectModal.vue';

const mocks = vi.hoisted(() => ({
  api: {
    getComposeProjectCreateOptions: vi.fn(),
    getHostDirectories: vi.fn(),
    followDeploymentJob: vi.fn(),
    streamCustomComposeProjectDeploy: vi.fn(),
  },
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/api/client.js', async (importOriginal) => ({ ...(await importOriginal()), api: mocks.api }));
vi.mock('../src/stores/toast.js', () => ({ useToastStore: () => mocks.toast }));

const options = {
  hostId: 'local',
  hostName: '本地节点',
  supported: true,
  roots: ['/projects', '/opt/compose-projects'],
};
const compose = 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n';

let wrapper;
const mountModal = async (props = {}) => {
  wrapper = mount(CustomComposeProjectModal, {
    props: { show: false, ...props },
    global: {
      stubs: {
        BaseModal: {
          props: ['show', 'closeDisabled'],
          emits: ['close'],
          template: '<section v-if="show" role="dialog"><header><slot /></header><footer><slot name="footer" /></footer></section>',
        },
      },
    },
  });
  await wrapper.setProps({ show: true });
  await flushPromises();
  return wrapper;
};
const field = label => wrapper.get('[aria-label="' + label + '"]');
const button = label => wrapper.findAll('button').find(item => item.text().includes(label));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.getComposeProjectCreateOptions.mockResolvedValue(options);
  mocks.api.streamCustomComposeProjectDeploy.mockResolvedValue();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('自定义 Compose 项目创建', () => {
  it('实时指出禁用原因，只有用户明确选择才转换大写名称', async () => {
    await mountModal();
    await field('项目名称').setValue('My-Web');
    await field('Compose YAML').setValue(compose);
    expect(field('项目名称').attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('footer').text()).toContain('小写');
    expect(field('项目名称').element.value).toBe('My-Web');
    await button('改为 my-web').trigger('click');
    expect(field('项目名称').attributes('aria-invalid')).toBe('false');
    expect(button('创建并部署').element.disabled).toBe(false);
    await field('Compose YAML').setValue('');
    await field('Compose YAML').trigger('blur');
    expect(field('Compose YAML').attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('footer').text()).toContain('请填写 Compose YAML');
    expect(mocks.api.streamCustomComposeProjectDeploy).not.toHaveBeenCalled();
  });

  it('加载管理员允许的根目录并显示最终项目路径', async () => {
    await mountModal();
    expect(mocks.api.getComposeProjectCreateOptions).toHaveBeenCalledTimes(1);
    expect(field('项目根目录').element.value).toBe('/projects');
    await field('项目名称').setValue('my-web');
    expect(wrapper.text()).toContain('/projects/my-web');
    expect(button('创建并部署').element.disabled).toBe(true);
    await field('Compose YAML').setValue(compose);
    expect(button('创建并部署').element.disabled).toBe(false);
  });

  it('TCP / 不支持节点显示原因且无法提交', async () => {
    mocks.api.getComposeProjectCreateOptions.mockResolvedValue({
      ...options,
      supported: false,
      roots: [],
      reason: 'TCP 节点只提供 Docker API。',
    });
    await mountModal();
    expect(wrapper.text()).toContain('TCP 节点只提供 Docker API。');
    expect(button('创建并部署').element.disabled).toBe(true);
  });

  it('读取创建配置失败时展示错误，不开放空配置提交', async () => {
    mocks.api.getComposeProjectCreateOptions.mockRejectedValue(new Error('权限不足'));
    await mountModal();
    expect(wrapper.get('[role="alert"]').text()).toContain('权限不足');
    expect(button('创建并部署').element.disabled).toBe(true);
    expect(button('重试')).toBeTruthy();
    expect(mocks.api.getComposeProjectCreateOptions).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('配置读取超时后停止加载并允许重试', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.api.getComposeProjectCreateOptions
        .mockImplementationOnce((signal) => new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }))
        .mockResolvedValueOnce(options);

      wrapper = mount(CustomComposeProjectModal, {
        props: { show: false },
        global: {
          stubs: {
            BaseModal: {
              props: ['show', 'closeDisabled'],
              emits: ['close'],
              template: '<section v-if="show" role="dialog"><header><slot /></header><footer><slot name="footer" /></footer></section>',
            },
          },
        },
      });
      await wrapper.setProps({ show: true });
      await vi.advanceTimersByTimeAsync(15000);
      await flushPromises();

      expect(wrapper.get('[role="alert"]').text()).toContain('15 秒');
      expect(button('重试')).toBeTruthy();
      await button('重试').trigger('click');
      await flushPromises();
      expect(field('项目根目录').element.value).toBe('/projects');
      expect(mocks.api.getComposeProjectCreateOptions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('提交 Compose 和 .env，实时展示阶段/输出，创建结果刷新项目列表', async () => {
    const frames = [];
    mocks.api.streamCustomComposeProjectDeploy.mockImplementation(async (payload, onFrame, signal) => {
      frames.push({ payload, signal });
      onFrame({ type: 'phase', data: { phase: 'validating' } });
      onFrame({ type: 'stdout', data: 'validating compose...\n' });
      onFrame({ type: 'phase', data: { phase: 'pulling' } });
      onFrame({ type: 'stdout', data: 'pulling nginx:latest\n' });
      onFrame({
        type: 'result',
        data: {
          ok: true,
          code: 0,
          projectId: 'project-my-web',
          projectName: 'my-web',
          workingDir: '/projects/my-web',
          directoryCreated: true,
          filesCreated: true,
          message: '启动命令已完成，请检查健康状态。',
        },
      });
      onFrame({ type: 'exit', data: { code: 0 } });
    });
    await mountModal();
    await field('项目名称').setValue('my-web');
    await field('Compose YAML').setValue(compose);
    await wrapper.find('details').get('summary').trigger('click');
    await field('.env 内容').setValue('APP_ENV=production\n');

    await button('创建并部署').trigger('click');
    await flushPromises();

    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toEqual({
      projectName: 'my-web',
      rootDir: '/projects',
      composeContent: compose,
      envContent: 'APP_ENV=production\n',
      expectedHostId: 'local',
    });
    expect(frames[0].signal).toBeInstanceOf(AbortSignal);
    expect(wrapper.text()).toContain('拉取镜像');
    expect(wrapper.get('[aria-label="部署输出"]').text()).toContain('pulling nginx:latest');
    expect(wrapper.text()).toContain('启动命令已完成');
    expect(mocks.toast.success).toHaveBeenCalledWith('Compose 项目 my-web 已创建并完成启动命令');
    expect(wrapper.emitted('created')?.[0]?.[0].projectId).toBe('project-my-web');
    expect(button('创建并部署').element.disabled).toBe(true);
  });

  it('服务端返回部署失败时保留输出并提示用户修复', async () => {
    mocks.api.streamCustomComposeProjectDeploy.mockImplementation(async (_payload, onFrame) => {
      onFrame({ type: 'stderr', data: 'pull access denied\n' });
      onFrame({
        type: 'result',
        data: {
          ok: false,
          code: 1,
          projectId: 'project-my-web',
          directoryCreated: true,
          filesCreated: true,
          message: '镜像拉取失败，配置已保留。',
        },
      });
      onFrame({ type: 'exit', data: { code: 1 } });
    });
    await mountModal();
    await field('项目名称').setValue('my-web');
    await field('Compose YAML').setValue(compose);
    await button('创建并部署').trigger('click');
    await flushPromises();

    expect(wrapper.get('[aria-label="部署输出"]').text()).toContain('pull access denied');
    expect(wrapper.text()).toContain('镜像拉取失败，配置已保留。');
    expect(mocks.toast.warning).toHaveBeenCalledWith('镜像拉取失败，配置已保留。');
    expect(wrapper.emitted('created')).toHaveLength(1);
  });

  it('项目名称不安全或超长 .env 被阻止，不调用部署 API', async () => {
    await mountModal();
    await field('项目名称').setValue('../escape');
    await field('Compose YAML').setValue(compose);
    expect(button('创建并部署').element.disabled).toBe(true);
    await field('项目名称').setValue('safe-project');
    await wrapper.find('details').get('summary').trigger('click');
    await field('.env 内容').setValue('x'.repeat(524289));
    expect(button('创建并部署').element.disabled).toBe(true);
    expect(mocks.api.streamCustomComposeProjectDeploy).not.toHaveBeenCalled();
  });

  it('取消按钮发出 close 事件', async () => {
    await mountModal();
    await button('取消').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
  it('校验失败可修改重试，关闭重开仍保留草稿', async () => {
    mocks.api.streamCustomComposeProjectDeploy.mockRejectedValue(Object.assign(new Error('YAML 格式无效'), { status: 422 }));
    await mountModal();
    await field('项目名称').setValue('draft');
    await field('Compose YAML').setValue('services: [');
    await button('创建并部署').trigger('click'); await flushPromises();
    await field('Compose YAML').setValue(compose);
    expect(button('创建并部署').element.disabled).toBe(false);
    await wrapper.setProps({ show: false }); await wrapper.setProps({ show: true }); await flushPromises();
    expect(field('项目名称').element.value).toBe('draft');
    expect(field('Compose YAML').element.value).toBe(compose);
  });

  it('未知结果不能重新创建；持久化失败提供配置入口', async () => {
    mocks.api.streamCustomComposeProjectDeploy.mockRejectedValue(new Error('network failed'));
    await mountModal(); await field('项目名称').setValue('draft'); await field('Compose YAML').setValue(compose);
    await button('创建并部署').trigger('click'); await flushPromises();
    expect(button('创建并部署').element.disabled).toBe(true);
    expect(wrapper.text()).toContain('避免重复部署');
  });

  it('浏览进入任意父目录，使用解析后的真实路径创建', async () => {
    mocks.api.getHostDirectories.mockResolvedValueOnce({ path: '/srv', parent: '/', entries: [{ name: 'apps', path: '/srv/apps' }] })
      .mockResolvedValueOnce({ path: '/mnt/storage/apps', parent: '/mnt/storage', entries: [] });
    await mountModal(); await field('项目根目录').setValue('/srv'); await button('浏览目录').trigger('click'); await flushPromises();
    await button('apps').trigger('click'); await flushPromises();
    expect(field('项目根目录').element.value).toBe('/mnt/storage/apps');
    await field('项目名称').setValue('web'); expect(wrapper.text()).toContain('/mnt/storage/apps/web');
    expect(wrapper.text()).toContain('目标节点：本地节点');
    await field('Compose YAML').setValue(compose + '#' + '中'.repeat(350000));
    expect(button('创建并部署').element.disabled).toBe(true);
    expect(wrapper.text()).toContain('UTF-8 字节');
  });

});
