#!/usr/bin/env node
/** Durable overnight acceptance: isolated synthetic Agent load + optional public health observation.
 * Reports remain running/interrupted unless the entire requested wall-clock interval elapsed. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
const {values}=parseArgs({options:{hours:{type:'string',default:'24'},output:{type:'string'},health:{type:'string'}}});
const hours=Number(values.hours);
if(!Number.isInteger(hours)||hours<24||hours>72||!values.output)throw new Error('Require --hours=24..72 --output=/outside/report-directory [--health=http://host/health]');
const output=path.resolve(values.output);fs.mkdirSync(output,{recursive:true,mode:0o700});
const repo=path.resolve(import.meta.dirname,'..');if(output===repo||output.startsWith(repo+path.sep))throw new Error('Evidence must be outside repository');
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const startedAt=Date.now(), started=performance.now(), durationSeconds=hours*3600;
const health={checks:0,failures:[],last:null};let ending=false;
const reportFile=path.join(output,'observation.json'),soakFile=path.join(output,'soak.json');
function report(status,extra={}) {const data={status,revision,startedAt,updatedAt:Date.now(),elapsedSeconds:Math.round((performance.now()-started)/1000),requiredSeconds:durationSeconds,health,...extra};const temp=reportFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(temp,reportFile);}
async function check(){if(ending||!values.health)return;health.checks++;try{const r=await fetch(values.health,{signal:AbortSignal.timeout(10000)});const body=await r.json();if(r.status!==200||body.status!=='ok')throw new Error('unhealthy response');health.last={at:Date.now(),ok:true};}catch(e){const f={at:Date.now(),message:String(e.message).slice(0,200)};health.last={...f,ok:false};health.failures.push(f);}if(!ending)report('running');}
const log=fs.openSync(path.join(output,'soak.log'),'wx',0o600);
const child=spawn(process.execPath,['scripts/agent-soak.mjs','--durable',`--duration-seconds=${durationSeconds}`,'--workers=4','--requests-per-minute=12','--sample-interval-ms=10000',`--report-file=${soakFile}`],{cwd:repo,stdio:['ignore',log,log]});
report('running');void check();const timer=setInterval(()=>void check(),60000);
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{ending=true;clearInterval(timer);report('interrupted',{reason:signal});child.kill(signal);});
child.once('error',error=>{ending=true;clearInterval(timer);report('failed',{error:error.message});process.exitCode=1;fs.closeSync(log);});
child.once('exit',(code,signal)=>{clearInterval(timer);fs.closeSync(log);let soak;try{soak=JSON.parse(fs.readFileSync(soakFile));}catch{soak=null;}
const elapsed=(performance.now()-started)/1000;const passed=!ending&&code===0&&elapsed>=durationSeconds&&soak?.status==='passed'&&!health.failures.length;
report(ending?'interrupted':passed?'passed':'failed',{exitCode:code,signal,soakStatus:soak?.status||'missing'});ending=true;process.exitCode=passed?0:1;});
