import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { usePagedRows } from '../src/composables/usePagedRows.js';
import { userError } from '../src/lib/user-error.js';
import { useToastStore } from '../src/stores/toast.js';
import ToastContainer from '../src/components/common/ToastContainer.vue';
import HistoryControls from '../src/components/common/HistoryControls.vue';

let wrapper;
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); });
describe('历史分页与排序', () => {
  it('123 条记录每页最多 20 条，末页受控，排序与筛选后回到第一页且不修改源数据', async () => {
    const source = ref(Array.from({ length: 123 }, (_, n) => ({ id: n + 1, name: `记录${n + 1}` })));
    const query = ref(''); let pager;
    wrapper = mount(defineComponent({ setup() {
      pager = usePagedRows(computed(() => source.value.filter(row => row.name.includes(query.value))), { id: row => row.id }, 'id');
      return () => h('div', [h(HistoryControls, {
        page: pager.page.value, pageSize: pager.pageSize.value, total: pager.total.value, sortKey: pager.sortKey.value, descending: pager.descending.value,
        options: [{ key: 'id', label: '序号' }], 'onUpdate:page': v => { pager.page.value = v; }, 'onUpdate:descending': v => { pager.descending.value = v; },
      }), h('ul', pager.rows.value.map(row => h('li', row.name)))]);
    } }));
    expect(wrapper.findAll('li')).toHaveLength(20);
    expect(wrapper.findAll('li')[0].text()).toBe('记录123');
    for (let n = 0; n < 6; n++) await wrapper.get('[aria-label="历史记录下一页"]').trigger('click');
    expect(wrapper.findAll('li')).toHaveLength(3);
    expect(wrapper.get('[aria-label="历史记录下一页"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[aria-label*="点击升序"]').trigger('click');
    expect(pager.page.value).toBe(1);
    expect(wrapper.findAll('li')[0].text()).toBe('记录1');
    await wrapper.get('[aria-label="历史记录下一页"]').trigger('click');
    query.value = '123'; await nextTick();
    expect(pager.page.value).toBe(1); expect(wrapper.findAll('li')).toHaveLength(1);
    expect(source.value[0].id).toBe(1); expect(source.value).toHaveLength(123);
  });
});
describe('中文错误与详情', () => {
  it('网络、400 和错误码提供中文下一步，原始信息仍可查', () => {
    expect(userError(new TypeError('Failed to fetch')).message).toContain('检查网络');
    const invalid = userError(new Error('Invalid payload'), { status: 400 });
    expect(invalid.message).toContain('检查表单'); expect(invalid.details).toContain('HTTP 400'); expect(invalid.details).toContain('Invalid payload');
    expect(userError('project_not_found').message).toContain('刷新项目列表');
    const abort = new DOMException('Aborted', 'AbortError'); expect(userError(abort)).toBe(abort);
  });
  it('展开错误详情后移开鼠标不会自动消失，显式关闭仍有效', async () => {
    vi.useFakeTimers(); const pinia = createPinia();
    wrapper = mount(ToastContainer, { attachTo: document.body, global: { plugins: [pinia] } });
    const store = useToastStore(pinia); store.error(userError('Invalid payload', { status: 400 }));
    await nextTick();
    const details = wrapper.get('details'); details.element.open = true; await details.trigger('toggle');
    await wrapper.get('[role="status"]').trigger('mouseleave');
    await vi.advanceTimersByTimeAsync(10000); await flushPromises();
    expect(wrapper.text()).toContain('检查表单'); expect(wrapper.text()).toContain('Invalid payload');
    await wrapper.get('[aria-label="关闭提示"]').trigger('click'); await vi.advanceTimersByTimeAsync(250);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });
});
