import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import db from '../src/lib/db.js';
import { normalizeWebUiPath, readWebUiSettings, saveWebUiSettings, applyWebUiSettings } from '../src/services/project-webui-settings.js';
import { registerProjectWebUiRoutes } from '../src/routes/project-webui-settings.js';
import { buildApp } from '../src/app.js';

const entries=[{service:'lucky',port:16601,path:'/web/'}];
const project={id:'network',projectName:'network',containers:[{id:'old-lucky',service:'lucky',name:'lucky',state:'running',networkMode:'host',hostPorts:[{port:16601,type:'tcp'}]},{id:'nps',name:'nps',service:'nps',state:'running',ports:[{public:8081,private:8081,type:'tcp'}]}]};
test('入口按节点/项目/服务/端口隔离，容器重建不影响，过期保存拒绝且根路径清除覆盖',()=>{
 assert.equal(readWebUiSettings('local','network').revision,0);
 saveWebUiSettings('local','network',0,entries);
 const links=[{containerId:'rebuilt',serviceName:'lucky',ports:[{port:16601,url:'http://nas:16601'}]},{serviceName:'nps',ports:[{port:8081,url:'http://nas:8081'}]}];
 const current=readWebUiSettings('local','network');
 assert.equal(applyWebUiSettings(links,current.entries)[0].ports[0].url,'http://nas:16601/web/');
 assert.equal(applyWebUiSettings(links,current.entries)[1].ports[0].url,'http://nas:8081');
 assert.deepEqual(readWebUiSettings('remote','network').entries,[]);assert.deepEqual(readWebUiSettings('local','other').entries,[]);
 assert.throws(()=>saveWebUiSettings('local','network',0,[]),{statusCode:409});
 saveWebUiSettings('local','network',1,[{...entries[0],path:'/'}]);assert.deepEqual(readWebUiSettings('local','network').entries,[]);
});
test('路径只允许本应用相对入口，拒绝协议/域名/编码绕过/控制字符与超长输入',()=>{
 assert.equal(normalizeWebUiPath(' /web/ '),'/web/');assert.equal(normalizeWebUiPath(''), '');assert.equal(normalizeWebUiPath('/入口/'), '/%E5%85%A5%E5%8F%A3/');
 for(const path of ['http://evil/','//evil/','/\\evil','/%2f/evil','/%5cevil','/../admin','/%2e%2e/admin','/web?token=x','/web#x','/web\n/x','/bad%','x','/x'.repeat(300),'/'+'入口'.repeat(100),'\0'])assert.throws(()=>normalizeWebUiPath(path),{statusCode:400},path);
 for(const value of [null,{},[...entries,...entries],[{...entries[0],port:0}],[{...entries[0],port:'16601'}],[{...entries[0],url:'https://evil'}]])assert.throws(()=>saveWebUiSettings('local','invalid',0,value),{statusCode:400});
 assert.equal(readWebUiSettings('local','invalid').revision,0);
});
test('入口 API 保存后立即影响链接，缓存禁用且审计不记录安全路径',async t=>{
 const app=Fastify();const hosts=['route-host'];
 registerProjectWebUiRoutes(app,{resolveProject:async id=>id==='network'?project:null,activeHostId:()=>hosts.at(-1)});t.after(()=>app.close());
 assert.equal((await app.inject('/missing/webui')).statusCode,404);
 const initial=await app.inject({url:'/network/webui-settings',headers:{host:'nas:28765'}});assert.equal(initial.headers['cache-control'],'no-store');assert.equal(initial.json().targets.length,2);
 const save=await app.inject({method:'PUT',url:'/network/webui-settings',payload:{hostId:hosts.at(-1),revision:0,entries:[{...entries[0],path:'/private-entry/'}]}});assert.equal(save.statusCode,200);
 project.containers[0].id='new-lucky';
 const links=(await app.inject({url:'/network/webui',headers:{host:'nas:28765'}})).json().links;
 assert.equal(links[0].ports[0].url,'http://nas:16601/private-entry/');
 assert.equal(links[1].ports[0].url,'http://nas:8081');
 assert.equal((await app.inject({method:'PUT',url:'/network/webui-settings',payload:{hostId:hosts.at(-1),revision:0,entries:[]}})).statusCode,409);
 assert.equal(JSON.stringify(db.prepare("SELECT detail FROM operation_history WHERE action='webui.save'").all()).includes('/private-entry/'),false);
 hosts.push('other-host');assert.equal((await app.inject({method:'PUT',url:'/network/webui-settings',payload:{hostId:'route-host',revision:1,entries:[]}})).statusCode,409);
 assert.deepEqual((await app.inject('/network/webui-settings')).json().entries,[]);
});
test('读取过程中切换节点拒绝，认证和 Origin 校验保护入口 API',async t=>{
 const app=Fastify();let host='a';registerProjectWebUiRoutes(app,{activeHostId:()=>host,resolveProject:async()=>{host='b';return project;}});t.after(()=>app.close());
 assert.equal((await app.inject('/network/webui')).statusCode,409);
 const protectedApp=await buildApp({logger:false});t.after(()=>protectedApp.close());
 for(const [method,url] of [['GET','webui'],['GET','webui-settings'],['PUT','webui-settings']])assert.equal((await protectedApp.inject({method,url:'/api/v1/projects/network/'+url})).statusCode,401);
 const headers={origin:'http://localhost:3001',host:'localhost:3001'};
 const setup=await protectedApp.inject({method:'POST',url:'/api/v1/auth/setup',headers,payload:{password:'webui-setting-test-password'}});assert.equal(setup.statusCode,200);
 const cookie=String(setup.headers['set-cookie']).split(';')[0];
 assert.equal((await protectedApp.inject({method:'PUT',url:'/api/v1/projects/network/webui-settings',headers:{...headers,cookie,origin:'https://evil.invalid'},payload:{}})).statusCode,403);
});
