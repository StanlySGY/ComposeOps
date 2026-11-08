import { beforeEach, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getWorkflowDefinitions', 'getWorkflowInstances', 'createWorkflowDefinition', 'updateWorkflowDefinition', 'deleteWorkflowDefinition', 'runWorkflow', 'approveWorkflowInstance', 'cancelWorkflowInstance'].map(name => [name, vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
import { useWorkflowStore } from '../src/stores/workflow.js';
const def = { id: 'wf-a', name: '缓存维护', nodes: [], enabled: true };
const inst = { id: 'run-a', name: '缓存维护', definitionId: 'wf-a', status: 'waiting_approval', context: { pendingApprovalIntent: { actionIntent: { action: 'restart', projectId: 'cache' } } } };
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
beforeEach(() => { setActivePinia(createPinia()); for (const fn of Object.values(api)) fn.mockReset(); api.getWorkflowDefinitions.mockResolvedValue({definitions:[{...def}]});api.getWorkflowInstances.mockResolvedValue({instances:[{...inst}]}); });
it('定义与实例读取状态及错误彼此独立', async () => {
  const store=useWorkflowStore();api.getWorkflowDefinitions.mockRejectedValueOnce(new Error('定义离线'));
  await Promise.all([store.loadDefinitions(),store.loadInstances()]);
  expect(store.definitionsError).toBe('定义离线');expect(store.instancesError).toBe('');expect(store.instances).toHaveLength(1);
  api.getWorkflowInstances.mockRejectedValueOnce(new Error('实例离线'));await store.loadInstances();await store.loadDefinitions();
  expect(store.instancesError).toBe('实例离线');expect(store.definitionsError).toBe('');expect(store.instances).toHaveLength(1);
});
it('较旧的定义与实例读取不得覆盖新的结果', async()=>{
 const store=useWorkflowStore(),old=deferred();api.getWorkflowDefinitions.mockReturnValueOnce(old.promise);const first=store.loadDefinitions();
 api.getWorkflowDefinitions.mockResolvedValueOnce({definitions:[{...def,name:'最新'}]});await store.loadDefinitions();old.resolve({definitions:[def]});await first;
 expect(store.definitions[0].name).toBe('最新');
 const pending=deferred();api.getWorkflowInstances.mockReturnValueOnce(pending.promise);const read=store.loadInstances();
 api.getWorkflowInstances.mockResolvedValueOnce({instances:[{...inst,status:'success'}]});await store.loadInstances();pending.resolve({instances:[inst]});await read;expect(store.instances[0].status).toBe('success');
});
it('创建确认立即入列表，不等待随后的慢刷新',async()=>{
 const store=useWorkflowStore(),slow=deferred();api.createWorkflowDefinition.mockResolvedValue({definition:def});api.getWorkflowDefinitions.mockReturnValue(slow.promise);
 let finished=false;const op=store.create({name:def.name}).then(()=>{finished=true;});await flushPromises();
 expect(finished).toBe(true);expect(store.definitions).toEqual([def]);slow.resolve({definitions:[def]});await op;
});
it('更新与删除成功后即使刷新失败仍保留服务端确认状态',async()=>{
 const store=useWorkflowStore();store.definitions=[def];store.instances=[inst];api.getWorkflowInstances.mockRejectedValue(new Error('实例离线'));api.getWorkflowDefinitions.mockRejectedValue(new Error('列表离线'));
 api.updateWorkflowDefinition.mockResolvedValue({definition:{...def,name:'已更新'}});await store.update(def.id,{name:'已更新'});await flushPromises();expect(store.definitions[0].name).toBe('已更新');
 api.deleteWorkflowDefinition.mockResolvedValue({ok:true});await store.remove(def.id);await flushPromises();expect(store.definitions).toEqual([]);expect(store.instances).toEqual([]);
});
it('运行与审批应用实例响应，不将后续读取失败当成操作失败',async()=>{
 const store=useWorkflowStore();api.getWorkflowInstances.mockRejectedValue(new Error('实例列表离线'));api.runWorkflow.mockResolvedValue({instance:inst});await store.run(def.id);await flushPromises();expect(store.instances[0].status).toBe('waiting_approval');
 api.approveWorkflowInstance.mockResolvedValue({instance:{...inst,status:'running'}});await store.approve(inst.id,{approved:true});await flushPromises();expect(store.instances[0].status).toBe('running');
 api.cancelWorkflowInstance.mockResolvedValue({instance:{...inst,status:'cancelled'}});await store.cancel(inst.id);await flushPromises();expect(store.instances[0].status).toBe('cancelled');
});
it('失效上下文后的迟到写入不能回灌列表',async()=>{
 const store=useWorkflowStore(),pending=deferred();api.runWorkflow.mockReturnValue(pending.promise);const op=store.run(def.id);store.invalidateContext();
 pending.resolve({instance:inst});await op;expect(store.instances).toEqual([]);expect(api.getWorkflowInstances).not.toHaveBeenCalled();
});
