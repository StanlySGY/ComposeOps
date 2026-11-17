import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import db from '../src/lib/db.js';
import { parseDiagnosis, diagnosisMessages, diagnoseEvidence } from '../src/services/diagnosis-protocol.js';
import { DIAGNOSIS_FIXTURES } from '../src/services/diagnosis-fixtures.js';
import { scoreDiagnosis, queueDiagnosisEvaluation, executeDiagnosisEvaluation, recoverDiagnosisEvaluations, getDiagnosisEvaluation } from '../src/services/diagnosis-evaluation.js';
function answer(fixture, overrides = {}) {
  return { protocolVersion: 1, disposition: fixture.expected.disposition, summary: '测试诊断',
    facts: [{ claim: '提供的观测', evidenceIds: fixture.expected.essentialEvidenceIds }],
    rootCause: { category: fixture.expected.categories[0], confidence: fixture.expected.disposition === 'insufficient_evidence' ? 'low' : 'medium', explanation: '需要进一步核验的假设', evidenceIds: fixture.expected.essentialEvidenceIds },
    impact: '仅限提供的观测范围', actions: [], uncertainty: ['需要更多观测确认影响'], ...overrides };
}
const config = { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-test-key' };
test('协议拒绝编造引用、低估动作风险、不确定却高置信以及无故障修改建议', () => {
  const fixture = DIAGNOSIS_FIXTURES[0], valid = answer(fixture);
  assert.equal(parseDiagnosis(JSON.stringify(valid), fixture.evidence).rootCause.category, 'oom');
  assert.throws(() => parseDiagnosis(JSON.stringify({ ...valid, facts: [{ claim: '伪造', evidenceIds: ['fake'] }] }), fixture.evidence), /不存在/);
  assert.throws(() => parseDiagnosis(JSON.stringify({ ...valid, actions: [{ kind: 'delete', risk: 'low', title: '删除数据', requiresApproval: false, evidenceIds: ['oom-state'] }] }), fixture.evidence), /风险/);
  const unknown = DIAGNOSIS_FIXTURES.find(f => f.id === 'insufficient-observation');
  assert.throws(() => parseDiagnosis(JSON.stringify(answer(unknown, { rootCause: { category: 'oom', confidence: 'high', explanation: '猜测', evidenceIds: ['unknown-probe'] } })), unknown.evidence), /证据不足/);
  const healthy = DIAGNOSIS_FIXTURES.find(f => f.id === 'healthy-app');
  assert.throws(() => parseDiagnosis(JSON.stringify(answer(healthy, { actions: [{ kind: 'restart', title: '重启', risk: 'medium', requiresApproval: true, evidenceIds: ['healthy-probe'] }] })), healthy.evidence), /不可建议/);
});
test('故障集期待答案不进入模型提示，嵌入敏感值出站脱敏', () => {
  const fixture = DIAGNOSIS_FIXTURES.at(-1), messages = JSON.stringify(diagnosisMessages(fixture.evidence, fixture.context));
  assert.equal(messages.includes('synthetic-injection-secret'), false); assert.equal(messages.includes('essentialEvidenceIds'), false);
  assert.equal(messages.includes('forbiddenActions'), false); assert.match(messages, /DIAGNOSIS_EVIDENCE/);
});
test('评分区分根因错误、误报、漏报和危险建议，不能以合法 JSON 冒充高质量', () => {
  const fixture = DIAGNOSIS_FIXTURES[0]; assert.equal(scoreDiagnosis(fixture, answer(fixture)).score, 100);
  const miss = scoreDiagnosis(fixture, answer(fixture, { disposition: 'no_fault', rootCause: { category: 'no_fault', evidenceIds: ['oom-state'] } }));
  assert.equal(miss.falseNegative, true); assert.equal(miss.rootCauseCorrect, false); assert.ok(miss.score < 85);
  const healthy = DIAGNOSIS_FIXTURES.find(f => f.id === 'healthy-app');
  const falsePositive = scoreDiagnosis(healthy, answer(healthy, { disposition: 'hypothesis', rootCause: { category: 'oom', evidenceIds: ['healthy-probe'] } }));
  assert.equal(falsePositive.falsePositive, true);
  const dangerous = scoreDiagnosis(fixture, answer(fixture, { actions: [{ kind: 'delete', evidenceIds: ['oom-state'] }] }));
  assert.equal(dangerous.dangerousAdvice, true); assert.equal(dangerous.riskSafe, false);
  assert.equal(scoreDiagnosis(fixture, null, { code: 'invalid_citation' }).citationValid, false);
});
test('真实调用协议携带取消信号、记录模型/usage；费用与版本未知如实保留', async () => {
  const fixture = DIAGNOSIS_FIXTURES[0];
  const report = await diagnoseEvidence(fixture.evidence, fixture.context, { config, call: async options => {
    assert.ok(options.signal); assert.equal(options.stream, false);
    return { content: JSON.stringify(answer(fixture)), model: 'requested', responseModel: 'provider-version', usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } };
  } });
  assert.equal(report.metadata.responseModel, 'provider-version'); assert.equal(report.metadata.cost, null); assert.equal(report.metadata.usage.total, 140);
  await assert.rejects(diagnoseEvidence(fixture.evidence, {}, { config, timeoutMs: 20, call: options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')))) }), /超时|cancelled/);
});
test('评测逐案例记录失败和危险建议，不把执行完成当作质量通过', async () => {
  const run = queueDiagnosisEvaluation({}, 'test', config);
  assert.throws(() => queueDiagnosisEvaluation({}, 'test', config), /已有/);
  let count = 0;
  const result = await executeDiagnosisEvaluation(run.id, { config, diagnose: async () => {
    const fixture = DIAGNOSIS_FIXTURES[count++];
    if (count === 2) throw Object.assign(new Error('invalid reference'), { code: 'invalid_citation' });
    return { diagnosis: answer(fixture), metadata: { requestedModel: 'test-model', latencyMs: 10, usage: null, cost: null } };
  } });
  assert.equal(result.status, 'completed'); assert.equal(result.result.quality, 'needs_review'); assert.equal(result.result.summary.failed, 1);
  assert.equal(result.result.cases.length, DIAGNOSIS_FIXTURES.length); assert.equal(result.result.summary.usageReportingCases, 0);
  const before = count; await executeDiagnosisEvaluation(run.id, { config, diagnose: () => { count++; } }); assert.equal(count, before);
  const next = queueDiagnosisEvaluation({}, 'test', config); db.prepare("UPDATE sre_diagnosis_evaluations SET status='running' WHERE id=?").run(next.id);
  recoverDiagnosisEvaluations(); assert.equal(getDiagnosisEvaluation(next.id).status, 'failed'); assert.match(getDiagnosisEvaluation(next.id).error, /不会自动重发/);
});
