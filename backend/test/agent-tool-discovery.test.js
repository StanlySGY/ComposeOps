import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDiscovery } from '../src/services/agent/tool-discovery.js';
import { OperationsAgent } from '../src/services/agent/engine.js';
import { createAiSession, setSetting } from '../src/lib/db.js';
import { getDockerForHost } from '../src/services/docker-hosts.js';
import { createAgentPolicyGroup, createAgentPolicyRule, deleteAgentPolicyGroup } from '../src/services/agent/policy-store.js';
const tool = (name, description = name) => ({ name, description, readOnly: true, requiredPermission: 'readonly', confirmationRequired: false, parameters: { type: 'object', properties: {} } });
test('discovery retrieves Chinese descriptions and exact names without leaking filtered catalogue', () => {
 const catalogue = [tool('compose.ps', '查看服务'), tool('performance.baseline', '记录服务性能基线'), tool('cron.create', '创建定时任务')];
 const discovery = createToolDiscovery(catalogue, [catalogue[0]]);
 assert.equal(discovery.tool.execute({ query: '性能基线' }).matches[0].name, 'performance.baseline');
 assert.equal(discovery.tool.execute({ query: 'cron.create', limit: 1 }).matches[0].name, 'cron.create');
 assert.deepEqual(discovery.tool.execute({ query: 'inaccessible.secret' }).matches, []);
 assert.equal(discovery.schemas().filter(t=>t.function.name==='cron.create').length, 1);
 const restricted = createToolDiscovery([catalogue[0]], catalogue);
 assert.deepEqual(restricted.tool.execute({ query: '定时任务' }).matches, []);
 assert.ok(!JSON.stringify(restricted.schemas()).includes('cron.create'));
});
test('discovery bounds loaded schemas and keeps state local', () => {
 const a = tool('test.approval'), b = tool('test.noop');
 const first = createToolDiscovery([a,b], [], { maxLoaded: 1 });
 first.tool.execute({ query:'test.approval' });
 assert.equal(first.tool.execute({ query:'test.noop' }).limitReached, true);
 assert.equal(createToolDiscovery([a,b], []).schemas().length, 1);
 const bounded = createToolDiscovery([tool('large', 'x'.repeat(1000))], [], { maxSchemaBytes: 200 });
 assert.equal(bounded.tool.execute({ query:'large' }).matches[0].loaded, false);
});
test('one shared engine isolates interleaved discovery and still gates discovered writes', { timeout: 20000 }, async t => {
 const agent = new OperationsAgent(); agent.tools.clear();
 agent.listTools = () => [...agent.tools.values()];
 let mutations=0, approvals=0;
 for (const name of ['test.approval','test.noop']) agent.registerTool(name, { ...tool(name), confirmationRequired: true, readOnly: false, execute: async()=>{ mutations++;return {verified:true};} });
 agent.registerTool('compose.ps', { ...tool('compose.ps'), execute: async()=>({containers:[]}) });
 const docker = getDockerForHost('local'); t.mock.method(docker,'listContainers',async()=>[]);
 setSetting('ai.api_key','test-key');setSetting('ai.base_url','http://discovery.test/v1');
 const calls = new Map(); let both; const barrier=new Promise(resolve=>{both=resolve;}); let entered=0;
 t.mock.method(globalThis,'fetch',async (url,init)=>{
  assert.ok(String(url).startsWith('http://discovery.test/'));const body=JSON.parse(init.body);
  const goal=body.messages.findLast(m=>m.role==='user').content, own=goal.includes('GOAL_A')?'test.approval':'test.noop', other=own==='test.approval'?'test.noop':'test.approval';
  const round=(calls.get(own)||0)+1;calls.set(own,round);
  assert.ok(!body.tools.some(t=>t.function.name===other),'other execution cannot add schemas');
  if(round===1){assert.ok(!body.tools.some(t=>t.function.name===own));if(++entered===2)both();await barrier;}
  else assert.ok(body.tools.some(t=>t.function.name===own),'discovered tool appears next request');
  const delta=round===1?{tool_calls:[{index:0,id:'search',function:{name:'tool.search',arguments:JSON.stringify({query:own,limit:1})}}]}:round===2?{tool_calls:[{index:0,id:'write',function:{name:own,arguments:'{}'}}]}:{content:'完成'};
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:round===3?'stop':'tool_calls'}],usage:{total_tokens:100}})+'\n\ndata: [DONE]\n\n');
 });
 const run=label=>agent.executeWithLoop(label,{sessionId:createAiSession(),role:'executor',webSearchEnabled:false},event=>{
  if(event.type==='confirmation_required'){approvals++;assert.ok(event.tool.startsWith('test.'));setImmediate(()=>agent.approveToolCall(event.executionId,event.toolCallId,true));}
 });
 const result=await Promise.all([run('GOAL_A'),run('GOAL_B')]);
 assert.ok(result.every(r=>r.success));assert.equal(mutations,2);assert.equal(approvals,2);
 assert.equal(agent.getTool('tool.search'),null,'search capability is not exported through global registry');
});
test('persistent deny of tool.search prevents schema loading', { timeout:10000 }, async t=>{
 const agent=new OperationsAgent();agent.tools.clear();agent.listTools=()=>[...agent.tools.values()];
 agent.registerTool('test.noop',{...tool('test.noop'),execute:async()=>{throw Error('must not run');}});
 const docker=getDockerForHost('local');t.mock.method(docker,'listContainers',async()=>[]);
 const group=createAgentPolicyGroup({name:'deny discovery',enabled:true});
 createAgentPolicyRule({groupId:group.id,name:'deny search',effect:'deny',toolName:'tool.search'});
 t.after(()=>deleteAgentPolicyGroup(group.id));
 let calls=0;
 t.mock.method(globalThis,'fetch',async(_url,init)=>{
  const body=JSON.parse(init.body);assert.ok(!body.tools.some(t=>t.function.name==='test.noop'));
  const delta=calls++?{content:'策略拒绝'}:{tool_calls:[{index:0,id:'search',function:{name:'tool.search',arguments:'{"query":"test.noop"}'}}]};
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:calls===1?'tool_calls':'stop'}],usage:{total_tokens:100}})+'\n\ndata: [DONE]\n\n');
 });
 const events=[];await agent.executeWithLoop('GOAL_DENIED',{sessionId:createAiSession(),role:'executor',webSearchEnabled:false},e=>events.push(e));
 assert.ok(events.some(e=>e.type==='tool_rejected'&&e.reason==='persistent_policy_denied'));
});
test('discovery respects disabled network and validator role catalogues', { timeout:10000 }, async t=>{
 const agent=new OperationsAgent();agent.tools.clear();agent.listTools=()=>[...agent.tools.values()];
 for(const name of ['compose.ps','test.noop','web.search','web.open','web.interact'])
  agent.registerTool(name,{...tool(name),execute:async()=>({})});
 const docker=getDockerForHost('local');t.mock.method(docker,'listContainers',async()=>[]);
 let round=0;
 t.mock.method(globalThis,'fetch',async(_url,init)=>{
  const body=JSON.parse(init.body), names=body.tools.map(t=>t.function.name);
  assert.ok(!names.some(name=>name.startsWith('web.')));
  const delta=round++===0?{tool_calls:[{index:0,id:'search',function:{name:'tool.search',arguments:'{"query":"web"}'}}]}:{content:'无可用网络工具'};
  if(round===2)assert.deepEqual(JSON.parse(body.messages.findLast(m=>m.role==='tool').content).result.matches,[]);
  return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:round===1?'tool_calls':'stop'}],usage:{total_tokens:100}})+'\n\ndata: [DONE]\n\n');
 });
 assert.equal((await agent.executeWithLoop('GOAL_OFFLINE',{sessionId:createAiSession(),role:'executor',webSearchEnabled:false},()=>{})).success,true);
 // The validator already receives its entire authorized catalogue; discovery must not widen it.
 t.mock.method(globalThis,'fetch',async(_url,init)=>{
  assert.deepEqual(JSON.parse(init.body).tools.map(t=>t.function.name).sort(),['compose.ps','web.open','web.search']);
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:'只读检查完成'},finish_reason:'stop'}],usage:{total_tokens:100}})+'\n\ndata: [DONE]\n\n');
 });
 assert.equal((await agent.executeWithLoop('GOAL_READONLY',{sessionId:createAiSession(),role:'validator',webSearchEnabled:true},()=>{})).success,true);
});
