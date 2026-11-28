import './helpers/isolated-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAiSession } from '../src/lib/db.js';
import { startAgentRun, resumeAgentRun } from '../src/services/agent/runs.js';
import { getRun, runDurableEffect, recoverAgentRuns } from '../src/services/agent/run-store.js';
import { requestWithAiChannels } from '../src/services/ai-channels.js';

test('combined outage: committed effect + actual HTTP 429 + restart reconciliation + offline node + recovery never repeats committed write', async () => {
 const server=http.createServer((_req,res)=>{res.writeHead(429);res.end('limited');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let writes=0, phase=0; const keeper=setTimeout(()=>{},10000);
 const agent={async executeWithLoop(_message,context){
  await runDurableEffect(context.durableRunId,'fixture.write',{resource:'isolated'},async()=>{writes++;return {ok:true};});
  if(phase===0) await requestWithAiChannels({diagnostic:true,channels:[{id:'combined-outage',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'fixture',model:'fixture'}]},async options=>{ const response=await fetch(options.baseUrl);await response.text();throw Object.assign(new Error('HTTP '+response.status),{status:response.status}); });
  if(phase===1) throw new Error('isolated node unavailable during postcondition read');
  return {success:true,finalContent:'postcondition verified'};
 }};
 try{
  const task=startAgentRun('组合故障恢复',{sessionId:createAiSession(),hostId:'local'},'admin',null,agent);await task.finished;
  assert.equal(getRun(task.run.id).status,'failed');assert.equal(writes,1);
  recoverAgentRuns();phase=1;
  await resumeAgentRun(task.run.id,getRun(task.run.id).revision,null,agent).finished;assert.equal(writes,1);assert.equal(getRun(task.run.id).status,'failed');
  phase=2;await resumeAgentRun(task.run.id,getRun(task.run.id).revision,null,agent).finished;
  assert.equal(writes,1);assert.equal(getRun(task.run.id).status,'completed');
 }finally{clearTimeout(keeper);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
