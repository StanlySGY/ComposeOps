import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
const { api, toast } = vi.hoisted(() => ({ api:Object.fromEntries(['getProjects','getWorkflowDefinitions','getWorkflowInstances','getWorkflowInstance','createWorkflowDefinition','updateWorkflowDefinition','deleteWorkflowDefinition','runWorkflow','approveWorkflowInstance','cancelWorkflowInstance'].map(name=>[name,vi.fn()])),toast:{success:vi.fn(),error:vi.fn()} }));
vi.mock('../src/api/client.js',()=>({api}));
vi.mock('../src/stores/toast.js',()=>({useToastStore:()=>toast}));
vi.mock('../src/composables/usePullRefresh.js',()=>({usePullRefresh:vi.fn()}));
import WorkflowCenterView from '../src/views/WorkflowCenterView.vue';
const def={id:'wf',name:'缓存维护',enabled:true,nodes:[{id:'trigger',type:'trigger',config:{}},{id:'approval',type:'approval',config:{}}]};
const inst={id:'run',name:'缓存维护',status:'waiting_approval',currentNode:'approval',createdAt:'2026-11-09T00:00:00Z',context:{pendingApprovalIntent:{actionIntent:{action:'restart',projectId:'cache'}}},steps:[]};
let wrapper;
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const state=()=>wrapper.vm.$.setupState;
function cachedHost(visible) { return defineComponent({setup:()=>()=>h(KeepAlive,null,{default:()=>visible.value?h(WorkflowCenterView):null})}); }
async function start(){wrapper=mount(WorkflowCenterView,{global:{stubs:{teleport:true,RouterLink:{template:'<a><slot/></a>'}}}});await flushPromises();return state();}
beforeEach(()=>{setActivePinia(createPinia());vi.clearAllMocks();for(const fn of Object.values(api))fn.mockReset();api.getProjects.mockResolvedValue({projects:[{id:'cache',projectName:'缓存',managed:true}]});api.getWorkflowDefinitions.mockResolvedValue({definitions:[def]});api.getWorkflowInstances.mockResolvedValue({instances:[inst]});});
afterEach(()=>{wrapper?.unmount();wrapper=null;vi.useRealTimers();});
it('定义读取很慢时实例独立出现，避免延迟待审批入口',async()=>{
 const slow=deferred();api.getWorkflowDefinitions.mockReturnValue(slow.promise);await start();expect(api.getWorkflowInstances).toHaveBeenCalled();expect(wrapper.text()).toContain('待审批');slow.resolve({definitions:[def]});await flushPromises();
});
it('定义失败有局部重试，不能展示没有工作流的空状态',async()=>{
 api.getWorkflowDefinitions.mockRejectedValueOnce(new Error('定义读取离线'));await start();expect(wrapper.text()).toContain('定义读取离线');expect(wrapper.text()).not.toContain('还没有工作流');expect(wrapper.text()).toContain('重试工作流');
});
it('删除等待保留确认和 busy，失败可重试且重复点击不会重复发送',async()=>{
 const pending=deferred();api.deleteWorkflowDefinition.mockReturnValue(pending.promise);const vm=await start();vm.deleteTarget=def;const first=vm.confirmRemove();await vm.confirmRemove();await flushPromises();
 expect(api.deleteWorkflowDefinition).toHaveBeenCalledTimes(1);expect(vm.deleteTarget).toBeTruthy();pending.reject(new Error('暂时无法删除'));await first;await flushPromises();expect(wrapper.get('[role=dialog]').text()).toContain('暂时无法删除');expect(vm.deleteTarget).toBeTruthy();
});
it('运行按定义防重复，运行失败有可见结果和重试入口',async()=>{
 const pending=deferred();api.runWorkflow.mockReturnValue(pending.promise);const vm=await start();const first=vm.run(def);await vm.run(def);expect(api.runWorkflow).toHaveBeenCalledTimes(1);pending.reject(new Error('运行未受理'));await first;await flushPromises();expect(wrapper.text()).toContain('运行未受理');
});
it('审批与取消同一实例互斥，审批完成只提示继续运行',async()=>{
 const pending=deferred();api.approveWorkflowInstance.mockReturnValue(pending.promise);const vm=await start();const first=vm.approve(inst,true);await vm.approve(inst,true);await vm.cancel(inst);
 expect(api.approveWorkflowInstance).toHaveBeenCalledTimes(1);expect(api.cancelWorkflowInstance).not.toHaveBeenCalled();pending.resolve({instance:{...inst,status:'running'}});await first;await flushPromises();expect(wrapper.text()).toContain('已通过审批');expect(wrapper.text()).not.toContain('执行成功');
});
it('审批失败保留原实例并显示行内原因，缺少快照仍不能通过',async()=>{
 const vm=await start();api.approveWorkflowInstance.mockRejectedValueOnce(new Error('审批意图已过期'));await vm.approve(inst,true);await flushPromises();expect(wrapper.text()).toContain('审批意图已过期');
 await vm.approve({...inst,context:{}},true);expect(api.approveWorkflowInstance).toHaveBeenCalledTimes(1);
});
it('节点切换关闭编辑并使迟到保存回调失效',async()=>{
 const pending=deferred();api.updateWorkflowDefinition.mockReturnValue(pending.promise);const vm=await start();vm.openEdit(def);const first=vm.save();
 window.dispatchEvent(new CustomEvent('composeops:host-changed'));await flushPromises();expect(vm.showEditor).toBe(false);pending.resolve({definition:def});await first;expect(toast.success).not.toHaveBeenCalled();
});
it('读取项目失败保留可解释错误与重试入口',async()=>{
 api.getProjects.mockRejectedValueOnce(new Error('项目离线'));const vm=await start();vm.openCreate();await flushPromises();expect(wrapper.get('[role=dialog]').text()).toContain('项目离线');expect(wrapper.get('[role=dialog]').text()).toContain('重试项目');
});

it('步骤详情按请求身份隔离，关闭后迟到结果不重新出现',async()=>{
 const a=deferred(),b=deferred();api.getWorkflowInstance.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);const vm=await start();
 const first=vm.openDetail({id:'old'}),second=vm.openDetail({id:'new'});b.resolve({instance:{...inst,id:'new',name:'新实例',steps:[]}});await second;
 a.resolve({instance:{...inst,id:'old',name:'旧实例',steps:[]}});await first;await flushPromises();expect(vm.detail.id).toBe('new');
 vm.closeDetail();await flushPromises();expect(wrapper.find('[role=dialog]').exists()).toBe(false);
});
it('详情读取失败能重试，不把失败当作没有步骤',async()=>{
 api.getWorkflowInstance.mockRejectedValueOnce(new Error('步骤读取断开'));const vm=await start();await vm.openDetail(inst);await flushPromises();expect(wrapper.get('[role=dialog]').text()).toContain('步骤读取断开');expect(wrapper.get('[role=dialog]').text()).toContain('重试详情');
 api.getWorkflowInstance.mockResolvedValueOnce({instance:{...inst,steps:[{id:1,nodeType:'approval',nodeId:'approval',status:'waiting_approval'}]}});await vm.openDetail(inst);await flushPromises();expect(wrapper.get('[role=dialog]').text()).toContain('审批');
});
it('缓存失活暂停轮询并使旧结果失效，激活后恢复',async()=>{
 vi.useFakeTimers();const visible=ref(true);
 const Host=cachedHost(visible);
 wrapper=mount(Host,{global:{stubs:{teleport:true}}});await flushPromises();
 const calls=api.getWorkflowInstances.mock.calls.length;await vi.advanceTimersByTimeAsync(5001);await flushPromises();expect(api.getWorkflowInstances.mock.calls.length).toBe(calls+1);
 visible.value=false;await flushPromises();const hiddenCalls=api.getWorkflowInstances.mock.calls.length;await vi.advanceTimersByTimeAsync(15000);expect(api.getWorkflowInstances.mock.calls.length).toBe(hiddenCalls);
 visible.value=true;await flushPromises();expect(api.getWorkflowInstances.mock.calls.length).toBe(hiddenCalls+1);await vi.advanceTimersByTimeAsync(5001);expect(api.getWorkflowInstances.mock.calls.length).toBe(hiddenCalls+2);
});
it('卸载后未完成保存不能发送完成通知',async()=>{
 const pending=deferred();api.updateWorkflowDefinition.mockReturnValue(pending.promise);const vm=await start();vm.openEdit(def);const first=vm.save();wrapper.unmount();wrapper=null;pending.resolve({definition:def});await first;expect(toast.success).not.toHaveBeenCalled();
});
it('待审批筛选中通过后仍能获知结果，筛选不会被静默重置',async()=>{
 const vm=await start();vm.instanceFilter='waiting_approval';
 const running={...inst,status:'running'};api.approveWorkflowInstance.mockResolvedValue({instance:running});api.getWorkflowInstances.mockResolvedValue({instances:[running]});
 await vm.approve(inst,true);await flushPromises();
 expect(vm.instanceFilter).toBe('waiting_approval');expect(wrapper.findAll('.workflow-instance')).toHaveLength(0);
 expect(wrapper.get('.workflow-success').text()).toContain('已通过审批');expect(wrapper.get('.workflow-success').text()).toContain('继续运行');
});
it('标签页隐藏时暂停轮询，重新可见后继续读取',async()=>{
 vi.useFakeTimers();const visibility=vi.spyOn(document,'visibilityState','get');
 try {
  visibility.mockReturnValue('visible');await start();const calls=api.getWorkflowInstances.mock.calls.length;
  visibility.mockReturnValue('hidden');document.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(15000);
  expect(api.getWorkflowInstances.mock.calls.length).toBe(calls);
  visibility.mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(5001);
  expect(api.getWorkflowInstances.mock.calls.length).toBe(calls+1);
 } finally { visibility.mockRestore(); }
});
it('离开缓存页时未完成的轮询不能回灌旧实例或重新启动定时器',async()=>{
 vi.useFakeTimers();const visible=ref(true),pending=deferred();
 const Host=cachedHost(visible);
 wrapper=mount(Host,{global:{stubs:{teleport:true}}});await flushPromises();
 api.getWorkflowInstances.mockReturnValueOnce(pending.promise);await vi.advanceTimersByTimeAsync(5001);
 visible.value=false;await flushPromises();const calls=api.getWorkflowInstances.mock.calls.length;
 pending.resolve({instances:[{...inst,name:'失活后的旧结果'}]});await flushPromises();await vi.advanceTimersByTimeAsync(15000);
 expect(api.getWorkflowInstances.mock.calls.length).toBe(calls);
 visible.value=true;await flushPromises();expect(wrapper.text()).not.toContain('失活后的旧结果');expect(wrapper.text()).toContain('缓存维护');
});
