import { Buffer } from 'node:buffer';
import { test, expect } from '@playwright/test';
async function install(page,path='./#/agent') {
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('./#/dashboard');await expect(page.getByRole('heading',{name:'运维总览',exact:true})).toBeVisible();
 await page.evaluate(()=>{
  const original=window.fetch;
  const f=window.agentSessionFixture={rows:[{sessionId:1,title:'备份恢复验证',messageCount:2,createdAt:'2026-11-09 01:00:00'},{sessionId:2,title:'资源占用检查',messageCount:2,createdAt:'2026-11-09 02:00:00'},{sessionId:3,title:'配置更新审阅',messageCount:2,createdAt:'2026-11-09 03:00:00'}],calls:[],failList:false,failHistory:[],holdHistory:[],releases:{},failWrite:false,holdWrite:false,failOlder:false};
  window.fetch=async(input,init={})=>{
   const url=new URL(typeof input==='string'?input:input.url,location.href),path=url.pathname,method=init.method||'GET';
   if(!path.startsWith('/api/v1/ai/'))return original(input,init);
   const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}),body=init.body?JSON.parse(init.body):{};f.calls.push({path,method,body,query:url.search});
   if(method==='GET'){
    if(path==='/api/v1/ai/sessions')return f.failList?json({message:'会话列表暂时离线'},503):json({sessions:f.rows});
    if(path==='/api/v1/ai/history'){
     const id=Number(url.searchParams.get('sessionId')),before=url.searchParams.get('beforeId');
     if(f.holdHistory.includes(id))await new Promise(resolve=>{f.releases[id]=resolve;});
     if(f.failHistory.includes(id)||before&&f.failOlder)return json({message:before?'更早消息读取失败':'历史读取暂时不可用'},503);
     return json({messages:before?[{id:1,role:'user',content:'更早的恢复计划'},{id:2,role:'assistant',content:'逐项核对备份与恢复结果。\n\n'.repeat(30)}]:[{id:id*10,role:'user',content:`检查项目 ${id} 的运行情况`},{id:id*10+1,role:'assistant',content:`会话 ${id} 的检查结果\n\n- 容器状态可读取\n- 下一步：核对配置和最近日志`}],hasMore:!before});
    }
    if(path==='/api/v1/ai/agent/memories')return json({memories:[]});
    return original(input,init);
   }
   if(f.holdWrite)await new Promise(resolve=>{f.releaseWrite=resolve;});
   if(f.failWrite)return json({message:'当前无法保存，请重试'},503);
   if(method==='DELETE'&&path==='/api/v1/ai/history'){const id=Number(url.searchParams.get('sessionId'));f.rows=f.rows.filter(r=>r.sessionId!==id);return json({ok:true});}
   if(path.endsWith('/batch-delete')){f.rows=f.rows.filter(r=>!body.sessionIds.includes(r.sessionId));return json({ok:true,deleted:body.sessionIds.length});}
   if(method==='PATCH'&&path.startsWith('/api/v1/ai/agent/sessions/')){const row=f.rows.find(r=>r.sessionId===Number(path.split('/').at(-1)));row.title=body.title;return json({ok:true,title:row.title});}
   if(path==='/api/v1/ai/agent/sessions'){f.rows.unshift({sessionId:4,title:'新会话',messageCount:0,createdAt:'2026-11-09 03:30:00'});return json({sessionId:4});}
   if(path==='/api/v1/ai/agent/execute-stream')return new Response('data: '+JSON.stringify({type:'session_meta',userMessageId:99})+'\n\ndata: '+JSON.stringify({type:'done',content:'只读检查完成，未执行外部操作。'})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
   if(path==='/api/v1/ai/agent/compact')return json({compactedMessages:10,fallback:true});
   return original(input,init);
  };
 });
 await page.goto(path);await expect(page.getByRole('heading',{name:'AI 智能运维 Agent',exact:true})).toBeVisible();await expect(page.locator('.agent-markdown')).toContainText(path.includes('999')?'会话 999':'会话 1');return errors;
}
async function sidebar(page){
 if(!(await page.locator('.session-browser:visible').count()))await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
 return page.locator('.session-browser:visible');
}
async function select(page,name){const side=await sidebar(page);await side.getByRole('button',{name:new RegExp(name)}).filter({has:page.locator('.session-browser-title')}).click();}
async function releaseHistory(page,id){await page.evaluate(id=>{const f=window.agentSessionFixture;f.holdHistory=f.holdHistory.filter(v=>v!==id);f.releases[id]();},id);}
const input=page=>page.getByRole('textbox',{name:'向 Agent 发送消息',exact:true});

async function settle(page){await page.waitForFunction(()=>!document.querySelector('[class*="-enter-active"]'));}

test('列表失败保持会话可读，原地恢复后继续浏览',async({page},testInfo)=>{
 const errors=await install(page);const side=await sidebar(page);await settle(page);await page.screenshot({path:testInfo.outputPath('agent-session-browser.png')});await page.evaluate(()=>{window.agentSessionFixture.failList=true;});await side.getByRole('button',{name:'刷新会话列表'}).click();await expect(side.getByRole('alert')).toContainText('会话列表暂时离线');await expect(side.locator('.session-browser-row')).toHaveCount(3);await page.evaluate(()=>{window.agentSessionFixture.failList=false;});await side.getByRole('button',{name:'重试会话列表'}).click();await expect(side.getByRole('alert')).toHaveCount(0);expect(errors).toEqual([]);
});
test('快速切换会话时迟到历史不会覆盖新目标',async({page})=>{
 await install(page);await page.evaluate(()=>{window.agentSessionFixture.holdHistory=[2];});await select(page,'资源占用检查');await expect(page.getByText('正在恢复会话…',{exact:true})).toBeVisible();await select(page,'配置更新审阅');await expect(page.locator('.agent-markdown')).toContainText('会话 3');await releaseHistory(page,2);await expect(page.locator('.agent-markdown')).toContainText('会话 3');await expect(page).toHaveURL(/sessionId=3/);
});
test('历史失败给出恢复入口，草稿保留且不允许误发送',async({page})=>{
 const errors=await install(page);await page.evaluate(()=>{window.agentSessionFixture.failHistory=[2];});await select(page,'资源占用检查');await expect(page.getByRole('alert')).toContainText('历史读取暂时不可用');await expect(page.locator('.agent-message')).toHaveCount(0);await input(page).fill('保留这段排障问题');await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();await page.evaluate(()=>{window.agentSessionFixture.failHistory=[];});await page.getByRole('button',{name:'重试历史'}).click();await expect(page.locator('.agent-markdown')).toContainText('会话 2');await expect(input(page)).toHaveValue('保留这段排障问题');expect(errors).toEqual([]);
});
test('等待历史期间新建会话，旧消息不会重新出现',async({page})=>{
 await install(page);await page.evaluate(()=>{window.agentSessionFixture.holdHistory=[2];});await select(page,'资源占用检查');const side=await sidebar(page);await side.getByRole('button',{name:'新建会话',exact:true}).click();await expect(page.getByRole('heading',{name:'这是一段新的运维会话'})).toBeVisible();await releaseHistory(page,2);await expect(page.locator('.agent-message')).toHaveCount(0);await expect(page).not.toHaveURL(/sessionId=/);
});
test('桌面与手机均可重命名，错误保留草稿，提交不会重复',async({page},testInfo)=>{
 await install(page);const side=await sidebar(page);await side.getByRole('button',{name:'重命名会话 资源占用检查',exact:true}).click();await expect(side.getByRole('textbox',{name:'会话标题',exact:true})).toBeFocused();await side.getByRole('textbox',{name:'会话标题',exact:true}).fill('资源优化待办');await page.evaluate(()=>{window.agentSessionFixture.failWrite=true;});await side.getByRole('button',{name:'保存标题',exact:true}).click();await expect(side.getByRole('alert')).toContainText('当前无法保存');await expect(side.getByRole('textbox',{name:'会话标题',exact:true})).toHaveValue('资源优化待办');await settle(page);await page.screenshot({path:testInfo.outputPath('agent-rename-error.png')});await page.evaluate(()=>{window.agentSessionFixture.failWrite=false;window.agentSessionFixture.holdWrite=true;});await side.getByRole('button',{name:'保存标题',exact:true}).click();await expect(side.getByRole('button',{name:'保存中…',exact:true})).toBeDisabled();await page.evaluate(()=>{window.agentSessionFixture.holdWrite=false;window.agentSessionFixture.releaseWrite();});await expect(side.getByRole('button',{name:'重命名会话 资源优化待办',exact:true})).toBeVisible();expect(await page.evaluate(()=>window.agentSessionFixture.calls.filter(c=>c.method==='PATCH').length)).toBe(2);
});
test('删除失败保留目标，等待确认期间不能退出或重复执行',async({page},testInfo)=>{
 await install(page);const side=await sidebar(page);await side.getByRole('button',{name:'删除会话 资源占用检查',exact:true}).click();const dialog=page.getByRole('dialog',{name:'删除会话',exact:true});await expect(dialog).toContainText('资源占用检查');await page.evaluate(()=>{window.agentSessionFixture.failWrite=true;});await dialog.getByRole('button',{name:'删除会话',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('当前无法保存');await settle(page);await page.screenshot({path:testInfo.outputPath('agent-delete-error.png')});await page.evaluate(()=>{window.agentSessionFixture.failWrite=false;window.agentSessionFixture.holdWrite=true;});await dialog.getByRole('button',{name:'删除会话',exact:true}).click();await page.keyboard.press('Escape');await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeDisabled();await page.evaluate(()=>{window.agentSessionFixture.holdWrite=false;window.agentSessionFixture.releaseWrite();});await expect(dialog).toHaveCount(0);await expect(side.locator('.session-browser-row')).toHaveCount(2);
});
test('批量删除明确列出选中目标，当前会话删除后回到新会话',async({page})=>{
 await install(page);const side=await sidebar(page);await side.getByRole('checkbox',{name:'选择会话 备份恢复验证',exact:true}).check();await side.getByRole('checkbox',{name:'选择会话 配置更新审阅',exact:true}).check();await side.getByRole('button',{name:'删除 2 个',exact:true}).click();const dialog=page.getByRole('dialog',{name:'批量删除会话',exact:true});await expect(dialog).toContainText('备份恢复验证');await expect(dialog).toContainText('配置更新审阅');await dialog.getByRole('button',{name:'批量删除',exact:true}).click();await expect(dialog).toHaveCount(0);await expect((await sidebar(page)).locator('.session-browser-row')).toHaveCount(1);if(await page.getByRole('button',{name:'关闭会话列表',exact:true}).isVisible())await page.getByRole('button',{name:'关闭会话列表',exact:true}).click();await expect(page.getByRole('heading',{name:'这是一段新的运维会话'})).toBeVisible();
});
test('切换会话分别保留草稿，搜索空结果能够直接恢复',async({page})=>{
 await install(page);await input(page).fill('恢复结果仍需核对');await select(page,'资源占用检查');await expect(input(page)).toHaveValue('');await input(page).fill('资源检查的下一步');await select(page,'备份恢复验证');await expect(input(page)).toHaveValue('恢复结果仍需核对');await page.getByRole('textbox',{name:'搜索会话消息',exact:true}).fill('不匹配的词');await expect(page.getByRole('heading',{name:'当前已加载消息中没有匹配结果'})).toBeVisible();await page.locator('.agent-history-state').getByRole('button',{name:'清除搜索'}).click();await expect(page.locator('.agent-markdown')).toContainText('会话 1');
});
test('深链直接恢复列表之外的会话',async({page})=>{await install(page,'./#/agent?sessionId=999');await expect(page.locator('.agent-head-text')).toContainText('会话 #999');await expect(page).toHaveURL(/sessionId=999/);});
test('分页错误能够重试，插入更早消息保持阅读位置',async({page})=>{
 await install(page);await page.evaluate(()=>{window.agentSessionFixture.failOlder=true;});await page.getByRole('button',{name:'加载更早消息',exact:true}).click();await expect(page.getByRole('alert')).toContainText('更早消息读取失败');await page.evaluate(()=>{window.agentSessionFixture.failOlder=false;});await page.getByRole('button',{name:'加载更早消息',exact:true}).click();await expect(page.locator('.agent-message')).toHaveCount(4);await expect.poll(()=>page.locator('.agent-messages').evaluate(el=>el.scrollTop)).toBeGreaterThan(50);
});
test('更多菜单支持键盘和Esc，导出真实已加载消息',async({page})=>{
 await install(page);const trigger=page.getByRole('button',{name:'更多操作',exact:true});await trigger.click();await expect(page.getByRole('menuitem',{name:'导出已加载消息'})).toBeFocused();await page.keyboard.press('End');await expect(page.getByRole('menuitem',{name:'删除当前会话'})).toBeFocused();await page.keyboard.press('Escape');await expect(trigger).toBeFocused();await expect(page.getByRole('menu')).toHaveCount(0);await trigger.click();const downloadPromise=page.waitForEvent('download');await page.getByRole('menuitem',{name:'导出已加载消息'}).click();const download=await downloadPromise;expect(download.suggestedFilename()).toBe('composeops-session-1.md');const stream=await download.createReadStream();const parts=[];for await(const part of stream)parts.push(part);const text=Buffer.concat(parts).toString('utf8');expect(text).toContain('会话 1 的检查结果');expect(text).toContain('备份恢复验证');
});
test('320px会话侧栏与确认窗可读，IME回车不误发送',async({page},testInfo)=>{
 await page.setViewportSize({width:320,height:740});await install(page);await input(page).fill('中文输入中的问题');await input(page).dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229});expect(await page.evaluate(()=>window.agentSessionFixture.calls.filter(c=>c.path.endsWith('/execute-stream')).length)).toBe(0);const side=await sidebar(page);await expect(side.getByRole('button',{name:'重命名会话 备份恢复验证',exact:true})).toBeVisible();await side.getByRole('button',{name:'删除会话 备份恢复验证',exact:true}).click();const dialog=page.getByRole('dialog',{name:'删除会话',exact:true});await expect(dialog.getByRole('button',{name:'删除会话',exact:true})).toBeInViewport();await settle(page);await page.screenshot({path:testInfo.outputPath('agent-mobile-confirmation.png')});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);await dialog.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'关闭会话列表',exact:true}).click();await expect(page.getByRole('button',{name:'打开会话列表',exact:true})).toBeFocused();
});

test('历史读取途中离页再返回，重新恢复目标并隔离旧响应',async({page})=>{
 await install(page);await page.evaluate(()=>{window.agentSessionFixture.holdHistory=[2];});await select(page,'资源占用检查');await expect(page.getByText('正在恢复会话…',{exact:true})).toBeVisible();await page.evaluate(()=>{location.hash='#/services';});await expect(page.locator('.agent-chat')).toHaveCount(0);await page.evaluate(()=>{window.agentSessionFixture.holdHistory=[];location.hash='#/agent';});await expect(page.locator('.agent-markdown')).toContainText('会话 2');await releaseHistory(page,2);await expect(page.locator('.agent-markdown')).toContainText('会话 2');
});
