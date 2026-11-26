import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ProjectWebUiModal from '../src/components/services/ProjectWebUiModal.vue';
import { api } from '../src/api/client.js';
vi.mock('../src/api/client.js',()=>({api:{getProjectWebUiSettings:vi.fn(),saveProjectWebUiSettings:vi.fn()}}));
let wrapper;
const data={hostId:'local',revision:2,entries:[{service:'lucky',port:16601,path:'/web/'}],targets:[{serviceName:'nps',ports:[{port:8081,url:'http://nas:8081'}]},{serviceName:'lucky',ports:[{port:16601,url:'http://nas:16601'}]}]};
beforeEach(()=>{api.getProjectWebUiSettings.mockReset().mockResolvedValue(structuredClone(data));api.saveProjectWebUiSettings.mockReset().mockResolvedValue({ok:true});});
afterEach(()=>wrapper?.unmount());
async function render(){wrapper=mount(ProjectWebUiModal,{props:{project:{id:'network',projectName:'network'},initialService:'lucky'},global:{stubs:{BaseModal:{template:'<div><slot/><slot name="footer"/></div>'},ConfirmDialog:{props:['show'],template:'<div v-if="show" role="dialog"><button @click="$emit(\'confirm\')">放弃修改</button><button @click="$emit(\'cancel\')">继续编辑</button></div>'}}}});await flushPromises();}
it('优先显示所选应用，预览安全路径，恢复默认后仅清空目标端口',async()=>{
 await render();expect(wrapper.findAll('.entry-setting__name')[0].text()).toBe('lucky');expect(wrapper.text()).toContain('http://nas:16601/web/');
 await wrapper.findAll('button').find(b=>b.text()==='恢复默认').trigger('click');
 expect(wrapper.get('[aria-label="lucky 16601 访问路径"]').element.value).toBe('');
 await wrapper.findAll('button').find(b=>b.text()==='保存入口').trigger('click');await flushPromises();
 expect(api.saveProjectWebUiSettings).toHaveBeenCalledWith('network',{hostId:'local',revision:2,entries:[{service:'lucky',port:16601,path:''},{service:'nps',port:8081,path:''}]});
 expect(wrapper.emitted('saved')).toEqual([[]]);expect(wrapper.emitted('close')).toEqual([[]]);
});
it('未保存离开需确认，取消保留输入，保存冲突不关闭',async()=>{
 await render();await wrapper.get('[aria-label="lucky 16601 访问路径"]').setValue('/new/');
 await wrapper.findAll('button').find(b=>b.text()==='取消').trigger('click');expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
 await wrapper.findAll('button').find(b=>b.text()==='继续编辑').trigger('click');expect(wrapper.emitted('close')).toBeUndefined();
 api.saveProjectWebUiSettings.mockRejectedValueOnce(new Error('入口已被其他页面修改'));
 await wrapper.findAll('button').find(b=>b.text()==='保存入口').trigger('click');await flushPromises();
 expect(wrapper.get('[role="alert"]').text()).toContain('其他页面修改');expect(wrapper.emitted('close')).toBeUndefined();
 expect(wrapper.get('[aria-label="lucky 16601 访问路径"]').element.value).toBe('/new/');
});
it('读取失败可重试，切节点关闭，迟到读取不会重建界面',async()=>{
 api.getProjectWebUiSettings.mockRejectedValueOnce(new Error('暂时无法读取'));await render();expect(wrapper.get('[role="alert"]').text()).toContain('暂时无法读取');
 await wrapper.findAll('button').find(b=>b.text()==='重试').trigger('click');await flushPromises();expect(wrapper.text()).toContain('/web/');
 window.dispatchEvent(new CustomEvent('composeops:host-changed'));expect(wrapper.emitted('close')).toEqual([[]]);
});
