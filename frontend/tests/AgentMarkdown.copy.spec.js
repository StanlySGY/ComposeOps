import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AgentMarkdown from '../src/components/common/AgentMarkdown.vue';
import { copyText } from '../src/lib/clipboard.js';
let wrapper;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function clipboard(writeText) { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: writeText ? { writeText } : undefined }); }
async function start() { wrapper = mount(AgentMarkdown, { props: { content: '```sh\nprintf "你好"\n```' } }); await vi.advanceTimersByTimeAsync(1); }
describe('代码块与共享复制', () => {
  it('代码块按钮可被读屏识别且只复制代码正文', async () => {
    const write = vi.fn().mockResolvedValue(); clipboard(write); await start();
    await wrapper.get('button[aria-label="复制代码"]').trigger('click'); await flushPromises();
    expect(write).toHaveBeenCalledWith('printf "你好"\n'); expect(wrapper.get('[role="status"]').text()).toContain('已复制代码');
  });
  it('HTTP复制回退恢复原输入焦点、选区，不遗留textarea', async () => {
    clipboard(); const input = document.createElement('input'); document.body.appendChild(input); input.value = '保留草稿'; input.focus(); input.setSelectionRange(1, 3);
    const copy = vi.fn(() => true); document.execCommand = copy;
    await copyText('要复制的文本'); expect(copy).toHaveBeenCalledWith('copy'); expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(1); expect(input.selectionEnd).toBe(3); expect(document.querySelector('textarea')).toBe(null);
  });
  it('clipboard权限拒绝后也能尝试本地复制路径', async () => {
    clipboard(vi.fn().mockRejectedValue(new Error('denied'))); const copy = vi.fn(() => true); document.execCommand = copy;
    await copyText('literal'); expect(copy).toHaveBeenCalledOnce();
  });
  it('两条复制路径都失败时有可访问的错误反馈', async () => {
    clipboard(vi.fn().mockRejectedValue(new Error('denied'))); document.execCommand = vi.fn(() => false); await start();
    await wrapper.get('.code-copy-btn').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain('复制失败');
  });
  it('复制未完成时内容刷新，迟到回调不改变新代码按钮', async () => {
    let resolve; clipboard(() => new Promise(done => { resolve = done; })); await start(); await wrapper.get('.code-copy-btn').trigger('click');
    await wrapper.setProps({ content: '```sh\necho 新代码\n```' }); await vi.advanceTimersByTimeAsync(1); resolve(); await flushPromises();
    expect(wrapper.get('button').attributes('aria-label')).toBe('复制代码'); expect(wrapper.get('[role="status"]').text()).toBe('');
  });
});
