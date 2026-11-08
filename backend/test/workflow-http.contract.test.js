import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const directory = mkdtempSync(join(tmpdir(), 'composeops-workflow-http-'));
process.env.DB_PATH = join(directory, 'test.db');
const { default: Fastify } = await import('fastify');
const { default: workflowRoutes } = await import('../src/routes/workflow.js');
const app = Fastify(); await app.register(workflowRoutes, { prefix: '/workflows' });
test.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
async function createAndRun(name) {
 const created=await app.inject({method:'POST',url:'/workflows/definitions',payload:{name,nodes:[{id:'start',type:'trigger',config:{}},{id:'check',type:'approval',config:{}}]}});
 assert.equal(created.statusCode,201,created.body);const def=created.json().definition;
 const run=await app.inject({method:'POST',url:`/workflows/definitions/${def.id}/run`,payload:{context:{}}});
 assert.equal(run.statusCode,200,run.body);const id=run.json().instance.id;
 for(let index=0;index<20;index++){
  const detail=await app.inject(`/workflows/instances/${id}`);
  if(detail.json().instance.status==='waiting_approval')return {def,instance:detail.json().instance};
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('workflow did not reach approval');
}
test('HTTP: active definitions cannot be deleted, rejection preserves final state, final deletion includes history',async()=>{
 const {def,instance}=await createAndRun('安全删除契约');
 assert.ok(instance.context.pendingApprovalIntent);assert.equal(instance.steps.length,2);
 const refused=await app.inject({method:'DELETE',url:`/workflows/definitions/${def.id}`});
 assert.equal(refused.statusCode,409,refused.body);assert.match(refused.json().message,/运行|审批|未结束/);
 assert.equal((await app.inject(`/workflows/instances/${instance.id}`)).statusCode,200);
 const rejected=await app.inject({method:'POST',url:`/workflows/instances/${instance.id}/approve`,payload:{approved:false}});
 assert.equal(rejected.statusCode,200,rejected.body);assert.equal(rejected.json().instance.status,'cancelled');
 const removed=await app.inject({method:'DELETE',url:`/workflows/definitions/${def.id}`});assert.equal(removed.statusCode,200,removed.body);
 assert.equal((await app.inject(`/workflows/instances/${instance.id}`)).statusCode,404,'definition deletion cascades to instance history');
});
test('HTTP: harmless approval resumes execution; duplicate approval and cancelling finished work reject',async()=>{
 const {instance}=await createAndRun('只读审批契约');
 const approved=await app.inject({method:'POST',url:`/workflows/instances/${instance.id}/approve`,payload:{approved:true}});
 assert.equal(approved.statusCode,200,approved.body);assert.equal(approved.json().instance.status,'running','accepted approval does not mean execution is complete');
 let status='';
 for(let index=0;index<20;index++){
  status=(await app.inject(`/workflows/instances/${instance.id}`)).json().instance.status;
  if(status==='success')break;await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(status,'success');
 const duplicate=await app.inject({method:'POST',url:`/workflows/instances/${instance.id}/approve`,payload:{approved:true}});assert.equal(duplicate.statusCode,400);
 const cancelled=await app.inject({method:'POST',url:`/workflows/instances/${instance.id}/cancel`});assert.equal(cancelled.statusCode,409);
});
test('HTTP: deletion checks active runs outside the latest 100 records and includes pending and running',async()=>{
 const {default:db,createWorkflowInstance,updateWorkflowInstance}=await import('../src/lib/db.js');
 const created=await app.inject({method:'POST',url:'/workflows/definitions',payload:{name:'历史范围保护',nodes:[{id:'start',type:'trigger',config:{}}]}});
 assert.equal(created.statusCode,201,created.body);const definitionId=created.json().definition.id;
 const old=createWorkflowInstance({definitionId,status:'pending',name:'旧的活动实例'});
 db.prepare("UPDATE workflow_instances SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(old.id);
 for(let index=0;index<101;index++)createWorkflowInstance({definitionId,status:'success',name:`已结束 ${index}`});
 const recent=await app.inject('/workflows/instances?limit=100');assert.equal(recent.statusCode,200);
 assert.ok(!recent.json().instances.some(item=>item.id===old.id),'active fixture must lie outside the visible page');
 for(const status of ['pending','running','waiting_approval']){
  updateWorkflowInstance(old.id,{status});
  const refused=await app.inject({method:'DELETE',url:`/workflows/definitions/${definitionId}`});
  assert.equal(refused.statusCode,409,`${status}: ${refused.body}`);
 }
 updateWorkflowInstance(old.id,{status:'cancelled'});
 assert.equal((await app.inject({method:'DELETE',url:`/workflows/definitions/${definitionId}`})).statusCode,200);
});
