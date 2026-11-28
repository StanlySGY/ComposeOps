import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, KeepAlive, ref } from 'vue';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => Object.fromEntries(['getMemberRuns','getMemberRun','createMemberRun','memberRunAction'].map(k => [k,vi.fn()])));
vi.mock('../src/api/client.js', () => ({ api }));
import Panel from '../src/components/agent/MemberAgentPanel.vue';
let wrapper;
const project = { id: 'p', hostId: 'h', hostName: 'node', projectName: 'project' };
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); api.getMemberRuns.mockResolvedValue({ runs: [] }); });
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); });
it('submits only selected scope and message and recovers saved approval', async () => {
 wrapper = mount(Panel, { props: { projects: [project] } }); await flushPromises();
 await wrapper.find('select').setValue('h:p'); await wrapper.find('textarea').setValue('检查日志'); await wrapper.find('form').trigger('submit'); await flushPromises();
 expect(api.createMemberRun).toHaveBeenCalledWith({ hostId: 'h', projectId: 'p', message: '检查日志' });
 api.getMemberRuns.mockResolvedValue({ runs: [{ id:'r', goal:'restart', status:'waiting_approval', approval:{ executionId:'plan-x', toolCallId:'call-x', params:{containerId:'c'} } }] });
 await vi.advanceTimersByTimeAsync(3000); await flushPromises();
 await wrapper.findAll('button').find(b=>b.text()==='批准此步骤').trigger('click'); await flushPromises();
 expect(api.memberRunAction).toHaveBeenCalledWith('r','approve',{executionId:'plan-x', toolCallId:'call-x', approved:true});
});
it('stops polling on deactivation and drops late responses', async () => {
 const visible=ref(true); wrapper=mount(defineComponent({ components:{Panel,KeepAlive},setup:()=>({visible}),template:'<KeepAlive><Panel v-if="visible" /></KeepAlive>' })); await flushPromises();
 visible.value=false;await flushPromises();expect(api.getMemberRuns.mock.calls[0][0].aborted).toBe(true);
 const count=api.getMemberRuns.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(api.getMemberRuns).toHaveBeenCalledTimes(count);
 visible.value=true;await flushPromises();expect(api.getMemberRuns).toHaveBeenCalledTimes(count+1);
});
