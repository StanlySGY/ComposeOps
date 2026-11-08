import { test, expect } from '@playwright/test';
async function install(page, path='./#/tickets') {
 const errors=[]; page.on('pageerror',error=>errors.push(error.message));
 await page.goto('./#/dashboard'); await expect(page.getByRole('heading',{name:'运维总览',exact:true})).toBeVisible();
 await page.evaluate(()=>{
  const original=window.fetch;
  const a={id:'task-a',title:'备份恢复验收',description:'核对最近一次恢复演练的证据',status:'active',priority:'high',sourceType:'manual',projectId:'cache',acceptanceCriteria:['隔离卷恢复成功','人工核对文件内容'],createdAt:'2026-11-09T00:00:00Z',assignmentCount:1,pendingReports:1,attentionEffects:1};
  const b={...a,id:'task-b',title:'资源整理计划',status:'planning',priority:'normal',description:'整理当前项目的资源占用',acceptanceCriteria:['列出可清理资源'],assignmentCount:0,pendingReports:0,attentionEffects:0};
  const mandate={id:'mandate-a',ticketId:'task-a',version:2,status:'active',scope:{projectIds:['cache'],composeProjectNames:['cache'],hostIds:[],resourceIds:[]},allowedActions:['service.inspect'],deniedActions:['volume.delete'],fingerprint:'test-approved-scope',expiresAt:'2027-01-01T00:00:00Z'};
  const effect={id:'effect-a',ticketId:'task-a',effectType:'service.inspect',status:'awaiting_approval',mode:'execute',risk:'low',target:{projectId:'cache',composeProject:'cache'},payload:{},mandateId:'mandate-a',createdAt:a.createdAt};
  const report={id:'report-a',ticketId:'task-a',reportType:'verification',status:'submitted',summary:'隔离卷已恢复，文件内容与备份一致',findings:[],evidence:[{kind:'note',summary:'文件哈希匹配',sourceId:'verification-a'}],createdAt:a.createdAt};
  const blank=ticket=>({ticket,mandates:[],assignments:[],reports:[],effects:[],activity:[]});
  const f=window.ticketFixture={data:{'task-a':{...blank(a),mandates:[mandate],effects:[effect],reports:[report],activity:[{id:'evt-a',eventType:'ticket_created',createdAt:a.createdAt,details:{title:a.title}}]},'task-b':blank(b)},calls:[],failList:false,failDetail:false,failWorker:false,failWrite:false,hold:false,excludeA:false};
  window.fetch=async(input,init={})=>{
   const url=new URL(typeof input==='string'?input:input.url,location.href),path=url.pathname,method=init.method||'GET';if(!path.startsWith('/api/v1/ops-tickets'))return original(input,init);
   const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}),body=init.body?JSON.parse(init.body):{};
   f.calls.push({path,method,body});
   if(method==='GET'){
    if(path.endsWith('/worker/status'))return f.failWorker?json({message:'执行器状态暂时不可读'},503):json({enabled:true,state:'running',queueDepth:1,executing:0,leased:0,outcomeUnknown:0});
    if(path==='/api/v1/ops-tickets'){
     if(f.failList)return json({message:'任务列表暂时离线'},503);
     let rows=Object.values(f.data).map(d=>d.ticket);if(f.excludeA)rows=rows.filter(row=>row.id!=='task-a');
     if(url.searchParams.get('status'))rows=rows.filter(row=>row.status===url.searchParams.get('status'));
     if(url.searchParams.get('query'))rows=rows.filter(row=>row.title.includes(url.searchParams.get('query')));
     return json({tickets:rows,stats:{open:2,blocked:0,review:0,terminal:0}});
    }
    if(f.failDetail)return json({message:'任务详情暂时离线'},503);return f.data[path.split('/').at(-1)]?json(f.data[path.split('/').at(-1)]):json({message:'任务不存在'},404);
   }
   if(f.hold)await new Promise(resolve=>{f.release=resolve;});if(f.failWrite)return json({message:'保存暂时无法受理'},503);
   if(path==='/api/v1/ops-tickets'){
    const ticket={...a,...body,id:'task-new',status:'planning'};f.data[ticket.id]=blank(ticket);return json({ticket,replayed:false},201);
   }
   const id=path.split('/')[4],d=f.data[id];
   if(method==='PATCH'){Object.assign(d.ticket,body);return json({ticket:d.ticket});}
   if(path.endsWith('/revoke')){d.mandates[0].status='revoked';d.mandates[0].revokeReason=body.reason;d.effects.forEach(e=>{if(['awaiting_approval','queued'].includes(e.status))e.status='rejected';});return json({mandate:d.mandates[0]});}
   if(path.endsWith('/decision')){Object.assign(d.reports[0],{status:body.accepted?'accepted':'rejected',decisionNote:body.note});return json({report:d.reports[0]});}
   if(path.endsWith('/approve')){d.effects[0].status='queued';return json({effect:d.effects[0]});}
   if(path.endsWith('/cancel')){d.effects[0].status='cancelled';return json({effect:d.effects[0]});}
   return json({message:'未定义的测试写入'},400);
  };
 });
 await page.goto(path);await expect(page.getByRole('heading',{name:'长期运维任务',exact:true})).toBeVisible();await expect(page.locator('.ticket-list-item')).toHaveCount(2);return errors;
}
const tab=(page,name)=>page.getByRole('tab',{name:new RegExp('^'+name)});
const modal=page=>page.getByRole('dialog');
async function release(page){await page.evaluate(()=>{window.ticketFixture.hold=false;window.ticketFixture.release();});}

test('列表、详情与执行器独立恢复，错误不伪装成空列表',async({page},testInfo)=>{
 const errors=await install(page);await expect(page.locator('.ticket-summary')).toBeVisible();await page.waitForFunction(()=>!document.querySelector('.page-fade-enter-active'));await page.screenshot({path:testInfo.outputPath('ticket-workspace.png')});await page.evaluate(()=>{window.ticketFixture.failList=true;});await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('alert')).toContainText('任务列表暂时离线');await expect(page.getByRole('heading',{name:'备份恢复验收',exact:true})).toBeVisible();
 await page.evaluate(()=>{window.ticketFixture.failList=false;});await page.getByRole('button',{name:'重试列表',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);
 await page.evaluate(()=>{window.ticketFixture.failDetail=true;});await page.getByRole('button',{name:'刷新详情',exact:true}).click();await expect(page.getByRole('alert')).toContainText('任务详情暂时离线');await expect(page.getByText('人工核对文件内容',{exact:true})).toBeVisible();
 await page.evaluate(()=>{window.ticketFixture.failDetail=false;window.ticketFixture.failWorker=true;});await page.getByRole('button',{name:'重试详情',exact:true}).click();await page.getByRole('button',{name:'刷新',exact:true}).click();await tab(page,'动作队列').click();await expect(page.getByText('状态未知',{exact:true})).toBeVisible();await expect(page.getByRole('alert')).toContainText('执行器状态暂时不可读');
 await page.evaluate(()=>{window.ticketFixture.failWorker=false;});await page.getByRole('button',{name:'重试执行器',exact:true}).click();await expect(page.getByText('状态未知',{exact:true})).toHaveCount(0);expect(errors).toEqual([]);
});
test('创建失败保留草稿，确认创建后列表离线也保留新任务',async({page})=>{
 const errors=await install(page);await page.getByRole('button',{name:'新建长期任务',exact:true}).click();await page.getByPlaceholder('例如：检查 staging 所有 Compose 服务并形成更新计划').fill('演练结果复核');
 await page.evaluate(()=>{window.ticketFixture.failWrite=true;});await page.getByRole('button',{name:'创建任务',exact:true}).click();await expect(page.getByRole('alert')).toContainText('保存暂时无法受理');await expect(page.getByPlaceholder('例如：检查 staging 所有 Compose 服务并形成更新计划')).toHaveValue('演练结果复核');
 await page.evaluate(()=>{Object.assign(window.ticketFixture,{failWrite:false,failList:true,failDetail:true});});await page.getByRole('button',{name:'创建任务',exact:true}).click();await expect(page.getByRole('heading',{name:'演练结果复核',exact:true})).toBeVisible();await expect(page.locator('.ticket-feedback')).toContainText('长期任务已创建');expect(errors).toEqual([]);
});
test('更新状态防重复，确认结果不被刷新失败反转',async({page})=>{
 const errors=await install(page);await page.getByRole('combobox',{name:'长期任务状态',exact:true}).selectOption('review');await page.evaluate(()=>{window.ticketFixture.hold=true;});await page.getByRole('button',{name:'更新状态',exact:true}).click();await expect(page.getByRole('button',{name:'更新状态',exact:true})).toBeDisabled();
 await page.evaluate(()=>{window.ticketFixture.failList=true;window.ticketFixture.failDetail=true;});await release(page);await expect(page.getByRole('combobox',{name:'长期任务状态',exact:true})).toHaveValue('review');await expect(page.locator('.ticket-feedback')).toContainText('任务状态已更新');expect(await page.evaluate(()=>window.ticketFixture.calls.filter(c=>c.method==='PATCH').length)).toBe(1);expect(errors).toEqual([]);
});
test('撤销授权确认中保留原因、锁住退出，失败可重试',async({page},testInfo)=>{
 const errors=await install(page);await tab(page,'授权').click();await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(modal(page)).toContainText('备份恢复验收');await expect(modal(page)).toContainText('授权 v2');await modal(page).getByRole('textbox').fill('维护范围已结束');
 await page.evaluate(()=>{Object.assign(window.ticketFixture,{hold:true,failWrite:true});});await modal(page).getByRole('button',{name:'撤销授权',exact:true}).click();await page.keyboard.press('Escape');await expect(modal(page)).toBeVisible();await release(page);await expect(modal(page).getByRole('alert')).toContainText('保存暂时无法受理');await expect(modal(page).getByRole('textbox')).toHaveValue('维护范围已结束');await page.screenshot({path:testInfo.outputPath('ticket-revoke-error.png')});
 await page.evaluate(()=>{window.ticketFixture.failWrite=false;});await modal(page).getByRole('button',{name:'撤销授权',exact:true}).click();await expect(modal(page)).toHaveCount(0);await expect(page.locator('.ticket-feedback')).toContainText('授权已撤销');expect(errors).toEqual([]);
});
test('快速切换标签后批准动作不会被迟到路由关闭',async({page})=>{
 const errors=await install(page);await tab(page,'动作队列').click();await page.getByRole('button',{name:'批准并入队',exact:true}).click();await expect(modal(page)).toContainText('批准并不代表执行成功');await expect(modal(page)).toContainText('cache');await modal(page).getByRole('button',{name:'批准并入队',exact:true}).click();await expect(modal(page)).toHaveCount(0);await expect(page.locator('.ticket-feedback')).toContainText('动作已入队');await expect(page.getByText('等待派发',{exact:true})).toBeVisible();expect(errors).toEqual([]);
});
test('报告验收意见可取消与提交，任务不会自动标记成功',async({page})=>{
 const errors=await install(page);await tab(page,'报告验收').click();await page.getByRole('button',{name:'退回补充',exact:true}).click();await modal(page).getByRole('textbox').fill('请补充恢复时间');await modal(page).getByRole('button',{name:'取消',exact:true}).click();expect(await page.evaluate(()=>window.ticketFixture.calls.filter(c=>c.path.endsWith('/decision')).length)).toBe(0);
 await page.getByRole('button',{name:'验收通过',exact:true}).click();await expect(modal(page)).toContainText('文件内容与备份一致');await modal(page).getByRole('button',{name:'验收通过',exact:true}).click();await expect(page.getByText('已通过',{exact:true})).toBeVisible();await expect(page.getByRole('combobox',{name:'长期任务状态',exact:true})).toHaveValue('active');expect(errors).toEqual([]);
});
test('任务各自保留授权草稿，手机能返回列表继续选择',async({page})=>{
 const errors=await install(page);await tab(page,'授权').click();await page.getByRole('button',{name:'签发授权',exact:true}).click();await page.getByPlaceholder('composeops',{exact:true}).fill('cache-a');
 await page.locator('.ticket-list-item').filter({hasText:'资源整理计划'}).click();await tab(page,'授权').click();await page.getByRole('button',{name:'签发授权',exact:true}).click();await expect(page.getByPlaceholder('composeops',{exact:true})).toHaveValue('');
 await page.locator('.ticket-list-item').filter({hasText:'备份恢复验收'}).click();await tab(page,'授权').click();await expect(page.getByPlaceholder('composeops',{exact:true})).toHaveValue('cache-a');
 if((await page.viewportSize()).width<1280){await page.getByRole('button',{name:'返回任务列表',exact:true}).click();await expect(page.locator('.ticket-list')).toBeFocused();await expect(page.locator('.ticket-list')).toBeInViewport();}expect(errors).toEqual([]);
});
test('筛选保留在地址中，深链详情不因列表筛除而换成别的任务',async({page})=>{
 const errors=await install(page);await page.getByRole('textbox',{name:'搜索长期任务',exact:true}).fill('资源');await page.getByRole('button',{name:'筛选',exact:true}).click();await expect(page.locator('.ticket-list-item')).toHaveCount(1);await expect(page.getByRole('heading',{name:'备份恢复验收',exact:true})).toBeVisible();await expect(page).toHaveURL(/q=/);
 const source=page.url();await page.goto('./#/dashboard');await expect(page.getByRole('heading',{name:'运维总览',exact:true})).toBeVisible();await page.goto(source);await expect(page.getByRole('textbox',{name:'搜索长期任务',exact:true})).toHaveValue('资源');await expect(page.locator('.ticket-list-item')).toHaveCount(1);await expect(page.getByRole('heading',{name:'备份恢复验收',exact:true})).toBeVisible();expect(errors).toEqual([]);
});
test('切换节点后迟到创建不能跳到旧请求的任务',async({page})=>{
 const errors=await install(page);await page.getByRole('button',{name:'新建长期任务',exact:true}).click();await page.getByPlaceholder('例如：检查 staging 所有 Compose 服务并形成更新计划').fill('迟到创建');await page.evaluate(()=>{window.ticketFixture.hold=true;});await page.getByRole('button',{name:'创建任务',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>!!window.ticketFixture.release)).toBe(true);await page.evaluate(()=>window.dispatchEvent(new CustomEvent('composeops:host-changed')));await release(page);await expect(page.locator('.ticket-feedback')).toHaveCount(0);await expect(page.getByPlaceholder('例如：检查 staging 所有 Compose 服务并形成更新计划')).toHaveValue('迟到创建');expect(errors).toEqual([]);
});
test('320px 阅读、参数展开、键盘标签与确认窗口无横向溢出',async({page},testInfo)=>{
 await page.setViewportSize({width:320,height:740});await page.emulateMedia({reducedMotion:'reduce'});const errors=await install(page);await page.locator('.ticket-list-item').filter({hasText:'备份恢复验收'}).click();
 await tab(page,'任务总览').focus();await page.keyboard.press('End');await expect(tab(page,'动作队列')).toHaveAttribute('aria-selected','true');await page.getByText('查看参数与执行结果',{exact:true}).click();await expect(page.locator('.ticket-technical-details pre')).toBeVisible();
 expect(await page.locator('.app-main').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);const badge=page.locator('.ticket-detail article').filter({hasText:'effect-a'}).locator('.count-badge');const box=await badge.boundingBox();expect(box.height).toBeLessThan(30);expect(box.x+box.width).toBeLessThanOrEqual(320);await page.screenshot({path:testInfo.outputPath('ticket-mobile-details.png')});
 await page.getByRole('button',{name:'批准并入队',exact:true}).click();await expect(modal(page).getByRole('button',{name:'批准并入队',exact:true})).toBeInViewport();expect(await modal(page).evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('ticket-mobile-confirmation.png')});await page.keyboard.press('Escape');await expect(modal(page)).toHaveCount(0);expect(errors).toEqual([]);
});

test('320px 确认输入全宽，错误保持可见，减少动画仍可退出',async({page},testInfo)=>{
 await page.setViewportSize({width:320,height:740});await page.emulateMedia({reducedMotion:'reduce'});const errors=await install(page);
 await tab(page,'授权').click();await page.getByRole('button',{name:'撤销',exact:true}).click();const input=modal(page).getByRole('textbox');await input.fill('本次授权范围已经结束');
 expect((await input.boundingBox()).width).toBeGreaterThan(250);await page.evaluate(()=>{window.ticketFixture.failWrite=true;});await modal(page).getByRole('button',{name:'撤销授权',exact:true}).click();await expect(modal(page).getByRole('alert')).toBeInViewport();
 await expect(modal(page).getByRole('button',{name:'撤销授权',exact:true})).toBeInViewport();await page.screenshot({path:testInfo.outputPath('ticket-mobile-revoke.png')});await page.keyboard.press('Escape');await expect(modal(page)).toHaveCount(0);expect(errors).toEqual([]);
});
