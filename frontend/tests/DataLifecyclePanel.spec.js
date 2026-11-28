import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ getDataLifecycle:vi.fn(),saveDataLifecycle:vi.fn(),archiveRunEvents:vi.fn() }));
vi.mock('../src/api/client.js',()=>({api}));
import Panel from '../src/components/settings/DataLifecyclePanel.vue';
let wrapper;
const fixture=()=>({databaseBytes:2048,walBytes:100,reusableBytes:1024,freeBytes:1000000,warnings:[],note:'保护未完成任务',archiveConfigured:true,archiveEnabled:true,archiveStorage:{ready:true,files:3,bytes:3000,freeBytes:4000,sampledAt:Date.now(),partial:true,limit:1000}});
beforeEach(()=>{vi.resetAllMocks();api.getDataLifecycle.mockResolvedValue(fixture());});
afterEach(()=>wrapper?.unmount());
it('labels incomplete inventory honestly and reports an empty archive batch',async()=>{
 wrapper=mount(Panel);await flushPromises();expect(wrapper.text()).toContain('已扫描文件（部分）');expect(wrapper.text()).toContain('不是目录总量');
 api.archiveRunEvents.mockResolvedValue({...fixture(),result:{archived:0}});
 await wrapper.findAll('button').find(b=>b.text()==='归档一批已过期事件').trigger('click');await flushPromises();
 expect(wrapper.text()).toContain('没有符合条件的事件');
});
it('unready storage disables writes but still allows pausing enabled archiving',async()=>{
 api.getDataLifecycle.mockResolvedValue({...fixture(),archiveStorage:{ready:false,error:'外置密钥不可读取'}});
 wrapper=mount(Panel);await flushPromises();expect(wrapper.text()).toContain('外置密钥不可读取');
 expect(wrapper.findAll('button').find(b=>b.text()==='归档一批已过期事件').attributes('disabled')).toBeDefined();
 api.saveDataLifecycle.mockResolvedValue({...fixture(),archiveEnabled:false});
 await wrapper.findAll('button').find(b=>b.text()==='暂停自动归档').trigger('click');await flushPromises();expect(api.saveDataLifecycle).toHaveBeenCalledWith(false);
});
it('initial read failure retains an accessible retry',async()=>{
 api.getDataLifecycle.mockRejectedValueOnce(Error('读取失败'));
 wrapper=mount(Panel);await flushPromises();expect(wrapper.get('[role=alert]').text()).toContain('读取失败');
 await wrapper.findAll('button').find(b=>b.text()==='刷新容量').trigger('click');await flushPromises();expect(wrapper.text()).toContain('数据库文件');expect(wrapper.find('[role=alert]').exists()).toBe(false);
});
