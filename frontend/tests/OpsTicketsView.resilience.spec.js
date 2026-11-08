import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
const { api } = vi.hoisted(() => ({ api: Object.fromEntries(['getOpsTickets','getOpsTicket','createOpsTicket','updateOpsTicket','issueOpsMandate','revokeOpsMandate','createOpsAssignment','updateOpsAssignment','reconcileOpsAssignment','createOpsReport','decideOpsReport','createOpsEffect','getOpsEffectWorkerStatus','approveOpsEffect','cancelOpsEffect','reconcileOpsEffect'].map(name => [name,vi.fn()])) }));
vi.mock('../src/api/client.js', () => ({ api }));
import OpsTicketsView from '../src/views/OpsTicketsView.vue';
const ticket = {id:'task-a',title:'备份验收',description:'核对恢复证据',status:'active',priority:'normal',acceptanceCriteria:['恢复结果可核对'],projectId:'cache',createdAt:'2026-11-09T00:00:00Z'};
const detail = () => ({ticket:{...ticket},mandates:[],assignments:[],reports:[],effects:[],activity:[]});
let wrapper,router;
function deferred() { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
const state = () => wrapper.vm.$.setupState;
async function start(path='/tickets') {
 router=createRouter({history:createMemoryHistory(),routes:[{path:'/tickets',component:OpsTicketsView},{path:'/ops-center',component:{template:'<main />'}}]});
 await router.push(path);await router.isReady();wrapper=mount(OpsTicketsView,{global:{plugins:[router],stubs:{teleport:true}}});await flushPromises();return state();
}
beforeEach(()=>{
 for(const mock of Object.values(api))mock.mockReset();
 api.getOpsTickets.mockResolvedValue({tickets:[ticket],stats:{open:1}});api.getOpsTicket.mockResolvedValue(detail());api.getOpsEffectWorkerStatus.mockResolvedValue({enabled:true,queueDepth:0});
});
afterEach(()=>{wrapper?.unmount();wrapper=null;vi.restoreAllMocks();});
it('执行器读取很慢不会阻止展示已选任务详情',async()=>{
 const pending=deferred();api.getOpsEffectWorkerStatus.mockReturnValue(pending.promise);await start();
 expect(api.getOpsTicket).toHaveBeenCalledWith('task-a');expect(wrapper.text()).toContain('恢复结果可核对');pending.resolve({enabled:true});await flushPromises();
});
it('列表失败显示局部重试，不显示没有任务或零统计',async()=>{
 api.getOpsTickets.mockRejectedValue(new Error('任务列表离线'));await start();
 expect(wrapper.text()).toContain('任务列表离线');expect(wrapper.text()).toContain('重试列表');expect(wrapper.text()).not.toContain('暂无长期任务');
});
it('深链任务不在最近200条列表中仍读取指定任务',async()=>{
 api.getOpsTicket.mockImplementation(async id=>({...detail(),ticket:{...ticket,id,title:id==='older'?'历史中的任务':ticket.title}}));
 await start('/tickets?ticket=older&tab=reports');expect(api.getOpsTicket).toHaveBeenCalledWith('older');expect(state().selectedTicketId).toBe('older');expect(wrapper.text()).toContain('历史中的任务');
});
it('创建确认立即显示新任务，刷新失败不丢失新详情',async()=>{
 const vm=await start();api.createOpsTicket.mockResolvedValue({ticket:{...ticket,id:'new-task',title:'新验收目标',status:'planning'}});api.getOpsTickets.mockRejectedValue(new Error('列表离线'));api.getOpsTicket.mockRejectedValue(new Error('详情离线'));
 vm.ticketForm.title='新验收目标';await vm.createTicket();await flushPromises();expect(vm.selectedTicketId).toBe('new-task');expect(vm.detail.ticket.title).toBe('新验收目标');expect(vm.notice).toContain('已创建');expect(vm.saving).toBe(false);
});
it('状态写入确认在后续刷新失败时仍立即可见',async()=>{
 const vm=await start();vm.ticketStatusDraft='review';api.updateOpsTicket.mockResolvedValue({ticket:{...ticket,status:'review'}});api.getOpsTickets.mockRejectedValue(new Error('列表离线'));api.getOpsTicket.mockRejectedValue(new Error('详情离线'));
 await vm.updateTicketStatus();await flushPromises();expect(vm.detail.ticket.status).toBe('review');expect(vm.notice).toContain('已更新');
});
it('保存完成不等待后台列表慢刷新，不能重复提交同一写入',async()=>{
 const vm=await start(),write=deferred(),read=deferred();vm.ticketStatusDraft='review';api.updateOpsTicket.mockReturnValue(write.promise);api.getOpsTickets.mockReturnValue(read.promise);
 let done=false;const first=vm.updateTicketStatus().then(()=>{done=true;});await vm.updateTicketStatus();expect(api.updateOpsTicket).toHaveBeenCalledTimes(1);
 write.resolve({ticket:{...ticket,status:'review'}});await flushPromises();expect(done).toBe(true);expect(vm.saving).toBe(false);read.resolve({tickets:[{...ticket,status:'review'}],stats:{review:1}});await first;
});
it('列表读取按请求身份返回，较旧筛选不能覆盖新结果',async()=>{
 const vm=await start(),old=deferred();api.getOpsTickets.mockReturnValueOnce(old.promise);const first=vm.load();
 api.getOpsTickets.mockResolvedValueOnce({tickets:[{...ticket,id:'newer',title:'最新搜索结果'}],stats:{open:1}});await vm.load();old.resolve({tickets:[ticket],stats:{open:1}});await first;await flushPromises();expect(vm.tickets[0].id).toBe('newer');
});
it('执行器读取失败有未知状态与重试，不能误报停止',async()=>{
 api.getOpsEffectWorkerStatus.mockRejectedValue(new Error('执行器离线'));const vm=await start();vm.activeTab='effects';await flushPromises();
 expect(wrapper.text()).toContain('执行器离线');expect(wrapper.text()).toContain('重试执行器');expect(wrapper.text()).not.toContain('已停止');
});
it('节点变更后迟到创建不能切换任务、清空草稿或通知成功',async()=>{
 const vm=await start(),pending=deferred();api.createOpsTicket.mockReturnValue(pending.promise);vm.ticketForm.title='待确认草稿';const first=vm.createTicket();
 window.dispatchEvent(new CustomEvent('composeops:host-changed'));await flushPromises();pending.resolve({ticket:{...ticket,id:'late'}});await first;await flushPromises();expect(vm.selectedTicketId).not.toBe('late');expect(vm.notice).toBe('');
});
it('卸载后的迟到创建不能继续触发读取或重置草稿',async()=>{
 const vm=await start(),pending=deferred();api.createOpsTicket.mockReturnValue(pending.promise);vm.ticketForm.title='保留草稿';const first=vm.createTicket();wrapper.unmount();wrapper=null;const calls=api.getOpsTickets.mock.calls.length;
 pending.resolve({ticket:{...ticket,id:'late'}});await first;expect(api.getOpsTickets.mock.calls.length).toBe(calls);expect(vm.ticketForm.title).toBe('保留草稿');expect(vm.notice).toBe('');
});
it('任务切换保存各自表单草稿，避免把A任务授权套到B',async()=>{
 const vm=await start();api.getOpsTicket.mockImplementation(async id=>({...detail(),ticket:{...ticket,id}}));vm.mandateForm.composeProjectNames='cache-a';vm.showMandateForm=true;
 await vm.selectTicket('task-b');expect(vm.mandateForm.composeProjectNames).toBe('');expect(vm.showMandateForm).toBe(false);
 await vm.selectTicket('task-a');expect(vm.mandateForm.composeProjectNames).toBe('cache-a');expect(vm.showMandateForm).toBe(true);
});
it('撤销授权在站内确认，失败保留原因，确认成功后无需等待刷新',async()=>{
 const vm=await start(),mandate={id:'mandate-a',version:2,status:'active',scope:{composeProjectNames:['cache']}};
 vm.detail.mandates=[mandate];vm.detail.effects=[{id:'effect-a',mandateId:mandate.id,status:'queued'}];
 vm.revokeMandate(mandate);await flushPromises();expect(wrapper.get('[role=dialog]').text()).toContain('授权 v2');expect(api.revokeOpsMandate).not.toHaveBeenCalled();
 vm.decisionNote='维护范围已结束';api.revokeOpsMandate.mockRejectedValueOnce(new Error('暂时无法撤销'));await vm.confirmDecision();await flushPromises();
 expect(wrapper.get('[role=dialog]').text()).toContain('暂时无法撤销');expect(vm.decisionNote).toBe('维护范围已结束');
 api.revokeOpsMandate.mockResolvedValueOnce({mandate:{...mandate,status:'revoked'}});api.getOpsTicket.mockRejectedValue(new Error('详情离线'));
 await vm.confirmDecision();await flushPromises();expect(wrapper.find('[role=dialog]').exists()).toBe(false);expect(vm.detail.mandates[0].status).toBe('revoked');expect(vm.detail.effects[0].status).toBe('rejected');
});
it('审批确认防重复并保持目标，失败时可原地继续',async()=>{
 const vm=await start(),pending=deferred(),effect={id:'effect-a',effectType:'service.inspect',target:{composeProject:'cache'},status:'awaiting_approval'};
 await vm.approveEffect(effect);vm.decisionNote='';api.approveOpsEffect.mockReturnValue(pending.promise);const first=vm.confirmDecision();await vm.confirmDecision();await flushPromises();
 expect(api.approveOpsEffect).toHaveBeenCalledTimes(1);expect(api.approveOpsEffect).toHaveBeenCalledWith('task-a','effect-a');expect(wrapper.get('[role=dialog]').text()).toContain('提交中');
 pending.reject(new Error('授权已过期'));await first;await flushPromises();expect(wrapper.get('[role=dialog]').text()).toContain('授权已过期');expect(vm.saving).toBe(false);
});
it('验收报告确认保留摘要和意见，操作成功后仅更新报告',async()=>{
 const vm=await start(),report={id:'report-a',reportType:'verification',summary:'已在隔离卷验证恢复',status:'submitted'};
 vm.detail.reports=[report];vm.decideReport(report,true);await flushPromises();expect(wrapper.get('[role=dialog]').text()).toContain(report.summary);
 api.decideOpsReport.mockResolvedValue({report:{...report,status:'accepted',decisionNote:'证据完整'}});api.getOpsTicket.mockRejectedValue(new Error('详情离线'));
 await vm.confirmDecision();await flushPromises();expect(vm.detail.reports[0].status).toBe('accepted');expect(vm.detail.ticket.status).toBe('active');expect(vm.notice).toContain('核对任务整体结果');
});
it('详情刷新失败保留原内容并可单独恢复',async()=>{
 const vm=await start();api.getOpsTicket.mockRejectedValueOnce(new Error('详情暂时离线'));await vm.refreshDetail();await flushPromises();
 expect(wrapper.text()).toContain('恢复结果可核对');expect(wrapper.text()).toContain('详情暂时离线');expect(wrapper.text()).toContain('重试详情');
 await vm.refreshDetail();await flushPromises();expect(wrapper.text()).not.toContain('详情暂时离线');
});

it('待执行动作统计排除已结束、建议、执行中和待核对记录',async()=>{
 const data=detail();data.effects=['proposed','awaiting_approval','queued','leased','executing','succeeded','failed','cancelled','rejected','outcome_unknown'].map((status,i)=>({id:`effect-${i}`,status}));
 api.getOpsTicket.mockResolvedValue(data);const vm=await start();expect(vm.pendingEffectsCount).toBe(3);
 const metric=wrapper.findAll('.card').find(card=>card.text().startsWith('待执行动作'));expect(metric.text()).toContain('3');
});
