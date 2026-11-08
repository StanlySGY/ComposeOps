import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
const { api, toast } = vi.hoisted(() => ({
 api: Object.fromEntries(['getProjects','getAiSessions','getAiMemories','getAgentRoles','getAiHistory','clearAiHistory','clearAiSessions','renameAgentSession','compactAgentSession','createAgentSession','agentExecuteStream','agentApprove','truncateAiHistory'].map(name=>[name,vi.fn()])),
 toast:{success:vi.fn(),error:vi.fn(),info:vi.fn()},
}));
vi.mock('../src/api/client.js',()=>({api}));
vi.mock('../src/stores/toast.js',()=>({useToastStore:()=>toast}));
import AgentWorkflowView from '../src/views/AgentWorkflowView.vue';
import { useAgentChat } from '../src/composables/useAgentChat.js';
const sessions=()=>[{sessionId:1,title:'备份验证',messageCount:2,createdAt:'2026-11-08 12:00:00'},{sessionId:2,title:'资源检查',messageCount:2,createdAt:'2026-11-08 13:00:00'}];
const history=id=>({messages:[{id:id*10,role:'user',content:`问题 ${id}`},{id:id*10+1,role:'assistant',content:`回复 ${id}`}],hasMore:true});
let wrapper,router;
const state=()=>wrapper.vm.$.setupState;
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function start(path='/agent'){
 router=createRouter({history:createMemoryHistory(),routes:[{path:'/agent',component:AgentWorkflowView},{path:'/services',component:{template:'<main />'}}]});await router.push(path);await router.isReady();
 wrapper=mount(AgentWorkflowView,{global:{plugins:[router],stubs:{teleport:true,SceneIllustration:true,LogContextPicker:true,AgentThinking:true}}});await flushPromises();return state();
}
beforeEach(()=>{
 for(const m of [...Object.values(api),...Object.values(toast)])m.mockReset();useAgentChat().resetSession();
 api.getProjects.mockResolvedValue({projects:[]});api.getAiSessions.mockImplementation(async()=>({sessions:sessions()}));api.getAiMemories.mockResolvedValue({memories:[]});api.getAgentRoles.mockResolvedValue({roles:[]});api.getAiHistory.mockImplementation(async id=>history(id));api.createAgentSession.mockResolvedValue({sessionId:3});api.agentExecuteStream.mockResolvedValue();
});
afterEach(()=>{wrapper?.unmount();wrapper=null;useAgentChat().resetSession();vi.restoreAllMocks();});
it('会话列表失败保留列表并提供原地重试',async()=>{
 const vm=await start();api.getAiSessions.mockRejectedValue(new Error('会话列表暂时离线'));await vm.loadSessions().catch(()=>{});await flushPromises();expect(wrapper.text()).toContain('会话列表暂时离线');expect(vm.sessions).toHaveLength(2);expect(wrapper.text()).toContain('重试');
});
it('较旧的会话历史不能覆盖后来选中的会话',async()=>{
 const vm=await start(),older=deferred();api.getAiHistory.mockReturnValueOnce(older.promise);const first=vm.openSession(2);await vm.openSession(3);older.resolve(history(2));await first;expect(vm.sessionId).toBe(3);expect(vm.messages[0].content).toBe('问题 3');
});
it('切换历史读取失败不能把旧消息显示在新会话下',async()=>{
 const vm=await start();api.getAiHistory.mockRejectedValueOnce(new Error('历史读取失败'));await vm.openSession(2);await flushPromises();expect(vm.messages).toHaveLength(0);expect(wrapper.text()).toContain('历史读取失败');expect(wrapper.text()).toContain('重试历史');
});
it('等待历史时新建会话，旧结果不再填入新会话',async()=>{
 const vm=await start(),pending=deferred();api.getAiHistory.mockReturnValueOnce(pending.promise);const first=vm.openSession(2);vm.newSession();pending.resolve(history(2));await first;expect(vm.sessionId).toBeNull();expect(vm.messages).toHaveLength(0);expect(vm.loadingHistory).toBe(false);
});
it('翻旧消息后切换会话，旧分页不能混入新会话',async()=>{
 const vm=await start(),pending=deferred();api.getAiHistory.mockReturnValueOnce(pending.promise);const first=vm.loadOlderHistory();await vm.openSession(2);pending.resolve({messages:[{id:1,role:'user',content:'旧会话分页'}],hasMore:false});await first;expect(vm.messages.map(m=>m.content)).toEqual(['问题 2','回复 2']);expect(vm.historyHasMore).toBe(true);
});
it('卸载后的历史回调不能改共享聊天状态',async()=>{
 const vm=await start(),pending=deferred();api.getAiHistory.mockReturnValueOnce(pending.promise);const first=vm.openSession(2);wrapper.unmount();wrapper=null;const chat=useAgentChat();chat.resetSession();chat.input.value='离页后的新草稿';pending.resolve(history(2));await first;expect(chat.messages.value).toHaveLength(0);expect(chat.input.value).toBe('离页后的新草稿');
});
it('会话读取中和失败时禁止发送到尚未恢复的上下文',async()=>{
 const vm=await start(),pending=deferred();api.getAiHistory.mockReturnValueOnce(pending.promise);const first=vm.openSession(2);vm.input='保持草稿';await vm.submit();expect(api.agentExecuteStream).not.toHaveBeenCalled();pending.reject(new Error('读取失败'));await first;await vm.submit();expect(api.agentExecuteStream).not.toHaveBeenCalled();expect(vm.input).toBe('保持草稿');
});
it('深链不在最近会话列表里时直接恢复指定ID',async()=>{
 const vm=await start('/agent?sessionId=999');expect(api.getAiHistory).toHaveBeenCalledWith(999,200);expect(vm.sessionId).toBe(999);
});
it('记忆加载缓慢不阻塞会话历史恢复',async()=>{
 const pending=deferred();api.getAiMemories.mockReturnValue(pending.promise);await start();expect(api.getAiHistory).toHaveBeenCalledWith(1,200);pending.resolve({memories:[]});await flushPromises();
});
it('删除失败保留具体目标和确认窗口，允许重试',async()=>{
 const vm=await start();vm.deleteSession(2);api.clearAiHistory.mockRejectedValue(new Error('删除失败，请重试'));await vm.confirmDeleteSession();await flushPromises();expect(vm.deleteDialog.show).toBe(true);expect(wrapper.get('[role=dialog]').text()).toContain('资源检查');expect(wrapper.get('[role=dialog]').text()).toContain('删除失败');
});
it('重复确认删除只发起一次请求',async()=>{
 const vm=await start(),pending=deferred();vm.deleteSession(2);api.clearAiHistory.mockReturnValue(pending.promise);const first=vm.confirmDeleteSession();await vm.confirmDeleteSession();expect(api.clearAiHistory).toHaveBeenCalledTimes(1);pending.resolve({success:true});await first;expect(vm.sessions.map(s=>s.sessionId)).toEqual([1]);
});
it('批量删除固定打开确认窗时的目标',async()=>{
 const vm=await start();vm.selectedSessions=[1];vm.deleteSelectedSessions();vm.selectedSessions=[2];api.clearAiSessions.mockResolvedValue({deleted:1});await vm.confirmDeleteSelected();expect(api.clearAiSessions).toHaveBeenCalledWith([1]);expect(vm.sessions.map(s=>s.sessionId)).toEqual([2]);
});
it('清空接口实际删除会话，成功后必须释放旧ID且保留确认反馈',async()=>{
 const vm=await start();vm.clearCurrentSession();api.clearAiHistory.mockResolvedValue({success:true});api.getAiSessions.mockRejectedValue(new Error('刷新离线'));await vm.confirmClearSession();expect(vm.sessionId).toBeNull();expect(vm.sessions.map(s=>s.sessionId)).not.toContain(1);expect(toast.error).not.toHaveBeenCalled();
});
it('重命名失败保留标题草稿，成功前不退出编辑',async()=>{
 const vm=await start(),row=vm.sessions[0];vm.beginRename(row);vm.editingTitle='恢复验证结果';api.renameAgentSession.mockRejectedValue(new Error('标题保存失败'));await vm.saveRename(row);expect(vm.editingSessionId).toBe(1);expect(vm.editingTitle).toBe('恢复验证结果');await flushPromises();expect(wrapper.text()).toContain('标题保存失败');
});
it('重命名Enter与失焦不能重复提交',async()=>{
 const vm=await start(),row=vm.sessions[0],pending=deferred();vm.beginRename(row);vm.editingTitle='新标题';api.renameAgentSession.mockReturnValue(pending.promise);const first=vm.saveRename(row);await vm.saveRename(row);expect(api.renameAgentSession).toHaveBeenCalledTimes(1);pending.resolve({success:true});await first;
});
it('切换会话保留各自未发送草稿',async()=>{
 const vm=await start();vm.input='备份问题的草稿';await vm.openSession(2);expect(vm.input).toBe('');vm.input='资源问题的草稿';await vm.openSession(1);expect(vm.input).toBe('备份问题的草稿');
});
it('历史分页失败有就地提示且重试仍在相同会话',async()=>{
 const vm=await start();api.getAiHistory.mockRejectedValueOnce(new Error('更早消息读取失败'));await vm.loadOlderHistory();await flushPromises();expect(wrapper.text()).toContain('更早消息读取失败');expect(vm.messages).toHaveLength(2);expect(vm.historyHasMore).toBe(true);
});
it('旧会话列表请求不能覆盖已确认的重命名',async()=>{
 const vm=await start(),pending=deferred();api.getAiSessions.mockReturnValueOnce(pending.promise);const read=vm.loadSessions();const row=vm.sessions[0];vm.beginRename(row);vm.editingTitle='确认保存的标题';api.renameAgentSession.mockResolvedValue({ok:true,title:vm.editingTitle});await vm.saveRename(row);pending.resolve({sessions:sessions()});await read;expect(vm.sessions[0].title).toBe('确认保存的标题');
});
it('初始列表很慢时用户显式新建，返回后不能自动打开旧会话',async()=>{
 const pending=deferred();api.getAiSessions.mockReturnValueOnce(pending.promise);const vm=await start();vm.newSession();pending.resolve({sessions:sessions()});await flushPromises();expect(vm.sessionId).toBeNull();expect(api.getAiHistory).not.toHaveBeenCalled();
});
it('卸载后重命名确认不能修改旧页面或触发反馈',async()=>{
 const vm=await start(),pending=deferred(),row=vm.sessions[0];vm.beginRename(row);vm.editingTitle='迟到标题';api.renameAgentSession.mockReturnValue(pending.promise);const request=vm.saveRename(row);wrapper.unmount();wrapper=null;pending.resolve({ok:true});await request;expect(row.title).toBe('备份验证');expect(vm.sessionFeedback).toBe('');
});
it('正在保存会话标题时不能删除、切换或新建会话',async()=>{
 const vm=await start(),pending=deferred(),row=vm.sessions[0];vm.beginRename(row);vm.editingTitle='新标题';api.renameAgentSession.mockReturnValue(pending.promise);const request=vm.saveRename(row);await vm.openSession(2);vm.newSession();vm.deleteSession(1);expect(vm.sessionId).toBe(1);expect(vm.deleteDialog.show).toBe(false);pending.resolve({ok:true});await request;
});
it('同页深链发生变化时恢复新指定会话',async()=>{
 const vm=await start();await router.push('/agent?sessionId=2');await flushPromises();expect(vm.sessionId).toBe(2);expect(vm.messages[0].content).toBe('问题 2');
});
it('翻页接口重叠消息按持久化ID去重',async()=>{
 const vm=await start();api.getAiHistory.mockResolvedValueOnce({messages:[{id:1,role:'user',content:'更早问题'},{id:10,role:'user',content:'问题 1'}],hasMore:false});await vm.loadOlderHistory();expect(vm.messages.map(m=>m.persistedId)).toEqual([1,10,11]);
});
it('压缩过程中离页后的迟到结果不显示成功通知',async()=>{
 const vm=await start(),pending=deferred();api.compactAgentSession.mockReturnValue(pending.promise);const first=vm.compactCurrentSession();wrapper.unmount();wrapper=null;pending.resolve({compactedMessages:10});await first;expect(toast.success).not.toHaveBeenCalled();
});
it('中文输入法确认候选时不触发发送，普通回车才发送',async()=>{
 const vm=await start();vm.input='正在选择候选字';const textarea=wrapper.get('textarea[aria-label="向 Agent 发送消息"]');await textarea.trigger('keydown',{key:'Enter',isComposing:true,keyCode:229});expect(api.agentExecuteStream).not.toHaveBeenCalled();await textarea.trigger('keydown',{key:'Enter'});await flushPromises();expect(api.agentExecuteStream).toHaveBeenCalledTimes(1);
});
it('历史恢复途中离页再返回时重新读取，不把中断加载当作空会话',async()=>{
 const vm=await start(),pending=deferred();api.getAiHistory.mockReturnValueOnce(pending.promise);const first=vm.openSession(2);wrapper.unmount();wrapper=null;
 const next=await start();expect(next.sessionId).toBe(2);expect(next.messages[0]?.content).toBe('问题 2');pending.resolve(history(2));await first;
});
it('历史中的审批模式真实恢复，不沿用上一会话的模式',async()=>{
 api.getAiHistory.mockImplementation(async id=>({...history(id),approvalMode:id===1?'full':'allow_writes'}));
 const vm=await start();expect(vm.approvalMode).toBe('full');await vm.openSession(2);expect(vm.approvalMode).toBe('allow_writes');
});
it('编辑重发截断失败保留编辑态、草稿和挂载上下文',async()=>{
 const vm=await start();vm.startEdit(vm.messages[0]);vm.input='修订后的排障目标';vm.attachedLogs='日志证据';vm.projectId='p1';
 api.truncateAiHistory.mockRejectedValueOnce(new Error('数据库忙'));await vm.submit();expect(vm.editingMessageId).toBeTruthy();expect(vm.input).toBe('修订后的排障目标');expect(api.agentExecuteStream).not.toHaveBeenCalled();
 api.truncateAiHistory.mockResolvedValueOnce({});await vm.submit();expect(vm.editingMessageId).toBeNull();expect(api.agentExecuteStream.mock.calls[0][0]).toMatchObject({message:'修订后的排障目标',attachedLogs:'日志证据',projectId:'p1'});
});
it('历史恢复中的工作台离页后，抽屉仍不能发送到尚未恢复的会话',async()=>{
 const vm=await start(),pending=deferred();api.getAiHistory.mockReturnValueOnce(pending.promise);const task=vm.openSession(2);wrapper.unmount();wrapper=null;
 const drawer=useAgentChat();expect(drawer.sendingBlocked.value).toBe(true);await expect(drawer.sendMessage('迟到消息')).rejects.toThrow('恢复');pending.resolve(history(2));await task;expect(api.agentExecuteStream).not.toHaveBeenCalled();
});
it('语音识别迟到回调在切换会话后不污染新草稿',async()=>{
 let engine;window.SpeechRecognition=class{constructor(){engine=this;}start(){}abort(){}};
 const vm=await start();vm.toggleVoiceInput();const stale=engine.onresult;await vm.openSession(2);vm.input='新会话草稿';stale({results:[[{transcript:'旧语音'}]]});expect(vm.input).toBe('新会话草稿');delete window.SpeechRecognition;
});
it('暂停的队列按会话保留，返回时不会自动发送',async()=>{
 const vm=await start();const chat=useAgentChat();chat.pendingQueue.value=[{id:77,text:'待核对恢复',extraPayload:{projectId:'p1'}}];chat.queuePaused.value=true;
 await vm.openSession(2);expect(chat.pendingQueue.value).toEqual([]);await vm.openSession(1);expect(chat.pendingQueue.value[0].text).toBe('待核对恢复');expect(chat.queuePaused.value).toBe(true);expect(api.agentExecuteStream).not.toHaveBeenCalled();
});
it('删除请求离页后成功，释放已删除的共享会话',async()=>{
 const vm=await start(),pending=deferred();api.clearAiHistory.mockReturnValueOnce(pending.promise);vm.deleteSession(1);const task=vm.confirmDeleteSession();wrapper.unmount();wrapper=null;
 const chat=useAgentChat();expect(chat.busy.value).toBe(true);pending.resolve({ok:true});await task;expect(chat.sessionId.value).toBeNull();expect(chat.busy.value).toBe(false);
});
it('HTTP环境无Clipboard API时提供复制回退并恢复焦点',async()=>{
 const vm=await start();const clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});const previous=document.execCommand;document.execCommand=vi.fn(()=>true);
 try{await vm.copyMessage(vm.messages[1]);expect(document.execCommand).toHaveBeenCalledWith('copy');expect(toast.success).toHaveBeenCalledWith('已复制到剪贴板');expect(document.querySelector('textarea[style*="-9999px"]')).toBeNull();}
 finally{document.execCommand=previous;if(clipboard)Object.defineProperty(navigator,'clipboard',clipboard);else delete navigator.clipboard;}
});
