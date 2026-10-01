import { randomBytes } from 'node:crypto';
import { callOpenAI } from './ai.js';
import { recordAiChannelProbe } from './ai-channels.js';

/** 合成工具只在内存中回传随机值，不接触 Agent 工具或运维数据。 */
export async function testAiChannel(channel) {
  const started = Date.now();
  const signal = AbortSignal.timeout(60000);
  const checks = [];
  const nonce = randomBytes(8).toString('hex');
  const tool = (withArgument) => ({ type: 'function', function: {
    name: 'connection_probe', description: '连接测试，获取校验码，不执行实际操作',
    parameters: { type: 'object', properties: withArgument ? { nonce: { type: 'string', enum: [nonce] } } : {},
      required: withArgument ? ['nonce'] : [], additionalProperties: false },
  } });
  const invoke = (messages, tools, requiredTool) => callOpenAI({ channels: [{ ...channel, enabled: true }],
    failoverEnabled: false, probe: true, diagnostic: true, signal, totalTimeoutMs: 60000,
    stream: true, messages, tools, requiredTool });
  const failures = [];
  const step = async (id, label, work) => {
    if (failures.length) { checks.push({ id, label, status: 'skipped', message: '前一项未通过，尚未验证' }); return; }
    try { await work(); checks.push({ id, label, status: 'passed', message: '通过' }); }
    catch (error) { failures.push(error); checks.push({ id, label, status: 'failed', message: error.message }); }
  };
  if (!channel.supportsTools) {
    await step('chat', '聊天连接', async () => { await invoke([{ role: 'user', content: '请仅回复 OK。' }]); });
  } else {
    await step('arguments', '带参数工具调用', async () => {
      const result = await invoke([{ role: 'user', content: `请调用 connection_probe，nonce 必须为 ${nonce}。不要输出正文。` }], [tool(true)], 'connection_probe');
      if (result.toolCalls.length !== 1 || JSON.parse(result.toolCalls[0].function.arguments).nonce !== nonce) {
        throw new Error('已连接，但工具参数未遵循要求；请检查模型的工具能力');
      }
    });
    let emptyResult;
    const emptyMessages = [{ role: 'user', content: '请调用 connection_probe，参数为空对象。收到工具结果后，仅回复其中的 receipt 校验码。' }];
    await step('empty', '空参数工具调用', async () => {
      emptyResult = await invoke(emptyMessages, [tool(false)], 'connection_probe');
      const args = JSON.parse(emptyResult.toolCalls[0].function.arguments);
      if (emptyResult.toolCalls.length !== 1 || !args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).length) {
        throw new Error('已连接，但模型未返回空对象参数');
      }
    });
    await step('roundtrip', '工具结果回传', async () => {
      const receipt = randomBytes(8).toString('hex');
      const result = await invoke([...emptyMessages,
        { role: 'assistant', content: emptyResult.content || null, tool_calls: emptyResult.toolCalls },
        { role: 'tool', tool_call_id: emptyResult.toolCalls[0].id, content: JSON.stringify({ receipt }) },
      ], [tool(false)]);
      if (result.toolCalls.length || !result.content.includes(receipt)) throw new Error('工具调用成功，但模型未正确读取工具回传结果');
    });
  }
  const failure = failures[0];
  const ok = !failure;
  recordAiChannelProbe(channel, failure?.message || '');
  return { ok, latencyMs: Date.now() - started, model: channel.model, supportsTools: channel.supportsTools,
    mode: channel.streamToolCalls === false ? 'compatible' : 'stream', checks,
    suggestion: ok ? '' : failure.code === 'invalid_tool_arguments' && channel.streamToolCalls !== false
      ? '上游工具参数不完整。可在高级设置中切换「兼容模式」后保存并重测；无需先更换模型。'
      : '请根据失败项检查地址、密钥或模型能力；一次探测失败不等于模型完全不支持工具。' };
}
