#!/usr/bin/env node
// Explicit live-provider acceptance; config must be a private file outside the repo.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
if (!process.argv.includes('--run-live-model') || !process.env.ACCEPTANCE_AI_CONFIG) throw new Error('Requires --run-live-model and ACCEPTANCE_AI_CONFIG');
const dir=mkdtempSync(path.join(tmpdir(),'composeops-agent-web-'));
process.env.DB_PATH=path.join(dir,'test.db');process.env.DISABLE_BACKGROUND_JOBS='1';
delete process.env.DB_ENCRYPTION_KEY;delete process.env.DB_ENCRYPTION_KEY_FILE;
const output=path.resolve(process.env.SRE_EVIDENCE_DIR||dir);mkdirSync(output,{recursive:true,mode:0o700});
const config=JSON.parse(readFileSync(process.env.ACCEPTANCE_AI_CONFIG,'utf8'));
const emptyNode=createServer((_req,res)=>res.end('[]'));await new Promise(resolve=>emptyNode.listen(0,'127.0.0.1',resolve));
const {setAiConfig,setSearchConfig}=await import('../backend/src/services/ai.js');
const {upsertHost,setActiveHost}=await import('../backend/src/services/docker-hosts.js');
const {getAgent}=await import('../backend/src/services/agent.js');
setAiConfig(config.ai);setSearchConfig(config.search);
const host=upsertHost({name:'isolated acceptance fixture',type:'tcp',host:'127.0.0.1',port:emptyNode.address().port});setActiveHost(host.id);
const agent=getAgent();
for(const name of agent.tools.keys())if(!['web.search','web.open'].includes(name))agent.tools.delete(name);
const list=agent.listTools.bind(agent);agent.listTools=()=>list().filter(tool=>['web.search','web.open'].includes(tool.name));
const events=[];
try{
 const result=await agent.executeWithLoop('请联网搜索 Docker Compose depends_on condition service_healthy 的官方说明，再打开 docs.docker.com 的原文核实，最后用中文简要解释服务启动顺序和就绪状态的区别并附来源链接。不要操作本地环境。',
  {webSearchEnabled:true,role:'diagnose',initiator:'isolated-acceptance'},event=>{if(event.type!=='token')events.push(event);},AbortSignal.timeout(240000));
 writeFileSync(path.join(output,'result.json'),JSON.stringify({success:result.success,answer:result.finalContent,events},null,2),{mode:0o600});
 const requests=events.filter(e=>e.type==='tool_requested').map(e=>e.tool);
 assert.equal(result.success,true);assert.ok(requests.includes('web.search'));assert.ok(requests.includes('web.open'));
 assert.match(result.finalContent,/https:\/\/docs\.docker\.com\//);
 assert.ok(!events.some(e=>e.type==='tool_error'),'live tools must finish successfully');
 console.log(JSON.stringify({passed:true,liveModel:true,scope:'isolated DB, empty Docker fixture, public documentation only',tools:requests}));
}finally{emptyNode.closeAllConnections();await new Promise(resolve=>emptyNode.close(resolve));if(output!==dir)rmSync(dir,{recursive:true,force:true});}
