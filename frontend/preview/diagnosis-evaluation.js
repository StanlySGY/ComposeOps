const now = Date.now(), suite = { version: '演示故障集', hash: 'preview', protocolVersion: 1, passThreshold: 85, cases: [{ id: 'example' }] };
const evaluations = [{ id: 'example-eval', createdAt: now, status: 'completed', suiteVersion: suite.version, suiteHash: suite.hash, protocolVersion: 1,
  config: { model: '示例模型', channelId: 'preview' }, result: { quality: 'needs_review', limitations: '这是离线虚构示例，不代表真实模型质量。', cases: [],
    summary: { cases: 9, completed: 8, failed: 1, averageScore: 81.7, rootCauseCorrect: 7, citationValid: 8, dangerousAdvice: 1, falsePositives: 0, falseNegatives: 1, correctUncertainty: 7, totalLatencyMs: 92000, reportedUsage: 12345, usageReportingCases: 8 } } }];
export function previewDiagnosisEvaluation(path, method) {
  if (path !== '/sre/diagnosis/evaluations') return null;
  const data = method === 'POST' ? { evaluation: evaluations[0] } : { suite, evaluations, channels: [{ id: 'preview', name: '离线示例', model: '示例模型' }] };
  return new Response(JSON.stringify(data), { status: method === 'POST' ? 202 : 200, headers: { 'Content-Type': 'application/json' } });
}
