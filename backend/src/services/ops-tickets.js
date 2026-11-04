import { createHash, randomUUID } from 'node:crypto';
import db from '../lib/db.js';
import { redactSecretValue } from '../lib/secret-redactor.js';

const TICKET = new Set(['planning','ready','active','blocked','review','succeeded','failed','cancelled']);
const PRIORITY = new Set(['low','normal','high','urgent']);
const ASSIGNMENT = new Set(['assigned','running','waiting','blocked','handed_off','succeeded','failed','outcome_unknown','cancelled']);
const ROLES = new Set(['planner','executor','validator','incident_responder','manual']);
const SOURCES = new Set(['manual','agent-session','agent-plan','agent-task','workflow','batch-job']);
const POLICY = 'composeops-mandate-v1';
const TICKET_NEXT = { planning:['ready','active','blocked','cancelled'],ready:['active','blocked','cancelled'],active:['blocked','review','succeeded','failed','cancelled'],blocked:['planning','ready','active','cancelled'],review:['active','succeeded','failed','cancelled'],succeeded:[],failed:[],cancelled:[] };
const ASSIGNMENT_NEXT = { assigned:['running','waiting','blocked','outcome_unknown','cancelled','handed_off'],running:['waiting','blocked','succeeded','failed','outcome_unknown','cancelled','handed_off'],waiting:['running','blocked','succeeded','failed','outcome_unknown','cancelled','handed_off'],blocked:['assigned','running','outcome_unknown','cancelled','handed_off'],handed_off:[],succeeded:[],failed:[],outcome_unknown:[],cancelled:[] };
const fail = (message, code='invalid_ops_ticket', statusCode=400) => { throw Object.assign(new Error(message),{code,statusCode}); };
const id = (prefix) => prefix+'_'+randomUUID();
const now = () => new Date().toISOString();
const safe = (v,max,label,required=false) => {
  const s=String(v ?? '').trim();
  if(required && !s) fail(label+'不能为空');
  if(s.length>max) fail(label+'不能超过 '+max+' 个字符');
  return redactSecretValue(s);
};
const encoded = (v) => JSON.stringify(redactSecretValue(v ?? {}));
const decoded = (v,f={}) => { try { return JSON.parse(v ?? ''); } catch { return f; } };
const obj = (v,label,max=32000) => {
  if(v==null) return {};
  if(typeof v!=='object' || Array.isArray(v)) fail(label+'必须是对象');
  const out=redactSecretValue(v);
  if(Buffer.byteLength(JSON.stringify(out),'utf8')>max) fail(label+'过大');
  return out;
};
const arr = (v,label,max=30,itemMax=240) => {
  if(v==null) return [];
  if(!Array.isArray(v)||v.length>max) fail(label+'数组长度无效');
  return [...new Set(v.map(x=>safe(x,itemMax,label,true)).filter(Boolean))];
};
const toDate = (v,label) => { const n=Date.parse(v); if(!Number.isFinite(n)) fail(label+'不是有效日期'); return new Date(n).toISOString(); };
const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v;
const fingerprint = (v) => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');

function ticketRow(r){return {id:r.id,title:r.title,description:r.description,status:r.status,priority:r.priority,sourceType:r.source_type,sourceId:r.source_id||null,projectId:r.project_id||null,hostId:r.host_id||null,acceptanceCriteria:decoded(r.acceptance_json,[]),idempotencyKey:r.idempotency_key||null,createdBy:r.created_by,createdAt:r.created_at,updatedAt:r.updated_at};}
function mandateRow(r){return {id:r.id,ticketId:r.ticket_id,version:Number(r.version),status:r.status,scope:decoded(r.scope_json,{}),allowedActions:decoded(r.allowed_actions_json,[]),deniedActions:decoded(r.denied_actions_json,[]),approvalRules:decoded(r.approval_rules_json,{}),policyVersion:r.policy_version,fingerprint:r.fingerprint,issuedBy:r.issued_by,issuedAt:r.issued_at,expiresAt:r.expires_at,revokedAt:r.revoked_at,revokeReason:r.revoke_reason||''};}
function assignmentRow(r){return {id:r.id,ticketId:r.ticket_id,mandateId:r.mandate_id||null,sequence:Number(r.sequence),workerRole:r.worker_role,assignee:r.assignee||null,sourceType:r.source_type,sourceId:r.source_id||null,sessionId:r.session_id==null?null:Number(r.session_id),status:r.status,attempt:Number(r.attempt)||1,handoffSummary:r.handoff_summary||'',idempotencyKey:r.idempotency_key||null,createdAt:r.created_at,updatedAt:r.updated_at,startedAt:r.started_at,heartbeatAt:r.heartbeat_at,finishedAt:r.finished_at};}
function reportRow(r){return {id:r.id,ticketId:r.ticket_id,assignmentId:r.assignment_id||null,reportType:r.report_type,status:r.status,summary:r.summary,findings:decoded(r.findings_json,[]),evidence:decoded(r.evidence_json,[]),acceptanceCriteria:decoded(r.acceptance_json,[]),submittedBy:r.submitted_by,createdAt:r.created_at,decidedAt:r.decided_at,decisionNote:r.decision_note||''};}
function effectRow(r){return {id:r.id,ticketId:r.ticket_id,assignmentId:r.assignment_id||null,mandateId:r.mandate_id||null,mandateFingerprint:r.mandate_fingerprint||null,idempotencyKey:r.idempotency_key||null,effectType:r.effect_type,mode:r.mode,risk:r.risk,target:decoded(r.target_json,{}),payload:decoded(r.payload_json,{}),status:r.status,attempt:Number(r.attempt)||0,leaseOwner:r.lease_owner||null,leaseExpiresAt:r.lease_expires_at,approvedBy:r.approved_by||null,approvedAt:r.approved_at,startedAt:r.started_at,finishedAt:r.finished_at,result:decoded(r.result_json,{}),error:r.error||'',createdAt:r.created_at,updatedAt:r.updated_at};}
function requireTicket(ticketId){const r=db.prepare('SELECT * FROM ops_tickets WHERE id=?').get(String(ticketId||''));if(!r)fail('长期任务不存在','ops_ticket_not_found',404);return ticketRow(r);}
function activity(ticketId,type,details={},actor='admin'){db.prepare('INSERT INTO ops_ticket_events(id,ticket_id,event_type,actor,details_json) VALUES(?,?,?,?,?)').run(id('ote'),ticketId,type,safe(actor,80,'操作人')||'admin',encoded(details));}

export function createOpsTicket(input={},actor='admin'){
 const title=safe(input.title,200,'任务标题',true),description=safe(input.description,8000,'任务说明');
 const priority=PRIORITY.has(input.priority)?input.priority:'normal';
 const sourceType=['manual','event','inspection','agent','workflow'].includes(input.sourceType)?input.sourceType:'manual';
 const sourceId=safe(input.sourceId,160,'来源 ID'),projectId=safe(input.projectId,160,'项目 ID'),hostId=safe(input.hostId,160,'宿主 ID');
 const criteria=arr(input.acceptanceCriteria,'验收标准',20,400),key=safe(input.idempotencyKey,160,'幂等键');
 if(key){const old=db.prepare('SELECT * FROM ops_tickets WHERE idempotency_key=?').get(key);if(old)return {ticket:ticketRow(old),replayed:true};}
 const ticketId=id('opt');
 db.transaction(()=>{
  db.prepare("INSERT INTO ops_tickets(id,title,description,status,priority,source_type,source_id,project_id,host_id,acceptance_json,idempotency_key,created_by) VALUES(?,?,?,'planning',?,?,?,?,?,?,?,?)")
   .run(ticketId,title,description,priority,sourceType,sourceId||null,projectId||null,hostId||null,encoded(criteria),key||null,safe(actor,80,'操作人')||'admin');
  activity(ticketId,'ticket_created',{title,sourceType,sourceId,projectId,hostId},actor);
 })();
 return {ticket:requireTicket(ticketId),replayed:false};
}
export function listOpsTickets({status='',query='',limit=100}={}){
 const where=[],args=[];
 if(status){if(!TICKET.has(status))fail('任务状态无效');where.push('t.status=?');args.push(status);}
 const q=safe(query,120,'搜索条件');
 if(q){where.push('(t.title LIKE ? OR t.description LIKE ? OR t.project_id LIKE ? OR t.id LIKE ?)');args.push(...Array(4).fill('%'+q+'%'));}
 const sql="SELECT t.*,(SELECT COUNT(*) FROM ops_assignments a WHERE a.ticket_id=t.id) AS assignment_count,(SELECT COUNT(*) FROM ops_reports r WHERE r.ticket_id=t.id AND r.status='submitted') AS pending_reports,(SELECT COUNT(*) FROM ops_effects e WHERE e.ticket_id=t.id AND e.status IN ('awaiting_approval','queued','outcome_unknown')) AS attention_effects,(SELECT MAX(version) FROM ops_mandates m WHERE m.ticket_id=t.id AND m.status='active') AS active_mandate_version FROM ops_tickets t "+(where.length?'WHERE '+where.join(' AND '):'')+" ORDER BY CASE t.status WHEN 'blocked' THEN 0 WHEN 'review' THEN 1 WHEN 'active' THEN 2 WHEN 'ready' THEN 3 WHEN 'planning' THEN 4 ELSE 5 END,CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,t.updated_at DESC LIMIT ?";
 const tickets=db.prepare(sql).all(...args,Math.max(1,Math.min(Number(limit)||100,200))).map(r=>({...ticketRow(r),assignmentCount:Number(r.assignment_count),pendingReports:Number(r.pending_reports),attentionEffects:Number(r.attention_effects),activeMandateVersion:r.active_mandate_version==null?null:Number(r.active_mandate_version)}));
 const stats=db.prepare("SELECT SUM(CASE WHEN status IN ('planning','ready','active','blocked','review') THEN 1 ELSE 0 END) AS open,SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) AS review,SUM(CASE WHEN status IN ('succeeded','failed','cancelled') THEN 1 ELSE 0 END) AS terminal FROM ops_tickets").get();
 return {tickets,stats:Object.fromEntries(Object.entries(stats).map(([k,v])=>[k,Number(v)||0]))};
}
export function updateOpsTicket(ticketId,patch={},actor='admin'){
 const old=requireTicket(ticketId),title=patch.title===undefined?old.title:safe(patch.title,200,'任务标题',true),description=patch.description===undefined?old.description:safe(patch.description,8000,'任务说明'),priority=patch.priority===undefined?old.priority:String(patch.priority),status=patch.status===undefined?old.status:String(patch.status),criteria=patch.acceptanceCriteria===undefined?old.acceptanceCriteria:arr(patch.acceptanceCriteria,'验收标准',20,400);
 if(!PRIORITY.has(priority))fail('任务优先级无效');
 if(!TICKET.has(status)||(status!==old.status&&!TICKET_NEXT[old.status]?.includes(status)))fail('任务状态流转无效','ops_ticket_transition_invalid',409);
  if(status==='succeeded'&&!db.prepare("SELECT 1 FROM ops_reports WHERE ticket_id=? AND status='accepted' LIMIT 1").get(ticketId))fail('必须至少有一份通过人工验收的报告后才能标记任务成功','ops_ticket_report_required',409);
 db.transaction(()=>{db.prepare('UPDATE ops_tickets SET title=?,description=?,status=?,priority=?,acceptance_json=?,updated_at=? WHERE id=?').run(title,description,status,priority,encoded(criteria),now(),ticketId);activity(ticketId,'ticket_updated',{from:old.status,to:status,priority},actor);})();
 return requireTicket(ticketId);
}

function normalizeScope(v={}){const s={projectIds:arr(v.projectIds,'项目范围',100,160),hostIds:arr(v.hostIds,'宿主范围',100,160),resourceIds:arr(v.resourceIds,'资源范围',100,160)};if(!s.projectIds.length&&!s.hostIds.length&&!s.resourceIds.length)fail('Mandate 必须限定项目、宿主或资源范围');return s;}
function normalizeActions(v,label,required=false){const a=arr(v,label,50,120);if(a.some(x=>!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(x)))fail(label+'包含无效动作名称');if(required&&!a.length)fail(label+'至少需要一项');return a;}
function mandateCovers(m,effectType,target){
 if(m.status!=='active'||Date.parse(m.expiresAt)<=Date.now())fail('授权已失效或过期','mandate_inactive',403);
 if(m.deniedActions.includes('*')||m.deniedActions.includes(effectType))fail('动作被 Mandate 禁止','mandate_action_denied',403);
 if(!m.allowedActions.includes(effectType))fail('Mandate 未授权该动作','mandate_action_not_allowed',403);
 const dims=[['projectIds','projectId'],['hostIds','hostId'],['resourceIds','resourceId']].filter(([k])=>m.scope[k].length);
 if(!dims.length||dims.some(([k,t])=>!target[t]||!m.scope[k].includes(String(target[t]))))fail('目标资源不在 Mandate 范围内','mandate_scope_mismatch',403);
}
function assertEffectMandate(effect){
 if(effect.mode!=='execute'||!effect.mandate_id)fail('执行意图缺少 Mandate','mandate_not_found',403);
 const row=db.prepare('SELECT * FROM ops_mandates WHERE id=? AND ticket_id=?').get(effect.mandate_id,effect.ticket_id);
 if(!row)fail('原 Mandate 不存在','mandate_not_found',403);
 const mandate=mandateRow(row);
 if(mandate.fingerprint!==effect.mandate_fingerprint)fail('Mandate 快照已变化，必须重新提出执行意图','mandate_fingerprint_mismatch',409);
 mandateCovers(mandate,effect.effect_type,decoded(effect.target_json,{}));
 return mandate;
}
export function issueOpsMandate(ticketId,input={},actor='admin'){
 requireTicket(ticketId);
 const scope=normalizeScope(input.scope),allowed=normalizeActions(input.allowedActions,'允许动作',true),denied=normalizeActions(input.deniedActions,'禁止动作');
 const expiresAt=input.expiresAt?toDate(input.expiresAt,'授权到期时间'):new Date(Date.now()+7*86400000).toISOString();
 if(Date.parse(expiresAt)<=Date.now()||Date.parse(expiresAt)>Date.now()+90*86400000)fail('Mandate 到期时间必须在未来 90 天以内');
 const rules={humanApprovalRequired:true,approvalIsNotExecution:true};
 const fp=fingerprint({ticketId,scope,allowed,denied,rules,policyVersion:POLICY,expiresAt}),mid=id('omd');
 db.transaction(()=>{
  const version=Number(db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM ops_mandates WHERE ticket_id=?').get(ticketId).v)+1;
  const old=db.prepare("SELECT id FROM ops_mandates WHERE ticket_id=? AND status='active'").all(ticketId).map(r=>r.id);
  db.prepare("UPDATE ops_mandates SET status='revoked',revoked_at=?,revoke_reason='已被更高版本授权取代' WHERE ticket_id=? AND status='active'").run(now(),ticketId);
   for(const oldId of old){const changed=db.prepare("UPDATE ops_effects SET status='rejected',error='Mandate 已被更高版本取代，原执行意图必须重新审批',finished_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE mandate_id=? AND status IN ('awaiting_approval','queued','leased')").run(now(),now(),oldId);if(changed.changes)activity(ticketId,'effects_rejected_mandate_superseded',{mandateId:oldId,count:changed.changes});}
  db.prepare("INSERT INTO ops_mandates(id,ticket_id,version,status,scope_json,allowed_actions_json,denied_actions_json,approval_rules_json,policy_version,fingerprint,issued_by,expires_at) VALUES(?,?,?,'active',?,?,?,?,?,?,?,?)")
   .run(mid,ticketId,version,encoded(scope),encoded(allowed),encoded(denied),encoded(rules),POLICY,fp,safe(actor,80,'操作人')||'admin',expiresAt);
  activity(ticketId,'mandate_issued',{mandateId:mid,version,fingerprint:fp,superseded:old},actor);
 })();
 return getOpsMandate(ticketId,mid);
}
export function getOpsMandate(ticketId,mandateId){requireTicket(ticketId);const r=db.prepare('SELECT * FROM ops_mandates WHERE id=? AND ticket_id=?').get(mandateId,ticketId);return r?mandateRow(r):null;}
export function listOpsMandates(ticketId){requireTicket(ticketId);return db.prepare('SELECT * FROM ops_mandates WHERE ticket_id=? ORDER BY version DESC').all(ticketId).map(mandateRow);}
export function revokeOpsMandate(ticketId,mandateId,reason,actor='admin'){
 const m=getOpsMandate(ticketId,mandateId);if(!m)fail('Mandate 不存在','mandate_not_found',404);if(m.status!=='active')fail('只有生效的 Mandate 可以撤销','mandate_not_active',409);
 const note=safe(reason,500,'撤销原因',true);
 db.transaction(()=>{db.prepare("UPDATE ops_mandates SET status='revoked',revoked_at=?,revoke_reason=? WHERE id=? AND status='active'").run(now(),note,mandateId);const changed=db.prepare("UPDATE ops_effects SET status='rejected',error='Mandate 已撤销，原执行意图不得继续派发',finished_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE mandate_id=? AND status IN ('awaiting_approval','queued','leased')").run(now(),now(),mandateId);activity(ticketId,'mandate_revoked',{mandateId,reason:note,affectedEffects:changed.changes},actor);})();
 return getOpsMandate(ticketId,mandateId);
}

function nextAssignment(ticketId){return Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM ops_assignments WHERE ticket_id=?').get(ticketId).n)+1;}
export function createOpsAssignment(ticketId,input={},actor='admin'){
 requireTicket(ticketId);
 const role=String(input.workerRole||'manual'),sourceType=String(input.sourceType||'manual');
 if(!ROLES.has(role)||!SOURCES.has(sourceType))fail('执行角色或来源类型无效');
 const sourceId=safe(input.sourceId,160,'来源 ID');if(sourceType!=='manual'&&!sourceId)fail('关联已有执行记录时必须提供来源 ID');
 const sessionId=input.sessionId==null||input.sessionId===''?null:Number(input.sessionId);if(sessionId!==null&&(!Number.isSafeInteger(sessionId)||sessionId<1))fail('Session ID 无效');
 const assignee=safe(input.assignee,120,'执行人'),handoff=safe(input.handoffSummary,4000,'交接摘要'),key=safe(input.idempotencyKey,160,'幂等键'),previous=safe(input.replacesAssignmentId,160,'前序 Assignment ID'),mandateId=safe(input.mandateId,160,'Mandate ID');
 if(mandateId&&!db.prepare("SELECT 1 FROM ops_mandates WHERE id=? AND ticket_id=? AND status='active'").get(mandateId,ticketId))fail('Assignment 关联的 Mandate 无效','mandate_not_active',409);
 if(key){const old=db.prepare('SELECT * FROM ops_assignments WHERE ticket_id=? AND idempotency_key=?').get(ticketId,key);if(old)return {assignment:assignmentRow(old),replayed:true};}
 const aid=id('oas');let result;
 db.transaction(()=>{
  if(previous){const prev=db.prepare('SELECT * FROM ops_assignments WHERE id=? AND ticket_id=?').get(previous,ticketId);if(!prev)fail('需要交接的 Assignment 不存在','assignment_not_found',404);if(!['assigned','running','waiting','blocked'].includes(prev.status))fail('当前 Assignment 不可交接','assignment_not_handoffable',409);if(!handoff)fail('交接时必须提供交接摘要');db.prepare("UPDATE ops_assignments SET status='handed_off',handoff_summary=?,updated_at=?,finished_at=? WHERE id=?").run(handoff,now(),now(),previous);}
  const seq=nextAssignment(ticketId);
  db.prepare("INSERT INTO ops_assignments(id,ticket_id,mandate_id,sequence,worker_role,assignee,source_type,source_id,session_id,status,handoff_summary,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,'assigned',?,?)")
   .run(aid,ticketId,mandateId||null,seq,role,assignee||null,sourceType,sourceId||null,sessionId,previous?'接替 '+previous+'：'+handoff:handoff,key||null);
  activity(ticketId,previous?'assignment_handoff':'assignment_created',{assignmentId:aid,previousAssignmentId:previous||null,workerRole:role,sourceType,sourceId,sessionId,mandateId:mandateId||null},actor);
  result=assignmentRow(db.prepare('SELECT * FROM ops_assignments WHERE id=?').get(aid));
 })();
 return {assignment:result,replayed:false};
}
export function updateOpsAssignment(ticketId,assignmentId,patch={},actor='admin'){
 requireTicket(ticketId);const row=db.prepare('SELECT * FROM ops_assignments WHERE id=? AND ticket_id=?').get(assignmentId,ticketId);if(!row)fail('Assignment 不存在','assignment_not_found',404);
 const old=assignmentRow(row),status=patch.status===undefined?old.status:String(patch.status);
 if(!ASSIGNMENT.has(status)||(status!==old.status&&!ASSIGNMENT_NEXT[old.status]?.includes(status)))fail('Assignment 状态流转无效','assignment_transition_invalid',409);
 const summary=patch.handoffSummary===undefined?old.handoffSummary:safe(patch.handoffSummary,4000,'交接摘要'),terminal=['handed_off','succeeded','failed','outcome_unknown','cancelled'].includes(status);
 db.transaction(()=>{db.prepare('UPDATE ops_assignments SET status=?,handoff_summary=?,started_at=?,heartbeat_at=?,finished_at=?,updated_at=? WHERE id=?').run(status,summary,status==='running'?(old.startedAt||now()):old.startedAt,status==='running'?now():old.heartbeatAt,terminal?(old.finishedAt||now()):old.finishedAt,now(),assignmentId);activity(ticketId,'assignment_updated',{assignmentId,from:old.status,to:status,handoffSummary:summary},actor);})();
 return assignmentRow(db.prepare('SELECT * FROM ops_assignments WHERE id=?').get(assignmentId));
}
export function reconcileOpsAssignment(ticketId,assignmentId,outcome,note,actor='admin'){
 requireTicket(ticketId);const row=db.prepare('SELECT * FROM ops_assignments WHERE id=? AND ticket_id=?').get(assignmentId,ticketId);if(!row)fail('Assignment 不存在','assignment_not_found',404);
 if(row.status!=='outcome_unknown')fail('只有结果不确定的 Assignment 需要核对','assignment_not_unknown',409);
 if(!['succeeded','failed','cancelled'].includes(outcome))fail('核对结果无效');const verification=safe(note,2000,'核对说明',true);
 db.transaction(()=>{db.prepare('UPDATE ops_assignments SET status=?,handoff_summary=?,finished_at=?,updated_at=? WHERE id=?').run(outcome,verification,now(),now(),assignmentId);activity(ticketId,'assignment_reconciled',{assignmentId,outcome,note:verification},actor);})();
 return assignmentRow(db.prepare('SELECT * FROM ops_assignments WHERE id=?').get(assignmentId));
}
export function listOpsAssignments(ticketId){requireTicket(ticketId);return db.prepare('SELECT * FROM ops_assignments WHERE ticket_id=? ORDER BY sequence DESC').all(ticketId).map(assignmentRow);}

export function submitOpsReport(ticketId,input={},actor='admin'){
 const t=requireTicket(ticketId),assignmentId=safe(input.assignmentId,160,'Assignment ID');
 if(assignmentId&&!db.prepare('SELECT 1 FROM ops_assignments WHERE id=? AND ticket_id=?').get(assignmentId,ticketId))fail('报告关联的 Assignment 不属于该任务','assignment_not_found',404);
 const type=safe(input.reportType||'execution',40,'报告类型',true),summary=safe(input.summary,4000,'报告摘要',true),rawF=Array.isArray(input.findings)?input.findings:[];
 if(rawF.length>50)fail('报告发现项最多 50 条');
 const findings=rawF.map((x,i)=>{if(!x||typeof x!=='object'||Array.isArray(x))fail('第 '+(i+1)+' 条发现项格式无效');return {title:safe(x.title,200,'发现项标题',true),severity:['info','warning','danger'].includes(x.severity)?x.severity:'info',detail:safe(x.detail,2000,'发现项说明'),recommendation:safe(x.recommendation,1000,'建议')};});
 const rawE=Array.isArray(input.evidence)?input.evidence:[];if(rawE.length>100)fail('报告证据最多 100 条');
 const evidence=rawE.map((x,i)=>{if(!x||typeof x!=='object'||Array.isArray(x))fail('第 '+(i+1)+' 条证据格式无效');return {kind:safe(x.kind||'note',40,'证据类型',true),sourceId:safe(x.sourceId,240,'证据来源 ID'),observedAt:x.observedAt?toDate(x.observedAt,'证据时间'):now(),summary:safe(x.summary,1000,'证据摘要',true)};});
 const rid=id('orp');
 db.transaction(()=>{db.prepare("INSERT INTO ops_reports(id,ticket_id,assignment_id,report_type,status,summary,findings_json,evidence_json,acceptance_json,submitted_by) VALUES(?,?,?,?,'submitted',?,?,?,?,?)").run(rid,ticketId,assignmentId||null,type,summary,encoded(findings),encoded(evidence),encoded(t.acceptanceCriteria),safe(actor,80,'提交人')||'admin');db.prepare("UPDATE ops_tickets SET status=CASE WHEN status IN ('active','ready') THEN 'review' ELSE status END,updated_at=? WHERE id=?").run(now(),ticketId);activity(ticketId,'report_submitted',{reportId:rid,assignmentId:assignmentId||null,findings:findings.length,evidence:evidence.length},actor);})();
 return reportRow(db.prepare('SELECT * FROM ops_reports WHERE id=?').get(rid));
}
export function decideOpsReport(ticketId,reportId,accepted,note='',actor='admin'){
 requireTicket(ticketId);const row=db.prepare('SELECT * FROM ops_reports WHERE id=? AND ticket_id=?').get(reportId,ticketId);if(!row)fail('报告不存在','report_not_found',404);if(row.status!=='submitted')fail('报告已处理，不能重复决策','report_already_decided',409);
 const n=safe(note,2000,'验收意见');db.transaction(()=>{db.prepare('UPDATE ops_reports SET status=?,decided_at=?,decision_note=? WHERE id=?').run(accepted?'accepted':'rejected',now(),n,reportId);activity(ticketId,accepted?'report_accepted':'report_rejected',{reportId,note:n},actor);})();
 return reportRow(db.prepare('SELECT * FROM ops_reports WHERE id=?').get(reportId));
}
export function listOpsReports(ticketId){requireTicket(ticketId);return db.prepare('SELECT * FROM ops_reports WHERE ticket_id=? ORDER BY created_at DESC,rowid DESC').all(ticketId).map(reportRow);}

export function proposeOpsEffect(ticketId,input={},actor='admin'){
 requireTicket(ticketId);const effectType=safe(input.effectType,120,'动作类型',true);if(!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(effectType))fail('动作类型格式无效');
 const mode=String(input.mode||'suggest');if(!['observe','suggest','execute'].includes(mode))fail('执行模式无效');
 const risk=['low','medium','high','critical'].includes(input.risk)?input.risk:'medium',target=obj(input.target,'目标资源',8000),payload=obj(input.payload,'动作参数',32000);
 const assignmentId=safe(input.assignmentId,160,'Assignment ID');if(assignmentId&&!db.prepare('SELECT 1 FROM ops_assignments WHERE id=? AND ticket_id=?').get(assignmentId,ticketId))fail('Effect 关联的 Assignment 不属于该任务','assignment_not_found',404);
 const key=safe(input.idempotencyKey,160,'幂等键');if(key){const old=db.prepare('SELECT * FROM ops_effects WHERE ticket_id=? AND idempotency_key=?').get(ticketId,key);if(old)return {effect:effectRow(old),replayed:true};}
 let mandate=null;if(mode==='execute'){const mid=safe(input.mandateId,160,'Mandate ID',true),r=db.prepare('SELECT * FROM ops_mandates WHERE id=? AND ticket_id=?').get(mid,ticketId);if(!r)fail('执行类 Effect 必须引用本任务的 Mandate','mandate_not_found',403);mandate=mandateRow(r);mandateCovers(mandate,effectType,target);}
 const eid=id('oef'),status=mode==='execute'?'awaiting_approval':'proposed';
 db.transaction(()=>{db.prepare('INSERT INTO ops_effects(id,ticket_id,assignment_id,mandate_id,mandate_fingerprint,idempotency_key,effect_type,mode,risk,target_json,payload_json,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(eid,ticketId,assignmentId||null,mandate?.id||null,mandate?.fingerprint||null,key||null,effectType,mode,risk,encoded(target),encoded(payload),status);activity(ticketId,'effect_proposed',{effectId:eid,effectType,mode,risk,status,mandateId:mandate?.id||null},actor);})();
 return {effect:effectRow(db.prepare('SELECT * FROM ops_effects WHERE id=?').get(eid)),replayed:false};
}
export function approveOpsEffect(ticketId,effectId,actor='admin'){
 requireTicket(ticketId);const r=db.prepare('SELECT * FROM ops_effects WHERE id=? AND ticket_id=?').get(effectId,ticketId);if(!r)fail('Effect 不存在','effect_not_found',404);
 if(r.mode!=='execute'||r.status!=='awaiting_approval')fail('只有等待审批的执行意图可以批准','effect_not_approvable',409);
 const m=assertEffectMandate(r);
 db.transaction(()=>{db.prepare("UPDATE ops_effects SET status='queued',approved_by=?,approved_at=?,updated_at=? WHERE id=? AND status='awaiting_approval'").run(safe(actor,80,'审批人')||'admin',now(),now(),effectId);activity(ticketId,'effect_approved_queued',{effectId,mandateId:m.id,note:'审批只将意图加入持久化队列，不会执行外部副作用'},actor);})();
 return effectRow(db.prepare('SELECT * FROM ops_effects WHERE id=?').get(effectId));
}
export function cancelOpsEffect(ticketId,effectId,reason='',actor='admin'){
 requireTicket(ticketId);const r=db.prepare('SELECT * FROM ops_effects WHERE id=? AND ticket_id=?').get(effectId,ticketId);if(!r)fail('Effect 不存在','effect_not_found',404);
 if(!['proposed','awaiting_approval','queued'].includes(r.status))fail('Effect 已领取或执行中，不能直接取消','effect_not_cancellable',409);
 const note=safe(reason,1000,'取消原因');db.transaction(()=>{db.prepare("UPDATE ops_effects SET status='cancelled',error=?,finished_at=?,updated_at=? WHERE id=?").run(note,now(),now(),effectId);activity(ticketId,'effect_cancelled',{effectId,reason:note},actor);})();
 return effectRow(db.prepare('SELECT * FROM ops_effects WHERE id=?').get(effectId));
}
export function listOpsEffects(ticketId){requireTicket(ticketId);return db.prepare('SELECT * FROM ops_effects WHERE ticket_id=? ORDER BY created_at DESC,rowid DESC').all(ticketId).map(effectRow);}

function recoverInTransaction(stamp){
 const leases=db.prepare("SELECT id,ticket_id FROM ops_effects WHERE status='leased' AND lease_expires_at<=?").all(stamp);
 const running=db.prepare("SELECT id,ticket_id FROM ops_effects WHERE status='executing' AND lease_expires_at<=?").all(stamp);
 db.prepare("UPDATE ops_effects SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='leased' AND lease_expires_at<=?").run(stamp,stamp);
 db.prepare("UPDATE ops_effects SET status='outcome_unknown',error='执行租约到期，无法确认外部副作用是否完成；必须核对真实环境。',finished_at=?,updated_at=? WHERE status='executing' AND lease_expires_at<=?").run(stamp,stamp,stamp);
 for(const r of leases)activity(r.ticket_id,'effect_lease_requeued_before_execution',{effectId:r.id});
 for(const r of running)activity(r.ticket_id,'effect_outcome_unknown',{effectId:r.id,reason:'executing lease expired'});
 return {requeued:leases.length,outcomeUnknown:running.length};
}
export function recoverExpiredOpsEffects(at=Date.now()){return db.transaction(()=>recoverInTransaction(new Date(at).toISOString()))();}
export function claimNextOpsEffect(workerId,leaseSeconds=60){
 const owner=safe(workerId,120,'Worker ID',true),seconds=Math.max(10,Math.min(Number(leaseSeconds)||60,600));
 return db.transaction(()=>{
  recoverInTransaction(now());
  for(let scan=0;scan<200;scan++){
   const r=db.prepare("SELECT * FROM ops_effects WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get();
   if(!r)return null;
   try{assertEffectMandate(r);}catch(error){
    db.prepare("UPDATE ops_effects SET status='rejected',error=?,finished_at=?,updated_at=? WHERE id=? AND status='queued'").run(safe(error.message,2000,'校验错误'),now(),now(),r.id);
    activity(r.ticket_id,'effect_rejected_before_dispatch',{effectId:r.id,reason:error.code||'mandate_invalid'});
    continue;
   }
   const expires=new Date(Date.now()+seconds*1000).toISOString();
   const changed=db.prepare("UPDATE ops_effects SET status='leased',lease_owner=?,lease_expires_at=?,attempt=attempt+1,updated_at=? WHERE id=? AND status='queued'").run(owner,expires,now(),r.id);
   if(!changed.changes)return null;
   activity(r.ticket_id,'effect_claimed',{effectId:r.id,workerId:owner,leaseExpiresAt:expires});
   return effectRow(db.prepare('SELECT * FROM ops_effects WHERE id=?').get(r.id));
  }
  return null;
 })();
}
export function startOpsEffect(effectId,workerId){
 const owner=safe(workerId,120,'Worker ID',true),r=db.prepare('SELECT * FROM ops_effects WHERE id=?').get(effectId);if(!r)fail('Effect 不存在','effect_not_found',404);
 if(r.status!=='leased'||r.lease_owner!==owner||Date.parse(r.lease_expires_at||'')<=Date.now())fail('Effect 租约无效或过期','effect_lease_invalid',409);
 try{assertEffectMandate(r);}catch(error){db.transaction(()=>{db.prepare("UPDATE ops_effects SET status='rejected',error=?,finished_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='leased'").run(safe(error.message,2000,'校验错误'),now(),now(),effectId);activity(r.ticket_id,'effect_rejected_before_execution',{effectId,reason:error.code||'mandate_invalid'});})();throw error;}
 db.transaction(()=>{const changed=db.prepare("UPDATE ops_effects SET status='executing',started_at=?,updated_at=? WHERE id=? AND status='leased' AND lease_owner=?").run(now(),now(),effectId,owner);if(!changed.changes)fail('Effect 租约已失效','effect_lease_invalid',409);activity(r.ticket_id,'effect_execution_started',{effectId,workerId:owner});})();
 return effectRow(db.prepare('SELECT * FROM ops_effects WHERE id=?').get(effectId));
}
export function heartbeatOpsEffect(effectId,workerId,leaseSeconds=60){
 const owner=safe(workerId,120,'Worker ID',true),seconds=Math.max(10,Math.min(Number(leaseSeconds)||60,600)),r=db.prepare("SELECT * FROM ops_effects WHERE id=? AND lease_owner=? AND status IN ('leased','executing')").get(effectId,owner);
 if(!r||Date.parse(r.lease_expires_at||'')<=Date.now())fail('Effect 租约不存在或过期','effect_lease_invalid',409);
 const expires=new Date(Date.now()+seconds*1000).toISOString();db.prepare('UPDATE ops_effects SET lease_expires_at=?,updated_at=? WHERE id=?').run(expires,now(),effectId);
 return effectRow(db.prepare('SELECT * FROM ops_effects WHERE id=?').get(effectId));
}
export function completeOpsEffect(effectId,workerId,input={}){
 const owner=safe(workerId,120,'Worker ID',true),r=db.prepare('SELECT * FROM ops_effects WHERE id=?').get(effectId);if(!r)fail('Effect 不存在','effect_not_found',404);
 if(r.status!=='executing'||r.lease_owner!==owner||Date.parse(r.lease_expires_at||'')<=Date.now())fail('Effect 不属于该 Worker 的有效执行租约','effect_lease_invalid',409);
 const result=obj(input.result,'执行结果',32000),error=safe(input.error,2000,'执行错误'),status=input.success===true?'succeeded':'failed';
 db.transaction(()=>{db.prepare('UPDATE ops_effects SET status=?,result_json=?,error=?,finished_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?').run(status,encoded(result),error,now(),now(),effectId);activity(r.ticket_id,'effect_completed',{effectId,status,error});})();
 return effectRow(db.prepare('SELECT * FROM ops_effects WHERE id=?').get(effectId));
}
export function reconcileOpsEffect(ticketId,effectId,outcome,note,actor='admin'){
 requireTicket(ticketId);const r=db.prepare('SELECT * FROM ops_effects WHERE id=? AND ticket_id=?').get(effectId,ticketId);if(!r)fail('Effect 不存在','effect_not_found',404);
 if(r.status!=='outcome_unknown')fail('只有 outcome_unknown 的 Effect 可以核对','effect_not_unknown',409);if(!['succeeded','failed','cancelled'].includes(outcome))fail('核对结果无效');
 const verification=safe(note,2000,'核对说明',true);
 db.transaction(()=>{db.prepare('UPDATE ops_effects SET status=?,result_json=?,error=?,finished_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?').run(outcome,encoded({manuallyReconciled:true,note:verification}),verification,now(),now(),effectId);activity(ticketId,'effect_reconciled',{effectId,outcome,note:verification},actor);})();
 return effectRow(db.prepare('SELECT * FROM ops_effects WHERE id=?').get(effectId));
}
export function getOpsTicketDetail(ticketId){
 const ticket=requireTicket(ticketId);
 return {ticket,mandates:db.prepare('SELECT * FROM ops_mandates WHERE ticket_id=? ORDER BY version DESC').all(ticketId).map(mandateRow),
  assignments:db.prepare('SELECT * FROM ops_assignments WHERE ticket_id=? ORDER BY sequence DESC').all(ticketId).map(assignmentRow),
  reports:db.prepare('SELECT * FROM ops_reports WHERE ticket_id=? ORDER BY created_at DESC,rowid DESC').all(ticketId).map(reportRow),
  effects:db.prepare('SELECT * FROM ops_effects WHERE ticket_id=? ORDER BY created_at DESC,rowid DESC').all(ticketId).map(effectRow),
  activity:db.prepare('SELECT * FROM ops_ticket_events WHERE ticket_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(ticketId).map(r=>({id:r.id,ticketId:r.ticket_id,eventType:r.event_type,actor:r.actor,details:decoded(r.details_json,{}),createdAt:r.created_at}))};
}
