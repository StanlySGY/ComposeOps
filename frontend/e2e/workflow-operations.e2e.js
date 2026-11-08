import { test, expect } from '@playwright/test';
async function install(page) {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto('./#/dashboard');await expect(page.getByRole('heading',{name:'运维总览',exact:true})).toBeVisible();
  await page.evaluate(()=>{
    const original=window.fetch;
    const def={id:'wf-a',name:'缓存维护',description:'确认后执行一次缓存服务重启',triggerType:'manual',triggerConfig:{},enabled:true,nodes:[{id:'start',type:'trigger',config:{}},{id:'approval',type:'approval',config:{}},{id:'restart-cache',type:'action',config:{action:'restart',projectId:'cache'}}]};
    const run={id:'run-a',definitionId:'wf-a',name:'缓存维护',status:'waiting_approval',currentNode:'approval',createdAt:'2026-11-09T00:00:00Z',context:{pendingApprovalIntent:{actionIntent:{action:'restart',projectId:'cache'}}}};
    const f=window.workflowFixture={definitions:[def],instances:[run],hold:false,failWrite:false,failDefinitions:false,failInstances:false,failDetail:false,calls:[],nextRun:0};
    window.fetch=async(input,init={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href),path=url.pathname,method=init.method||'GET';const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
      if(!path.startsWith('/api/v1/workflows'))return original(input,init);
      f.calls.push({path,method,body:init.body?JSON.parse(init.body):null});
      if(method==='GET'&&path.endsWith('/definitions'))return f.failDefinitions?json({message:'工作流定义暂时离线'},503):json({definitions:f.definitions});
      if(method==='GET'&&path.endsWith('/instances'))return f.failInstances?json({message:'实例列表暂时离线'},503):json({instances:f.instances});
      if(method==='GET'){
        if(f.failDetail)return json({message:'步骤暂时无法读取'},503);const inst=f.instances.find(item=>path.endsWith('/'+item.id));
        return json({instance:{...inst,steps:[{id:1,nodeType:'trigger',nodeId:'start',status:'success',startedAt:'2026-11-09T00:00:00Z',finishedAt:'2026-11-09T00:00:01Z',output:{source:'manual'}},{id:2,nodeType:'approval',nodeId:'approval',status:inst.status==='waiting_approval'?'waiting_approval':'success',startedAt:'2026-11-09T00:00:01Z'}]}});
      }
      if(f.hold)await new Promise(resolve=>{f.release=resolve;});if(f.failWrite)return json({message:'操作暂时无法受理'},503);
      const payload=init.body?JSON.parse(init.body):{};
      if(path.endsWith('/run')){const inst={...run,id:'run-'+(++f.nextRun),status:'running',currentNode:'start',context:{}};f.instances.unshift(inst);return json({instance:inst});}
      if(path.endsWith('/approve')||path.endsWith('/cancel')){const id=path.split('/').at(-2);const inst=f.instances.find(item=>item.id===id);inst.status=path.endsWith('/cancel')||!payload.approved?'cancelled':'running';return json({instance:inst});}
      if(method==='DELETE'){
        if(f.instances.some(item=>['running','pending','waiting_approval'].includes(item.status)))return json({message:'此工作流仍有运行或待审批实例，请先处理或取消'},409);
        f.definitions=[];f.instances=[];return json({ok:true});
      }
      if(method==='PUT'){f.definitions[0]={...def,...payload};return json({definition:f.definitions[0]});}
      if(method==='POST'){const definition={...payload,id:'wf-new',enabled:true};f.definitions.push(definition);return json({definition});}
      return json({});
    };
  });
  await page.goto('./#/workflows');await expect(page.locator('.workflow-definition')).toHaveCount(1);await expect(page.locator('.workflow-instance')).toHaveCount(1);return errors;
}
const definition=page=>page.locator('.workflow-definition').first();
const instance=page=>page.locator('.workflow-instance').filter({hasText:'run-a'});
const dialog=(page,name)=>page.getByRole('dialog',{name,exact:true});
async function release(page){await page.evaluate(()=>{window.workflowFixture.hold=false;window.workflowFixture.release();});}

test('运行防重复，列表刷新失败仍显示已受理实例',async({page},testInfo)=>{
 const errors=await install(page);await page.waitForFunction(()=>!document.querySelector('.page-fade-enter-active'));await page.screenshot({path:testInfo.outputPath('workflow-overview.png')});await page.evaluate(()=>{Object.assign(window.workflowFixture,{hold:true,failInstances:true});});
 await definition(page).getByRole('button',{name:'运行',exact:true}).click();await expect(definition(page).getByRole('button',{name:'启动中…',exact:true})).toBeDisabled();await release(page);
 await expect(definition(page)).toContainText('运行已受理');await expect(page.locator('.workflow-instance')).toHaveCount(2);await expect(page.getByRole('alert')).toContainText('实例列表暂时离线');
 expect(await page.evaluate(()=>window.workflowFixture.calls.filter(call=>call.path.endsWith('/run')).length)).toBe(1);
 await definition(page).getByRole('button',{name:'查看运行记录',exact:true}).click();await expect(page.locator('.workflow-instance-section')).toBeFocused();expect(errors).toEqual([]);
});
test('审批失败可重试，同一实例取消与审批互斥，成功不误报执行完成',async({page})=>{
 const errors=await install(page);await expect(instance(page)).toContainText('重启 · 项目 cache');await page.evaluate(()=>{Object.assign(window.workflowFixture,{hold:true,failWrite:true});});
 await instance(page).getByRole('button',{name:'通过审批',exact:true}).click();await expect(instance(page).getByRole('button',{name:'拒绝',exact:true})).toBeDisabled();await expect(instance(page).getByRole('button',{name:'取消工作流 缓存维护',exact:true})).toBeDisabled();
 await release(page);await expect(instance(page).getByRole('alert')).toContainText('操作暂时无法受理');
 await page.evaluate(()=>{Object.assign(window.workflowFixture,{failWrite:false,failInstances:true});});await instance(page).getByRole('button',{name:'通过审批',exact:true}).click();
 await expect(instance(page)).toContainText('已通过审批');await expect(instance(page)).toContainText('执行中');await expect(instance(page)).not.toContainText('执行成功');expect(errors).toEqual([]);
});
test('删除活动工作流被真实契约拒绝，取消实例后可删除并清理历史',async({page})=>{
 const errors=await install(page);await definition(page).getByRole('button',{name:'删除',exact:true}).click();const confirm=dialog(page,'删除工作流');await expect(confirm).toContainText('全部运行实例与步骤历史');
 await confirm.getByRole('button',{name:'删除',exact:true}).click();await expect(confirm.getByRole('alert')).toContainText('仍有运行或待审批');await confirm.getByRole('button',{name:'取消',exact:true}).click();
 await instance(page).getByRole('button',{name:'取消工作流 缓存维护',exact:true}).click();await expect(instance(page)).toContainText('已经执行的操作不会撤销');
 await definition(page).getByRole('button',{name:'删除',exact:true}).click();await page.evaluate(()=>{Object.assign(window.workflowFixture,{failDefinitions:true,failInstances:true});});await confirm.getByRole('button',{name:'删除',exact:true}).click();
 await expect(confirm).toHaveCount(0);await expect(page.locator('.workflow-definition')).toHaveCount(0);await expect(page.locator('.workflow-instance')).toHaveCount(0);await expect(page.locator('.workflow-success')).toContainText('运行历史已删除');expect(errors).toEqual([]);
});
test('定义与实例独立失败重试，不伪装成空列表',async({page})=>{
 const errors=await install(page);await page.evaluate(()=>{window.workflowFixture.failDefinitions=true;});await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('alert')).toContainText('工作流定义暂时离线');await expect(page.locator('.workflow-instance')).toHaveCount(1);
 await page.evaluate(()=>{window.workflowFixture.failDefinitions=false;});await page.getByRole('button',{name:'重试工作流',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);
 await page.evaluate(()=>{window.workflowFixture.failInstances=true;});await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByRole('alert')).toContainText('实例列表暂时离线');await expect(page.locator('.workflow-definition')).toHaveCount(1);
 await page.evaluate(()=>{window.workflowFixture.failInstances=false;});await page.getByRole('button',{name:'重试实例',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);expect(errors).toEqual([]);
});
test('步骤详情错误恢复、输出展开和逐层退出',async({page},testInfo)=>{
 const errors=await install(page);await page.evaluate(()=>{window.workflowFixture.failDetail=true;});await instance(page).getByRole('button',{name:'步骤详情',exact:true}).click();const details=dialog(page,'运行步骤详情');await expect(details.getByRole('alert')).toContainText('步骤暂时无法读取');
 await page.evaluate(()=>{window.workflowFixture.failDetail=false;});await details.getByRole('button',{name:'重试详情',exact:true}).click();await expect(details.locator('.workflow-step')).toHaveCount(2);
 await details.getByText('查看步骤输出',{exact:true}).click();await expect(details.locator('pre')).toContainText('manual');await page.screenshot({path:testInfo.outputPath('workflow-run-detail.png')});
 await page.keyboard.press('Escape');await expect(details).toHaveCount(0);await expect(instance(page).getByRole('button',{name:'步骤详情',exact:true})).toBeFocused();expect(errors).toEqual([]);
});
test('状态筛选、拒绝审批和空结果恢复',async({page})=>{
 const errors=await install(page);await page.getByRole('combobox',{name:'筛选运行状态',exact:true}).selectOption('success');await expect(page.getByText('此状态下暂无运行记录',{exact:true})).toBeVisible();await page.getByRole('button',{name:'查看全部',exact:true}).click();
 await instance(page).getByRole('button',{name:'拒绝',exact:true}).click();await expect(instance(page)).toContainText('已拒绝审批');await expect(instance(page)).toContainText('已取消');
 await page.getByRole('combobox',{name:'筛选运行状态',exact:true}).selectOption('cancelled');await expect(page.locator('.workflow-instance')).toHaveCount(1);expect(errors).toEqual([]);
});
test('编辑失败保留草稿，保存成功但刷新失败也更新定义',async({page})=>{
 const errors=await install(page);await definition(page).getByRole('button',{name:'编辑',exact:true}).click();const form=dialog(page,'编辑工作流');await form.getByLabel('名称',{exact:true}).fill('改名后的维护流程');await page.evaluate(()=>{window.workflowFixture.failWrite=true;});
 await form.getByRole('button',{name:'保存',exact:true}).click();await expect(form.getByRole('alert')).toContainText('操作暂时无法受理');await expect(form.getByLabel('名称',{exact:true})).toHaveValue('改名后的维护流程');
 await page.evaluate(()=>{Object.assign(window.workflowFixture,{failWrite:false,failDefinitions:true});});await form.getByRole('button',{name:'保存',exact:true}).click();await expect(form).toHaveCount(0);await expect(definition(page)).toContainText('改名后的维护流程');await expect(page.locator('.workflow-success')).toContainText('工作流已保存');expect(errors).toEqual([]);
});
test('切换节点使迟到保存失效，返回后可以继续编辑',async({page})=>{
 const errors=await install(page);await definition(page).getByRole('button',{name:'编辑',exact:true}).click();await page.evaluate(()=>{window.workflowFixture.hold=true;});await dialog(page,'编辑工作流').getByRole('button',{name:'保存',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>!!window.workflowFixture.release)).toBe(true);await page.evaluate(()=>window.dispatchEvent(new CustomEvent('composeops:host-changed')));await expect(dialog(page,'编辑工作流')).toHaveCount(0);await release(page);await expect(page.locator('.workflow-success')).toHaveCount(0);await expect(definition(page).getByRole('button',{name:'编辑',exact:true})).toBeEnabled();expect(errors).toEqual([]);
});
test('缓存页离开暂停活动实例轮询，返回后恢复',async({page})=>{
 const errors=await install(page);await page.goto('./#/dashboard');await expect(page.getByRole('heading',{name:'运维总览',exact:true})).toBeVisible();const before=await page.evaluate(()=>window.workflowFixture.calls.filter(call=>call.path.endsWith('/instances')).length);
 await page.waitForTimeout(5500);expect(await page.evaluate(()=>window.workflowFixture.calls.filter(call=>call.path.endsWith('/instances')).length)).toBe(before);
 await page.goto('./#/workflows');await expect(page.locator('.workflow-instance')).toHaveCount(1);await expect.poll(()=>page.evaluate(()=>window.workflowFixture.calls.filter(call=>call.path.endsWith('/instances')).length)).toBeGreaterThan(before);expect(errors).toEqual([]);
});
test('320px 卡片和节点编辑清晰可用，无横向溢出',async({page},testInfo)=>{
 await page.setViewportSize({width:320,height:740});await page.emulateMedia({reducedMotion:'reduce'});const errors=await install(page);
 expect(await page.locator('.app-main').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await instance(page).scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('workflow-mobile-approval.png')});
 await definition(page).getByRole('button',{name:'编辑',exact:true}).click();const form=dialog(page,'编辑工作流');await form.getByLabel('第 3 个节点 ID',{exact:true}).scrollIntoViewIfNeeded();await expect(form.getByRole('button',{name:'保存',exact:true})).toBeInViewport();
 expect(await form.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('workflow-mobile-editor.png')});expect(errors).toEqual([]);
});

test('待审批筛选中通过后结果可见、焦点可继续操作',async({page},testInfo)=>{
 const errors=await install(page);await page.getByRole('combobox',{name:'筛选运行状态',exact:true}).selectOption('waiting_approval');
 await instance(page).getByRole('button',{name:'通过审批',exact:true}).click();const feedback=page.locator('.workflow-success');
 await expect(feedback).toContainText('已通过审批');await expect(feedback).toContainText('继续运行');await expect(feedback).toBeFocused();await expect(feedback).toBeInViewport();
 await expect(page.locator('.workflow-instance')).toHaveCount(0);await expect(page.getByRole('combobox',{name:'筛选运行状态',exact:true})).toHaveValue('waiting_approval');
 await page.screenshot({path:testInfo.outputPath('workflow-filter-feedback.png')});expect(errors).toEqual([]);
});
