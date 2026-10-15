import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DockerRunConverter from '../src/components/DockerRunConverter.vue';

let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('Docker Run 转换器可访问性', () => {
  it('关联命令输入标签，并为输出区域和图标操作提供名称', async () => {
    wrapper = mount(DockerRunConverter);
    const input = wrapper.get('#docker-run-command');
    expect(wrapper.get('label[for="docker-run-command"]').text()).toBe('Docker Run 命令');
    await input.setValue('docker run --name demo nginx:latest');
    await wrapper.find('button.btn-convert').trigger('click');
    await flushPromises();

    expect(wrapper.get('pre[role="region"]').attributes('aria-label')).toBe('转换后的 Docker Compose 配置');
    expect(wrapper.get('button[aria-label="复制 Compose 配置"]').exists()).toBe(true);
    expect(wrapper.get('button[aria-label="下载 Compose 配置"]').exists()).toBe(true);
  });

  it('将转换失败原因作为可及时感知的错误提示', async () => {
    wrapper = mount(DockerRunConverter);
    await wrapper.get('#docker-run-command').setValue('docker run');
    await wrapper.find('button.btn-convert').trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toContain('未找到镜像名称');
  });
});
