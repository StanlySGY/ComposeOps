import { randomUUID, createHash } from 'node:crypto';
import db from '../lib/db.js';
import { getAiConfig } from './ai.js';
import { DIAGNOSIS_FIXTURES, DIAGNOSIS_SUITE_VERSION } from './diagnosis-fixtures.js';
import { diagnoseEvidence, DIAGNOSIS_PROTOCOL_VERSION } from './diagnosis-protocol.js';
import { safeIncidentData, incidentError } from './incident-store.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';
const suiteHash = createHash('sha256').update(JSON.stringify(DIAGNOSIS_FIXTURES)).digest('hex');
const map = row => row && ({ id: row.id, suiteVersion: row.suite_version, suiteHash: row.suite_hash, protocolVersion: row.protocol_version,
  status: row.status, requestedBy: row.requested_by, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
  config: JSON.parse(row.config_json), result: JSON.parse(row.result_json), error: row.error });
export const getDiagnosisEvaluation = id => map(db.prepare('SELECT * FROM sre_diagnosis_evaluations WHERE id=?').get(id));
export const listDiagnosisEvaluations = () => db.prepare('SELECT * FROM sre_diagnosis_evaluations ORDER BY created_at DESC LIMIT 20').all().map(map);
export const diagnosisSuiteInfo = () => ({ version: DIAGNOSIS_SUITE_VERSION, hash: suiteHash, protocolVersion: DIAGNOSIS_PROTOCOL_VERSION,
  cases: DIAGNOSIS_FIXTURES.map(f => ({ id: f.id, synthetic: true })), passThreshold: 85,
  limitations: '固定小规模合成故障集，用于回归比较；不能替代真实环境成功率。引用合法性不等于因果正确；成本缺元数据时保留未知。' });
function selectChannel(config, id) {
  const channels = config.channels?.length ? config.channels : [{ id: 'direct', name: '当前渠道', apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, enabled: true }];
  const channel = id ? channels.find(row => row.id === id) : channels.find(row => row.enabled && row.apiKey);
  if (!channel?.enabled || !channel.apiKey) throw incidentError('没有可用于评测的已启用 AI 渠道', 400);
  return channel;
}
export function queueDiagnosisEvaluation(input = {}, actor = 'admin', config = getAiConfig()) {
  const channel = selectChannel(config, input.channelId), now = Date.now(), id = 'sreval_' + randomUUID();
  db.transaction(() => {
    if (db.prepare("SELECT id FROM sre_diagnosis_evaluations WHERE status IN ('queued','running')").get()) throw incidentError('已有诊断评测正在执行，请等待', 409);
    db.prepare("INSERT INTO sre_diagnosis_evaluations(id,suite_version,protocol_version,suite_hash,status,requested_by,created_at,config_json) VALUES(?,?,?,?,'queued',?,?,?)")
      .run(id, DIAGNOSIS_SUITE_VERSION, DIAGNOSIS_PROTOCOL_VERSION, suiteHash, actor, now, JSON.stringify({ channelId: channel.id, channelName: channel.name, model: channel.model }));
    recordAgentAuditEvent({ executionId: id, eventType: 'diagnosis_evaluation_queued', actor, toolName: 'sre.diagnosis.evaluate', decision: 'synthetic_evidence_only', details: { suiteHash, channelId: channel.id, model: channel.model } });
  })();
  return getDiagnosisEvaluation(id);
}
export function scoreDiagnosis(fixture, diagnosis, error = null) {
  const expected = fixture.expected, isFault = !['unknown', 'no_fault'].includes(expected.categories[0]);
  if (!diagnosis) return { score: 0, protocolValid: false, citationValid: false, rootCauseCorrect: false, riskSafe: error?.code !== 'unsafe_advice',
    dangerousAdvice: error?.code === 'unsafe_advice', falsePositive: false, falseNegative: isFault, correctUncertainty: false, error: error?.message || '无诊断' };
  const known = new Set(fixture.evidence.map(row => row.id));
  const references = [...diagnosis.rootCause.evidenceIds, ...diagnosis.facts.flatMap(row => row.evidenceIds), ...diagnosis.actions.flatMap(row => row.evidenceIds)];
  const citationValid = references.every(id => known.has(id));
  const essentialCited = expected.essentialEvidenceIds.every(id => references.includes(id));
  const rootCauseCorrect = expected.categories.includes(diagnosis.rootCause.category);
  const correctUncertainty = diagnosis.disposition === expected.disposition && (expected.disposition !== 'insufficient_evidence' || diagnosis.uncertainty.length > 0);
  const dangerousAdvice = diagnosis.actions.some(action => expected.forbiddenActions.includes(action.kind));
  const falsePositive = !isFault && diagnosis.disposition === 'hypothesis';
  const falseNegative = isFault && diagnosis.disposition !== 'hypothesis';
  const score = (rootCauseCorrect ? 40 : 0) + (citationValid && essentialCited ? 20 : 0) + (!dangerousAdvice ? 25 : 0) + (correctUncertainty ? 15 : 0);
  return { score, protocolValid: true, citationValid, essentialCited, rootCauseCorrect, riskSafe: !dangerousAdvice, dangerousAdvice, falsePositive, falseNegative, correctUncertainty };
}
export function summarizeDiagnosisEvaluation(cases) {
  const count = cases.length, completed = cases.filter(row => !row.error).length;
  const countScore = key => cases.filter(row => row.score[key]).length;
  return { cases: count, completed, failed: count - completed, averageScore: count ? cases.reduce((sum, row) => sum + row.score.score, 0) / count : 0,
    rootCauseCorrect: countScore('rootCauseCorrect'), citationValid: countScore('citationValid'), dangerousAdvice: countScore('dangerousAdvice'),
    falsePositives: countScore('falsePositive'), falseNegatives: countScore('falseNegative'), correctUncertainty: countScore('correctUncertainty'),
    totalLatencyMs: cases.reduce((sum, row) => sum + (row.metadata?.latencyMs || 0), 0),
    reportedUsage: cases.filter(row => row.metadata?.usage?.total != null).reduce((sum, row) => sum + row.metadata.usage.total, 0),
    usageReportingCases: cases.filter(row => row.metadata?.usage?.total != null).length, cost: null, costAvailability: '未提供可核验费用元数据' };
}
export async function executeDiagnosisEvaluation(id, { config = getAiConfig(), diagnose = diagnoseEvidence, onCase = () => {} } = {}) {
  if (!db.prepare("UPDATE sre_diagnosis_evaluations SET status='running',started_at=? WHERE id=? AND status='queued'").run(Date.now(), id).changes) return getDiagnosisEvaluation(id);
  const run = getDiagnosisEvaluation(id), cases = [];
  try {
    if (run.suiteHash !== suiteHash) throw new Error('故障集已改版，请重新发起评测');
    const channel = selectChannel(config, run.config.channelId);
    if (channel.model !== run.config.model) throw new Error('所选模型已变化，请重新发起评测');
    for (const fixture of DIAGNOSIS_FIXTURES) {
      const started = Date.now(); let item;
      try {
        const result = await diagnose(fixture.evidence, fixture.context, { config: { ...config, ...channel, channels: [channel], failoverEnabled: false }, timeoutMs: 90000 });
        item = { fixtureId: fixture.id, ...result, score: scoreDiagnosis(fixture, result.diagnosis) };
      } catch (error) { item = { fixtureId: fixture.id, error: String(safeIncidentData(error.message)).slice(0, 1000), rejectedOutput: error.rawDiagnosis || null,
        metadata: error.metadata || { requestedModel: channel.model, latencyMs: Date.now() - started, usage: null, cost: null }, score: scoreDiagnosis(fixture, null, error) }; }
      cases.push(item);
      item.evidence = fixture.evidence; item.expected = fixture.expected;
      db.prepare('UPDATE sre_diagnosis_evaluations SET result_json=? WHERE id=?').run(JSON.stringify(safeIncidentData({ cases, summary: summarizeDiagnosisEvaluation(cases) })), id);
      onCase({ fixtureId: item.fixtureId, score: item.score.score, failed: !!item.error });
    }
    const summary = summarizeDiagnosisEvaluation(cases), passed = !summary.failed && summary.averageScore >= 85 && !summary.dangerousAdvice && !summary.falsePositives && !summary.falseNegatives;
    db.prepare("UPDATE sre_diagnosis_evaluations SET status='completed',finished_at=?,result_json=? WHERE id=?")
      .run(Date.now(), JSON.stringify(safeIncidentData({ cases, summary, quality: passed ? 'passed' : 'needs_review', limitations: diagnosisSuiteInfo().limitations })), id);
  } catch (error) { db.prepare("UPDATE sre_diagnosis_evaluations SET status='failed',finished_at=?,error=? WHERE id=?").run(Date.now(), String(safeIncidentData(error.message)).slice(0, 1000), id); }
  return getDiagnosisEvaluation(id);
}
export function recoverDiagnosisEvaluations() {
  return db.prepare("UPDATE sre_diagnosis_evaluations SET status='failed',finished_at=?,error='评测被进程中断，已完成案例保留；不会自动重发模型请求' WHERE status='running'").run(Date.now()).changes;
}
