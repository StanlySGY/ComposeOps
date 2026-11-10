import { randomUUID } from 'node:crypto';
import db from '../lib/db.js';
import { sreInsights } from './sre-insights.js';
import { listSreChanges } from './sre-changes.js';
import { listRecoveryRuns } from './sre-recovery.js';
import { listSreProfiles } from './sre-profiles.js';
import { probeStatistics } from './sre-probes.js';
import { listIncidents, getIncidentDetail, incidentError, safeIncidentData } from './incident-store.js';
import { getAiConfig, callOpenAI, fenceUntrusted, newFenceNonce, UNTRUSTED_GUARD } from './ai.js';
import { withReadTimeout } from './incident-observer.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';
const map = row => row && ({ id: row.id, createdAt: row.created_at, requestedBy: row.requested_by, status: row.status,
  evidence: JSON.parse(row.evidence_json), content: row.content ? JSON.parse(row.content) : null, error: row.error });
export function listSreRetrospectives() { return db.prepare('SELECT * FROM sre_retrospectives ORDER BY created_at DESC LIMIT 20').all().map(map); }
export function retrospectiveEvidence() {
  const now = Date.now(), sources = [{ id: 'summary', kind: 'statistics', at: now, data: sreInsights() }];
  for (const incident of listIncidents({ limit: 12 })) {
    const detail = getIncidentDetail(incident.id);
    sources.push({ id: 'incident:' + incident.id, kind: 'incident', sourceId: incident.id, at: incident.updatedAt,
      data: { status: incident.status, title: incident.title, openedAt: incident.openedAt, resolvedAt: incident.resolvedAt, closedAt: incident.closedAt,
        verification: incident.verification, evidence: detail.evidence.slice(0, 4).map(row => ({ id: row.id, summary: row.summary, at: row.observedAt })) } });
  }
  for (const change of listSreChanges().slice(0, 8)) sources.push({ id: 'change:' + change.id, kind: 'change', sourceId: change.id, at: change.updatedAt,
    data: { status: change.status, project: change.review.projectName, oldImage: change.review.old.imageId, newImage: change.review.next.imageId, error: change.error,
      forwardPassed: change.result.forwardVerification?.passed, rollbackPassed: change.result.rollbackVerification?.passed } });
  for (const run of listRecoveryRuns().slice(0, 8)) sources.push({ id: 'drill:' + run.id, kind: 'drill', sourceId: run.id, at: run.finishedAt || run.createdAt,
    data: { status: run.status, scope: run.result.scope, coveragePercent: run.result.coveragePercent, rtoMet: run.result.rtoMet, cleanupComplete: run.result.cleanupComplete,
      volumes: run.result.volumes, error: run.error } });
  for (const profile of listSreProfiles().slice(0, 10)) sources.push({ id: 'probe:' + profile.id, kind: 'probe', sourceId: profile.id, at: now,
    data: { project: profile.projectName, service: profile.serviceName, version: profile.version, ...probeStatistics(profile, now) } });
  return safeIncidentData({ generatedAt: now, selection: '统计涵盖最近 30 天；明细为最近 12 个故障、8 个变更、8 个演练和10 个应用目标，非全量因果分析', sources });
}
export async function createSreRetrospective(actor = 'admin', { call = callOpenAI, config = getAiConfig() } = {}) {
  if (!config.apiKey) throw incidentError('请先在设置中配置 AI 服务', 400);
  const now = Date.now();
  if (db.prepare("SELECT COUNT(*) AS n FROM sre_retrospectives WHERE status='generating' AND created_at>?").get(now - 120000).n >= 2) throw incidentError('已有两个复盘正在生成', 429);
  const id = 'srretro_' + randomUUID(), evidence = retrospectiveEvidence();
  db.prepare("INSERT INTO sre_retrospectives(id,created_at,requested_by,status,evidence_json) VALUES(?,?,?,'generating',?)").run(id, now, actor, JSON.stringify(evidence));
  try {
    const response = await withReadTimeout(call({ ...config, stream: false, messages: [
      { role: 'system', content: `你是可靠性复盘助手，只读分析，不执行动作或修改策略。输出严格 JSON：{"findings":[{"claim":"中文观测或假设，明确区分","evidenceIds":["来源ID"],"recommendation":"需要人工审阅的改进建议"}]}。最多 6 项，每项必须引用提供的来源 ID。不得编造根因、宣称未验证的业务恢复或把未知计为成功。${UNTRUSTED_GUARD}` },
      { role: 'user', content: fenceUntrusted('SRE_EVIDENCE', JSON.stringify(evidence), newFenceNonce()) },
    ] }), 90000);
    const parsed = JSON.parse(String(response.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    const known = new Set(evidence.sources.map(item => item.id));
    if (!Array.isArray(parsed.findings) || !parsed.findings.length || parsed.findings.length > 6) throw incidentError('AI 未返回有效的证据复盘');
    const findings = parsed.findings.map(item => {
      if (typeof item.claim !== 'string' || !item.claim.trim() || item.claim.length > 2000 || !Array.isArray(item.evidenceIds) || !item.evidenceIds.length || item.evidenceIds.length > 10 || item.evidenceIds.some(key => !known.has(key))) throw incidentError('AI 复盘引用了缺失或不存在的证据，结果未采纳');
      return { claim: item.claim, evidenceIds: [...new Set(item.evidenceIds)], recommendation: String(item.recommendation || '').slice(0, 2000) };
    });
    db.prepare("UPDATE sre_retrospectives SET status='ready',content=? WHERE id=?").run(JSON.stringify(safeIncidentData({ findings, interpretation: 'AI 分析与建议需要人工核验；引用证明来源存在，不等于推论已经成立。' })), id);
    recordAgentAuditEvent({ executionId: id, eventType: 'sre_retrospective_created', toolName: 'sre.retrospective', actor, decision: 'read_only', details: { evidenceIds: [...known] } });
  } catch (error) { db.prepare("UPDATE sre_retrospectives SET status='failed',error=? WHERE id=?").run(String(safeIncidentData(error.message)).slice(0, 1000), id); }
  return map(db.prepare('SELECT * FROM sre_retrospectives WHERE id=?').get(id));
}
