import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import AiChannelsPanel from '../src/components/settings/AiChannelsPanel.vue';

const api = vi.hoisted(() => ({ fetchAiModels: vi.fn(), testAiChannel: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const channel = (id) => ({ id, name: id, baseUrl: `http://${id}.test/v1`, apiKey: '', hasApiKey: true, model: 'model', enabled: true, supportsTools: true, firstTokenTimeoutMs: 30000, saved: true, dirty: false });
function render(channels = [channel('primary'), channel('backup')]) {
  return mount(defineComponent({ components: { AiChannelsPanel }, setup: () => ({ channels: ref(channels), failover: ref(true) }),
    template: '<AiChannelsPanel v-model:channels="channels" v-model:failover-enabled="failover" />' }));
}
beforeEach(() => vi.clearAllMocks());

describe('AI 渠道设置', () => {
  it('排序、停用、新增、删除都通过完整列表更新且不串密钥', async () => {
    const wrapper = render();
    await wrapper.findAll('button[aria-label="提高优先级"]')[1].trigger('click');
    expect(wrapper.vm.channels.map(item => item.id)).toEqual(['backup', 'primary']);
    await wrapper.find('article input[type=checkbox]').setValue(false);
    expect(wrapper.vm.channels[0].enabled).toBe(false);
    await wrapper.find('button').trigger('click');
    expect(wrapper.vm.channels).toHaveLength(3);
    expect(wrapper.vm.channels[2].apiKey).toBe('');
    await wrapper.findAll('button[aria-label="移除渠道"]')[2].trigger('click');
    expect(wrapper.vm.channels).toHaveLength(2);
  });

  it('修改地址后测试按钮禁用，保存前不测试旧配置', async () => {
    const wrapper = render([channel('primary')]);
    await wrapper.findAll('article input')[2].setValue('http://changed.test/v1');
    const testButton = wrapper.findAll('button').find(button => button.text().includes('测试连接'));
    expect(testButton.attributes('disabled')).toBeDefined();
    expect(wrapper.vm.channels[0].dirty).toBe(true);
    expect(api.testAiChannel).not.toHaveBeenCalled();
  });

  it('模型列表使用所选渠道 ID，测试显示耗时和工具结果', async () => {
    api.fetchAiModels.mockResolvedValue({ models: ['m1', 'm2'] });
    api.testAiChannel.mockResolvedValue({ latencyMs: 18, supportsTools: true });
    const wrapper = render([channel('backup')]);
    await wrapper.find('button[aria-label="获取此渠道的模型"]').trigger('click'); await flushPromises();
    expect(api.fetchAiModels).toHaveBeenCalledWith({ channelId: 'backup', baseUrl: 'http://backup.test/v1', apiKey: undefined });
    expect(wrapper.findAll('datalist option')).toHaveLength(2);
    await wrapper.findAll('button').find(button => button.text().includes('测试连接')).trigger('click'); await flushPromises();
    expect(api.testAiChannel).toHaveBeenCalledWith('backup');
    expect(wrapper.text()).toContain('18 ms'); expect(wrapper.text()).toContain('工具调用通过');
  });

  it('失败给出原因；旧地址的迟到模型列表不会覆盖新地址', async () => {
    let resolve;
    api.fetchAiModels.mockImplementation(() => new Promise(r => { resolve = r; }));
    const wrapper = render([channel('primary')]);
    await wrapper.find('button[aria-label="获取此渠道的模型"]').trigger('click');
    await wrapper.findAll('article input')[2].setValue('http://changed.test/v1');
    resolve({ models: ['old-model'] }); await flushPromises();
    expect(wrapper.findAll('datalist option')).toHaveLength(0);
    const saved = render([channel('backup')]);
    api.testAiChannel.mockRejectedValue(new Error('上游限流（429）'));
    await saved.findAll('button').find(button => button.text().includes('测试连接')).trigger('click'); await flushPromises();
    expect(saved.text()).toContain('上游限流（429）');
  });
});
