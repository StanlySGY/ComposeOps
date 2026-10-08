import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref, KeepAlive } from 'vue';
import AiChannelsPanel from '../src/components/settings/AiChannelsPanel.vue';

const api = vi.hoisted(() => ({ fetchAiModels: vi.fn(), testAiChannel: vi.fn(), saveAiChannel: vi.fn(), deleteAiChannel: vi.fn(), reorderAiChannels: vi.fn(), revealAiChannelKey: vi.fn(), getAiConfig: vi.fn() }));
vi.mock('../src/api/client.js', () => ({ api }));
const channel = (id) => ({ id, name: id, baseUrl: `http://${id}.test/v1`, apiKey: '', hasApiKey: true, model: 'model', enabled: true, supportsTools: true, streamToolCalls: true, firstTokenTimeoutMs: 30000, saved: true, dirty: false, revision: `rev-${id}` });
const wrappers = [];
function render(channels = [channel('primary'), channel('backup')]) {
  const wrapper = mount(defineComponent({ components: { AiChannelsPanel, KeepAlive }, setup: () => ({ channels: ref(channels), shown: ref(true) }),
    template: '<KeepAlive><AiChannelsPanel v-if="shown" v-model:channels="channels" /></KeepAlive>' }));
  wrappers.push(wrapper); return wrapper;
}
const row = (wrapper, id = 'primary') => wrapper.find(`[data-channel-id="${id}"]`);
const action = (wrapper, name) => wrapper.find(`[data-action="${name}"]`);
beforeEach(() => {
  vi.resetAllMocks();
  api.saveAiChannel.mockImplementation(async (id, payload) => ({ channel: { ...channel(id), ...payload, apiKey: '••••test', revision: `saved-${id}` } }));
  api.reorderAiChannels.mockResolvedValue({ ok: true });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers(); });

describe('AI 渠道设置', () => {
  it('单独保存目标行，不覆盖另一行未保存草稿', async () => {
    const wrapper = render();
    await row(wrapper, 'backup').find('[data-field="name"]').setValue('备用草稿');
    await row(wrapper).find('[data-field="name"]').setValue('主渠道修改');
    await action(row(wrapper), 'save').trigger('click'); await flushPromises();
    expect(api.saveAiChannel).toHaveBeenCalledTimes(1);
    expect(api.saveAiChannel.mock.calls[0][0]).toBe('primary');
    expect(wrapper.vm.channels[0].dirty).toBe(false);
    expect(wrapper.vm.channels[1].name).toBe('备用草稿'); expect(wrapper.vm.channels[1].dirty).toBe(true);
    expect(wrapper.vm.channels[0].apiKey).toBe('');
  });

  it('保存并测试先保存当前编辑值，失败时不测试旧配置', async () => {
    api.testAiChannel.mockResolvedValue({ ok: true, latencyMs: 18, checks: [] });
    const wrapper = render([channel('primary')]);
    await row(wrapper).find('[data-field="baseUrl"]').setValue('http://changed.test/v1');
    api.saveAiChannel.mockRejectedValueOnce(new Error('地址变更请重新填写密钥'));
    await action(row(wrapper), 'test').trigger('click'); await flushPromises();
    expect(api.testAiChannel).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('地址变更请重新填写密钥');
    await row(wrapper).find('[data-field="apiKey"]').setValue('new-test-key');
    await action(row(wrapper), 'test').trigger('click'); await flushPromises();
    expect(api.saveAiChannel.mock.calls[1][1].baseUrl).toBe('http://changed.test/v1');
    expect(api.testAiChannel).toHaveBeenCalledWith('primary'); expect(wrapper.text()).toContain('18 ms');
  });

  it('查看密钥与修改密钥分离，查看不弄脏配置，地址变更仍需输入', async () => {
    api.revealAiChannelKey.mockResolvedValue({ apiKey: 'private-test-key' });
    const wrapper = render([channel('primary')]);
    await action(row(wrapper), 'reveal').trigger('click'); await flushPromises();
    expect(row(wrapper).find('[aria-label="已保存的 API Key"]').element.value).toBe('private-test-key');
    expect(wrapper.vm.channels[0].apiKey).toBe(''); expect(wrapper.vm.channels[0].dirty).toBe(false);
    await row(wrapper).find('[data-field="baseUrl"]').setValue('http://changed.test/v1');
    expect(row(wrapper).find('[aria-label="已保存的 API Key"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('重新填写对应密钥'); expect(wrapper.vm.channels[0].apiKey).toBe('');
  });

  it('密钥超时隐藏；离开缓存页面后迟到的查看响应不能重新展示', async () => {
    vi.useFakeTimers();
    api.revealAiChannelKey.mockResolvedValueOnce({ apiKey: 'secret' });
    const wrapper = render([channel('primary')]);
    await action(row(wrapper), 'reveal').trigger('click'); await flushPromises();
    await vi.advanceTimersByTimeAsync(60001);
    expect(row(wrapper).find('[aria-label="已保存的 API Key"]').exists()).toBe(false);
    let resolve;
    api.revealAiChannelKey.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await action(row(wrapper), 'reveal').trigger('click');
    wrapper.vm.shown = false; await flushPromises();
    resolve({ apiKey: 'late-secret' }); await flushPromises();
    wrapper.vm.shown = true; await flushPromises();
    expect(row(wrapper).find('[aria-label="已保存的 API Key"]').exists()).toBe(false);
  });

  it('撤销回到已保存值；过期版本保留草稿并可显式重新载入', async () => {
    const wrapper = render([channel('primary')]);
    await row(wrapper).find('[data-field="name"]').setValue('草稿');
    await action(row(wrapper), 'revert').trigger('click');
    expect(wrapper.vm.channels[0].name).toBe('primary');
    await row(wrapper).find('[data-field="name"]').setValue('再次草稿');
    api.saveAiChannel.mockRejectedValueOnce(Object.assign(new Error('其他页面已变更'), { status: 409 }));
    await action(row(wrapper), 'save').trigger('click'); await flushPromises();
    expect(wrapper.vm.channels[0].name).toBe('再次草稿');
    api.getAiConfig.mockResolvedValue({ channels: [{ ...channel('primary'), name: '服务器新值' }] });
    await row(wrapper).findAll('button').find(button => button.text() === '重新载入此渠道').trigger('click'); await flushPromises();
    expect(wrapper.vm.channels[0].name).toBe('服务器新值'); expect(wrapper.vm.channels[0].dirty).toBe(false);
  });

  it('排序仅保存顺序，失败不改变列表，其他字段草稿仍在', async () => {
    const wrapper = render();
    await row(wrapper).find('[data-field="name"]').setValue('待保存');
    api.reorderAiChannels.mockRejectedValueOnce(new Error('排序保存失败'));
    await row(wrapper, 'backup').find('[aria-label="提高优先级"]').trigger('click'); await flushPromises();
    expect(wrapper.vm.channels[0].id).toBe('primary');
    await row(wrapper, 'backup').find('[aria-label="提高优先级"]').trigger('click'); await flushPromises();
    expect(api.reorderAiChannels).toHaveBeenLastCalledWith(['backup', 'primary'], ['primary', 'backup']);
    expect(wrapper.vm.channels[1].name).toBe('待保存'); expect(wrapper.vm.channels[1].dirty).toBe(true);
  });

  it('新渠道按服务端实际保存顺序归位，未保存草稿保留', async () => {
    const wrapper = render();
    await action(wrapper, 'add').trigger('click'); await action(wrapper, 'add').trigger('click');
    const first = wrapper.vm.channels[2].id, second = wrapper.vm.channels[3].id;
    api.saveAiChannel.mockResolvedValue({ channel: { ...channel(second), name: '先保存第二条' }, order: ['primary', 'backup', second] });
    await action(row(wrapper, second), 'save').trigger('click'); await flushPromises();
    expect(wrapper.vm.channels.map(item => item.id)).toEqual(['primary', 'backup', second, first]);
    expect(wrapper.vm.channels[3].saved).toBe(false);
  });

  it('删除先确认，再删除指定保存版本；取消不触发 API', async () => {
    const wrapper = render();
    await row(wrapper).find('[aria-label="删除渠道"]').trigger('click');
    expect(api.deleteAiChannel).not.toHaveBeenCalled();
    wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('cancel'); await flushPromises();
    expect(wrapper.vm.channels).toHaveLength(2);
    await row(wrapper).find('[aria-label="删除渠道"]').trigger('click');
    wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('confirm'); await flushPromises();
    expect(api.deleteAiChannel).toHaveBeenCalledWith('primary', 'rev-primary'); expect(wrapper.vm.channels).toHaveLength(1);
  });

  it('模型列表和测试结果独立，逐项呈现不把部分成功显示为全部通过', async () => {
    api.fetchAiModels.mockResolvedValue({ models: ['m1', 'm2'] });
    api.testAiChannel.mockResolvedValue({ ok: false, latencyMs: 18, mode: 'stream', checks: [
      { id: 'arguments', label: '带参数工具调用', status: 'passed', message: '通过' },
      { id: 'empty', label: '空参数工具调用', status: 'failed', message: '工具参数截断' },
      { id: 'roundtrip', label: '工具结果回传', status: 'skipped', message: '尚未验证' },
    ], suggestion: '请尝试兼容模式' });
    const wrapper = render([channel('primary')]);
    await action(row(wrapper), 'test').trigger('click'); await flushPromises();
    await row(wrapper).find('[aria-label="获取此渠道的模型"]').trigger('click'); await flushPromises();
    expect(api.fetchAiModels).toHaveBeenCalledWith({ channelId: 'primary', baseUrl: 'http://primary.test/v1', apiKey: undefined });
    expect(wrapper.findAll('[role="option"]')).toHaveLength(2);
    expect(wrapper.text()).toContain('测试未全部通过'); expect(wrapper.text()).toContain('工具参数截断'); expect(wrapper.text()).toContain('尚未验证');
  });

  it('并发保存的旧列表响应不会移除刚保存的新渠道', async () => {
    const wrapper = render([channel('primary'), { ...channel('new'), saved: false, dirty: true, revision: null }]);
    await row(wrapper).find('[data-field="name"]').setValue('主渠道草稿');
    const pending = {};
    api.saveAiChannel.mockImplementation((id) => new Promise(resolve => { pending[id] = resolve; }));
    await action(row(wrapper), 'save').trigger('click');
    await action(row(wrapper, 'new'), 'save').trigger('click');
    pending.new({ channel: channel('new'), order: ['primary', 'new'] }); await flushPromises();
    pending.primary({ channel: { ...channel('primary'), name: '主渠道草稿' }, order: ['primary'] }); await flushPromises();
    expect(wrapper.vm.channels.map(item => item.id)).toEqual(['primary', 'new']);
    expect(wrapper.vm.channels.every(item => item.saved && !item.dirty)).toBe(true);
  });

});
