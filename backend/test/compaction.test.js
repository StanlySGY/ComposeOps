import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCompactFacts, assembleFallback, buildCompactSummary, compactSummaryPrompt } from '../src/services/agent/compaction.js';

function buildMessages() {
  return [
    { id: 1, role: 'user', content: '帮我把 shop 项目重启一下,顺便看看为什么一直报 502' },
    { id: 2, role: 'assistant', content: '好的,我先查看项目状态。' },
    { id: 3, role: 'tool', content: JSON.stringify({ success: true, result: { exitCode: 0, output: 'restarted' } }) },
    { id: 4, role: 'tool', content: JSON.stringify({ success: false, error: 'upstream connect error (110: Connection timed out)' }) },
    { id: 5, role: 'assistant', content: '日志显示上游连接超时,建议检查 nginx 容器。\nError: upstream timed out while reading response header' },
  ];
}

test('compaction: extractCompactFacts 确定性提取目标/错误/项目', () => {
  const facts = extractCompactFacts(buildMessages());
  assert.equal(facts.userGoal, '帮我把 shop 项目重启一下,顺便看看为什么一直报 502');
  assert.ok(facts.projects.includes('shop'), '应提取项目名');
  assert.ok(facts.errorLines.some((line) => /timed out|connect error|Connection timed out/i.test(line)), '应收集错误行');
  assert.ok(facts.totalActive === 5);
});

test('compaction: assembleFallback 覆盖全部固定节且无模型也可用', () => {
  const facts = extractCompactFacts(buildMessages());
  const text = assembleFallback(facts);
  for (const section of ['## 目标', '## 用户近期诉求', '## 涉及资源', '## 错误与未解决问题', '## 下一步']) {
    assert.ok(text.includes(section), `缺节:${section}`);
  }
  assert.ok(text.includes('shop'));
});

test('compaction: buildCompactSummary 无 callModel 时回退确定性摘要', async () => {
  const { summary, fallback } = await buildCompactSummary(buildMessages());
  assert.equal(fallback, true);
  assert.ok(summary.includes('## 目标'));
});

test('compaction: callModel 正常产出被采纳;空产出/抛错回退', async () => {
  const good = await buildCompactSummary(buildMessages(), { callModel: async () => '## 目标\n重启 shop 项目并排查 502。\n## 下一步\n检查 nginx 上游。' });
  assert.equal(good.fallback, false);
  assert.ok(good.summary.startsWith('## 目标'));
  const empty = await buildCompactSummary(buildMessages(), { callModel: async () => '   ' });
  assert.equal(empty.fallback, true, '空产出回退');
  const thrown = await buildCompactSummary(buildMessages(), { callModel: async () => { throw new Error('api down'); } });
  assert.equal(thrown.fallback, true, '模型异常回退');
  assert.ok(thrown.summary.includes('## 目标'));
});

test('compaction: compactSummaryPrompt 声明不可信护栏', () => {
  const prompt = compactSummaryPrompt({ userGoal: 'x' });
  assert.ok(prompt.includes('不可信'), '摘要提示词须声明对话原文不可信');
});
