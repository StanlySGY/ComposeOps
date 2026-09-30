import { createHash, randomUUID } from 'node:crypto';
import { getSetting, setSetting } from '../lib/db.js';

const health = new Map();
const CHANNELS_KEY = 'ai.channels';
const DEFAULT_FIRST_TOKEN_MS = 30000;
const COOLDOWN_MS = 60000;

export function validateAiBaseUrl(value) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL 只支持 HTTP/HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('Base URL 不可包含账号、密码、查询参数或片段');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host.startsWith('169.254.') || host === '168.63.129.16' || host === 'metadata.google.internal') {
    throw new Error('Base URL 不允许指向云元数据端点');
  }
  return url.toString().replace(/\/+$/, '');
}

/** 旧单渠道按需映射；首次保存渠道列表时落库，不在读取设置时改写数据库。 */
export function readAiChannels(legacy) {
  const stored = getSetting(CHANNELS_KEY);
  if (stored !== null) {
    const channels = JSON.parse(stored);
    if (!Array.isArray(channels)) throw new Error('AI 渠道配置损坏');
    return channels;
  }
  return legacy.apiKey ? [{ id: 'legacy', name: '默认渠道', enabled: true, supportsTools: true,
    firstTokenTimeoutMs: DEFAULT_FIRST_TOKEN_MS, baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, model: legacy.model }] : [];
}

export function prepareAiChannels(input, previous) {
  if (!Array.isArray(input) || input.length > 12) throw new Error('最多配置 12 条 AI 渠道');
  const ids = new Set();
  return input.map((item) => {
    const id = item.id || randomUUID();
    if (!/^[\w-]{1,64}$/.test(id) || ids.has(id)) throw new Error('渠道 ID 无效或重复');
    ids.add(id);
    const old = previous.find((entry) => entry.id === id);
    const name = String(item.name || '').trim();
    const model = String(item.model || '').trim();
    if (!name || name.length > 80) throw new Error('渠道名称需要 1–80 个字符');
    if (!model || model.length > 200) throw new Error(`渠道「${name}」需要有效的模型名称`);
    const baseUrl = validateAiBaseUrl(item.baseUrl);
    if (baseUrl.length > 2048) throw new Error('Base URL 过长');
    const keyInput = String(item.apiKey || '').trim();
    const keepKey = !keyInput || (old?.apiKey && keyInput === `••••${old.apiKey.slice(-4)}`);
    if (keepKey && old?.apiKey && baseUrl !== validateAiBaseUrl(old.baseUrl)) {
      throw new Error(`渠道「${name}」的地址已变更，请重新填写该地址的 API Key`);
    }
    const apiKey = keepKey ? old?.apiKey || '' : keyInput;
    if (apiKey.length > 4096) throw new Error('API Key 过长');
    const enabled = item.enabled !== false;
    if (enabled && !apiKey) throw new Error(`渠道「${name}」尚未填写 API Key`);
    const firstTokenTimeoutMs = item.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_MS;
    if (!Number.isInteger(firstTokenTimeoutMs) || firstTokenTimeoutMs < 1000 || firstTokenTimeoutMs > 120000) {
      throw new Error('首段响应等待时间应为 1–120 秒');
    }
    return { id, name, baseUrl, apiKey, model, enabled, supportsTools: item.supportsTools !== false, firstTokenTimeoutMs };
  });
}

export function writeAiChannels(channels) {
  setSetting(CHANNELS_KEY, JSON.stringify(channels));
  const current = new Set(channels.map(healthKey));
  for (const key of health.keys()) if (!current.has(key)) health.delete(key);
}

function healthKey(channel) {
  return createHash('sha256').update(JSON.stringify([channel.id, channel.baseUrl, channel.apiKey, channel.model])).digest('hex');
}

function stateFor(channel) {
  const key = healthKey(channel);
  if (!health.has(key)) {
    if (health.size >= 200) health.delete(health.keys().next().value);
    health.set(key, { failures: 0, cooldownUntil: 0, lastError: '', lastSuccessAt: null, probing: false });
  }
  return health.get(key);
}

export function publicAiChannels(channels) {
  return channels.map((channel) => {
    const { probing, ...state } = stateFor(channel);
    return { ...channel, apiKey: channel.apiKey ? `••••${channel.apiKey.slice(-4)}` : '', hasApiKey: !!channel.apiKey,
      health: { ...state, status: !channel.enabled ? 'disabled' : probing ? 'probing' : state.cooldownUntil > Date.now() ? 'cooldown' : state.failures ? 'degraded' : state.lastSuccessAt ? 'healthy' : 'unknown' } };
  });
}

function errorDescription(error) {
  if (error.code === 'tool_unsupported') return '模型未返回测试工具调用，请检查模型能力或关闭工具调用选项';
  if (error.name === 'TimeoutError') return '等待模型响应超时';
  if (error.status === 401 || error.status === 403) return `鉴权或权限失败（${error.status}），请检查密钥`;
  if (error.status === 429) return '上游限流或额度不足（429）';
  if (error.status) return `上游请求失败（${error.status}）`;
  if (error.code === 'incomplete_stream') return '上游流式响应未完整结束';
  if (error.code === 'invalid_response') return '上游响应格式无效';
  return '无法连接上游服务';
}

function canRetry(error) {
  if (error.retryable === false) return false;
  if (error.status) return [401, 403, 404, 408, 429].includes(error.status) || error.status >= 500;
  return error.name === 'TimeoutError' || error.name === 'TypeError' || error.retryable === true;
}

/** 只重试一次模型请求；工具执行和已完成的 Tool Loop 轮次不在此作用域内。 */
export async function requestWithAiChannels(options, invoke) {
  const { signal, onChannelEvent, tools } = options;
  signal?.throwIfAborted();
  let channels = (options.channels || [{ ...options, id: 'direct', name: '当前渠道' }])
    .filter((item) => item.enabled !== false && item.apiKey && item.baseUrl);
  if (options.failoverEnabled === false) channels = channels.slice(0, 1);
  if (tools?.length) channels = channels.filter((item) => item.supportsTools !== false);
  if (!channels.length) throw new Error(tools?.length ? '没有已启用且支持工具调用的 AI 渠道' : '请先配置并启用 AI 渠道');
  const total = AbortSignal.timeout(options.totalTimeoutMs ?? 120000);
  const combined = signal ? AbortSignal.any([signal, total]) : total;
  const attempts = [];
  for (const channel of channels) {
    combined.throwIfAborted();
    const state = stateFor(channel);
    if (!options.probe && (state.cooldownUntil > Date.now() || state.probing)) {
      onChannelEvent?.({ type: 'channel_skipped', channelId: channel.id, channelName: channel.name, model: channel.model,
        content: `「${channel.name}」正在${state.probing ? '恢复探测' : '故障冷却'}，暂时跳过` });
      continue;
    }
    // 冷却后的首个请求充当半开探测，其余请求继续使用备用渠道。
    const halfOpen = state.cooldownUntil > 0;
    if (halfOpen) state.probing = true;
    const controller = new AbortController();
    const attemptSignal = AbortSignal.any([combined, controller.signal]);
    let timer;
    let emitted = false;
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException('等待模型响应超时', 'TimeoutError')), ms);
      timer.unref?.();
    };
    arm(channel.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_MS);
    const notify = (callback) => (value) => {
      if (value) emitted = true;
      callback?.(value);
    };
    onChannelEvent?.({ type: 'channel_selected', channelId: channel.id, channelName: channel.name, model: channel.model,
      content: `使用「${channel.name}」· ${channel.model}` });
    try {
      const result = await invoke({ ...options, ...channel, signal: attemptSignal,
        onActivity: () => arm(45000), onToken: notify(options.onToken), onReasoning: notify(options.onReasoning) });
      combined.throwIfAborted();
      Object.assign(state, { failures: 0, cooldownUntil: 0, lastError: '', lastSuccessAt: new Date().toISOString() });
      return { ...result, channelId: channel.id, channelName: channel.name, model: channel.model };
    } catch (caught) {
      if (signal?.aborted) throw signal.reason;
      const error = attemptSignal.aborted ? attemptSignal.reason : caught;
      const reason = errorDescription(error);
      state.lastError = reason;
      if (canRetry(error)) {
        state.failures++;
        const authFailure = [401, 403].includes(error.status);
        if (state.failures >= 2 || halfOpen || authFailure || error.status === 429) {
          state.cooldownUntil = Date.now() + (authFailure ? 300000 : Math.max(COOLDOWN_MS, Math.min(error.retryAfterMs || 0, 600000)));
        }
      }
      attempts.push(`「${channel.name}」${reason}`);
      if (emitted || !canRetry(error) || combined.aborted) {
        throw Object.assign(new Error(`${attempts.join('；')}${emitted ? '。回复已开始，为避免内容混合，本次未自动切换；已完成的工具操作不会重跑。' : ''}`), { status: error.status, partial: emitted });
      }
      onChannelEvent?.({ type: 'channel_failed', channelId: channel.id, channelName: channel.name, model: channel.model,
        content: `「${channel.name}」${reason}${options.failoverEnabled === false || options.probe ? '' : '，尝试后续可用渠道'}` });
    } finally {
      clearTimeout(timer);
      if (halfOpen) state.probing = false;
      controller.abort();
    }
  }
  throw new Error(attempts.length ? `AI 渠道均未成功：${attempts.join('；')}` : 'AI 渠道暂时都在故障冷却中，请稍后重试或在设置中测试连接');
}
