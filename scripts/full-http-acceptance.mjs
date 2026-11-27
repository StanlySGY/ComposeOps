#!/usr/bin/env node
// Full authentication/origin matrix and representative persisted HTTP workflows.
// Uses a private ephemeral DB; does not manage or mutate existing Docker projects.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const directory=mkdtempSync(path.join(tmpdir(),'composeops-http-acceptance-'));
process.env.DB_PATH=path.join(directory,'state.db');process.env.SERVE_FRONTEND='0';process.env.DISABLE_BACKGROUND_JOBS='1';process.env.ENABLE_SHELL='0';process.env.CRON_DATA_FILE=path.join(directory,'cron.json');
const output=path.resolve(process.env.SRE_EVIDENCE_DIR||directory);mkdirSync(output,{recursive:true,mode:0o700});
const {buildApp}=await import('../backend/src/app.js');const app=await buildApp({logger:false});
await app.listen({host:'127.0.0.1',port:0});const base='http://127.0.0.1:'+app.server.address().port;
const trace=[],checks=[];let cookie='';
async function request(url,{method='GET',body,status=200,anonymous=false,origin=base,retry=true}={}){
 const entry={url,method,expected:status,startedAt:Date.now()};trace.push(entry);
 writeFileSync(path.join(output,'trace.json'),JSON.stringify(trace,null,2));
 const res=await fetch(base+url,{method,headers:{...(!anonymous&&cookie?{cookie}:{}),origin,...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
 const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
 entry.status=res.status;entry.durationMs=Date.now()-entry.startedAt;
 if(method==='GET' && status===200 && res.status===503 && retry){await new Promise(resolve=>setTimeout(resolve,1000));return request(url,{method,body,status,anonymous,origin,retry:false});}
 assert.ok((Array.isArray(status)?status:[status]).includes(res.status),`${method} ${url}: expected ${status}, got ${res.status}: ${text.slice(0,350)}`);
 return {data,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
const api=(url,options)=>request('/api/v1'+url,options);
const until=async fn=>{for(let i=0;i<60;i++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,50));}throw new Error('Expected persisted state not observed');};
try{
 const lines=app.printRoutes({commonPrefix:false}).split('\n'),stack=[],routes=[];
 for(const line of lines){const match=line.match(/[├└]── (.+) \(([A-Z, ]+)\)$/);if(!match)continue;const depth=Math.floor(line.indexOf(match[0])/4),url=(depth?stack[depth-1]:'')+match[1];stack[depth]=url;routes.push({url,methods:match[2].split(', ')});}
 writeFileSync(path.join(output,'route-inventory.json'),JSON.stringify(routes,null,2));
 for(const {url,methods} of routes){if(!url.startsWith('/api/v1/')||url.startsWith('/api/v1/auth/')||url.startsWith('/api/v1/gitops/webhook/'))continue;
  for(const method of methods.filter(m=>m!=='HEAD'))await request(url.replace(/:[A-Za-z]+/g,'acceptance-missing'),{method,anonymous:true,status:401});
 }
 checks.push('every registered protected API method rejects missing session');
 const password=randomBytes(24).toString('hex');cookie=(await api('/auth/setup',{method:'POST',body:{password}})).cookie;assert.ok(cookie);
 for(const {url,methods} of routes){if(!url.startsWith('/api/v1/'))continue;for(const method of methods.filter(m=>!['GET','HEAD'].includes(m)))await request(url.replace(/:[A-Za-z]+/g,'acceptance-missing'),{method,origin:'https://untrusted.invalid',status:403});}
 checks.push('every registered API write rejects foreign Origin before execution');
 const needsQuery=new Set(['/api/v1/metrics/historical','/api/v1/cron/preview','/api/v1/sre/onboarding/context','/api/v1/ops/storage/volume-volumes','/api/v1/ops/storage/full-backup-plan','/api/v1/projects/directories','/api/v1/sre/business-recovery/candidates','/api/v1/sre/recovery/candidates']);
 const readResults=[];
 for(const {url,methods} of routes){if(!url.startsWith('/api/v1/')||!methods.includes('GET')||url.includes(':')||url.endsWith('/')||url.includes('/auth/')||url.endsWith('/stream'))continue;
  const result=await request(url,{status:needsQuery.has(url)?[400,404]:200});readResults.push({url,keys:typeof result.data==='object'?Object.keys(result.data):[]});
 }
 writeFileSync(path.join(output,'read-results.json'),JSON.stringify(readResults,null,2));checks.push('authenticated read endpoints return expected JSON or explicit required-context validation');
 const hostId=(await api('/hosts/active')).data.activeHostId;
 const listing=(await api('/projects/directories?'+new URLSearchParams({expectedHostId:hostId,directory:tmpdir()}))).data;
 assert.equal(listing.path,tmpdir());assert.ok(Array.isArray(listing.entries));
 await api('/projects/directories?'+new URLSearchParams({expectedHostId:'acceptance-wrong-host',directory:tmpdir()}),{status:409});
 await api('/ops/storage/full-backup-plan?projectId=acceptance-missing',{status:404});
 checks.push('host directory browsing accepts the current node and rejects stale node identity; backup preview rejects missing project');
 await api('/maintenance/image-check/settings',{method:'PUT',body:{proxyUrl:'http://127.0.0.1:7897'}});
 assert.equal((await api('/maintenance/image-check/settings')).data.proxyUrl,'http://127.0.0.1:7897');
 await api('/maintenance/image-check/settings',{method:'PUT',body:{proxyUrl:'http://user:secret@localhost:7897'},status:400});
 await api('/maintenance/image-check/settings',{method:'PUT',body:{proxyUrl:''}});
 await api('/maintenance/settings',{method:'PUT',body:{backupPath:'/'},status:400});
 await api('/maintenance/plans',{method:'POST',body:{action:'backup',backupPath:directory,containerIds:[]},status:400});
 const absentToken='00000000-0000-4000-8000-000000000000';
 await api('/maintenance/execute',{method:'POST',body:{token:absentToken,confirmed:true,keySaved:true},status:409});
 await api('/maintenance/restore',{method:'POST',body:{token:absentToken,confirmed:true},status:409});
 await api('/maintenance/tasks/'+absentToken+'/recover',{method:'POST',body:{confirmed:false},status:400});
 checks.push('image proxy persistence/validation and backup/restore/recovery guards through authenticated HTTP');
 await api('/personal/preferences',{method:'PUT',body:{refreshInterval:15,logTail:300}});assert.equal((await api('/personal/preferences')).data.logTail,300);
 const job=(await api('/cron',{method:'POST',body:{name:'acceptance schedule',cron:'0 0 * * *',type:'images-check',enabled:false}})).data;
 assert.ok(job.id);await api('/cron/'+job.id,{method:'PUT',body:{name:'updated acceptance'}});assert.equal((await api('/cron')).data.jobs.find(j=>j.id===job.id).enabled,false);
 await api('/cron/preview?cron=invalid',{status:400});await api('/cron/'+job.id,{method:'DELETE'});checks.push('preferences persistence and cron create/edit/invalid schedule/delete');
 const definition=(await api('/workflows/definitions',{method:'POST',status:201,body:{name:'acceptance approval',nodes:[{id:'start',type:'trigger',config:{}},{id:'approve',type:'approval',config:{}}]}})).data.definition;
 const instance=(await api(`/workflows/definitions/${definition.id}/run`,{method:'POST',body:{context:{}}})).data.instance;
 await until(async()=> (await api('/workflows/instances/'+instance.id)).data.instance.status==='waiting_approval');
 await api('/workflows/definitions/'+definition.id,{method:'DELETE',status:409});
 await api(`/workflows/instances/${instance.id}/approve`,{method:'POST',body:{approved:true}});
 await until(async()=> (await api('/workflows/instances/'+instance.id)).data.instance.status==='success');
 await api(`/workflows/instances/${instance.id}/approve`,{method:'POST',body:{approved:true},status:400});
 await api('/workflows/definitions/'+definition.id,{method:'DELETE'});checks.push('workflow approval execution, active delete refusal, duplicate approval refusal and final cleanup');
 const payload={title:'acceptance ticket',idempotencyKey:'acceptance-ticket'};
 const ticket=(await api('/ops-tickets',{method:'POST',status:201,body:payload})).data.ticket;
 assert.equal((await api('/ops-tickets',{method:'POST',status:201,body:payload})).data.ticket.id,ticket.id);
 await api('/ops-tickets/'+ticket.id,{method:'PATCH',body:{status:'ready'}});
 await api('/ops-tickets/'+ticket.id,{method:'PATCH',body:{status:'succeeded'},status:409});
 await api('/ops-tickets/'+ticket.id,{method:'PATCH',body:{status:'cancelled'}});checks.push('ticket idempotency and allowed/forbidden lifecycle transitions');
 const template=(await api('/marketplace/templates/custom',{method:'POST',status:200,body:{name:'Acceptance custom',description:'isolated template',category:'tools',defaultCompose:'services:\n  test:\n    image: alpine:3.20\n',envSchema:[]}})).data;
 const id=template.id||template.template?.id;assert.ok(id);
 await api('/marketplace/templates/custom/'+id,{method:'PATCH',body:{name:'Acceptance renamed'}});
 await api('/marketplace/favorites/'+id,{method:'POST'});
 assert.ok((await api('/marketplace/templates/search?q=Acceptance&onlyFavorites=true')).data.results.some(row=>row.id===id));
 await api('/marketplace/favorites/'+id,{method:'DELETE'});await api('/marketplace/templates/custom/'+id,{method:'DELETE'});checks.push('marketplace custom template edit, search, favorite and removal');
 await api('/system/mcp',{method:'POST',body:{enabled:true,mode:'readonly'}});
 await request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'tools/list'},status:401});
 await request('/healthz/platform/',{method:'POST',body:{},status:401});await request('/otlp/v1/logs',{method:'POST',body:{},status:401});checks.push('session cannot substitute MCP, external-monitor or telemetry credentials');
 await api('/auth/logout',{method:'POST'});await api('/hosts',{status:401});checks.push('logout revokes session');
 writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,registeredRoutes:routes.length,requests:trace.length,checks},null,2));console.log(JSON.stringify({passed:true,requests:trace.length,checks}));
}finally{writeFileSync(path.join(output,'trace.json'),JSON.stringify(trace,null,2));await app.close();if(output!==directory)rmSync(directory,{recursive:true,force:true});}
