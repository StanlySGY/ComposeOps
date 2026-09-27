import { getSetting, setSetting } from '../lib/db.js';

const CHANNEL_TYPES = ['bark', 'telegram', 'wecom', 'dingtalk', 'feishu', 'email', 'webhook'];

const DEFAULTS = {
  enabled: false,
  type: 'bark',
  endpoint: '',
  token: '',
  chatId: '',
  memoryThreshold: 90,
  dockerStorageThresholdGb: 50,
  intervalSeconds: 60,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: '',
  smtpPassword: '',
  emailFrom: '',
  emailTo: '',
  events: ['exit', 'oom', 'unhealthy'],
};

function blankChannel(type) {
  return {
    type,
    enabled: false,
    endpoint: '',
    token: '',
    chatId: '',
    smtpHost: '',
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: '',
    smtpPassword: '',
    emailFrom: '',
    emailTo: '',
  };
}

function clampChannel(channel) {
  const next = { ...channel };
  next.enabled = !!next.enabled;
  next.smtpPort = Math.max(1, Math.min(Number(next.smtpPort) || 465, 65535));
  next.smtpSecure = next.smtpSecure !== false;
  return next;
}

function channelFrom(source = {}, fallbackType = 'bark') {
  const type = CHANNEL_TYPES.includes(source.type) ? source.type : fallbackType;
  const next = blankChannel(type);
  for (const key of Object.keys(next)) {
    if (key === 'type') continue;
    if (source[key] !== undefined && source[key] !== 'configured') next[key] = source[key];
  }
  return clampChannel(next);
}

function assembleChannels(saved) {
  const stored = Array.isArray(saved.channels) ? saved.channels : null;
  if (!stored) {
    const legacy = channelFrom({ ...saved, enabled: true }, saved.type || 'bark');
    legacy.enabled = !!saved.enabled;
    return CHANNEL_TYPES.map((type) => (type === legacy.type ? legacy : blankChannel(type)));
  }
  return CHANNEL_TYPES.map((type) => {
    const found = stored.find((item) => item?.type === type);
    return found ? channelFrom(found, type) : blankChannel(type);
  });
}

function maskChannel(channel) {
  const copy = { ...channel };
  if (copy.token) copy.token = 'configured';
  if (copy.smtpPassword) copy.smtpPassword = 'configured';
  return copy;
}

export function getNotificationConfig(maskSecrets = false) {
  let saved = {};
  try { saved = JSON.parse(getSetting('notifications.config', '{}')); } catch { /* 坏配置按默认 */ }
  const config = { ...DEFAULTS, ...saved, channels: assembleChannels(saved) };
  if (maskSecrets) {
    if (config.token) config.token = 'configured';
    if (config.smtpPassword) config.smtpPassword = 'configured';
    config.channels = config.channels.map(maskChannel);
  }
  return config;
}

function mirrorPrimary(next) {
  const primary = next.channels.find((channel) => channel.enabled) || next.channels[0];
  if (!primary) return next;
  next.type = primary.type;
  const credential = primary.type === 'telegram' || primary.type === 'email';
  next.endpoint = credential ? '' : (primary.endpoint || '');
  next.token = primary.token || '';
  next.chatId = primary.chatId || '';
  next.smtpHost = primary.smtpHost || '';
  next.smtpPort = primary.smtpPort;
  next.smtpSecure = primary.smtpSecure;
  next.smtpUser = primary.smtpUser || '';
  next.smtpPassword = primary.smtpPassword || '';
  next.emailFrom = primary.emailFrom || '';
  next.emailTo = primary.emailTo || '';
  return next;
}

export function saveNotificationConfig(input = {}) {
  const current = getNotificationConfig(false);
  const next = { ...current };
  for (const key of Object.keys(DEFAULTS)) {
    if (input[key] !== undefined && input[key] !== 'configured') next[key] = input[key];
  }
  if (Array.isArray(input.channels)) {
    next.channels = CHANNEL_TYPES.map((type) => {
      const incoming = input.channels.find((item) => item?.type === type);
      const prev = current.channels.find((item) => item.type === type) || blankChannel(type);
      if (!incoming) return prev;
      const merged = channelFrom({ ...prev, ...incoming, type }, type);
      if (incoming.token === undefined || incoming.token === 'configured') merged.token = prev.token;
      if (incoming.smtpPassword === undefined || incoming.smtpPassword === 'configured') merged.smtpPassword = prev.smtpPassword;
      return merged;
    });
  } else {
    const type = CHANNEL_TYPES.includes(next.type) ? next.type : 'bark';
    next.channels = current.channels.map((channel) => {
      if (channel.type !== type) return { ...channel, enabled: false };
      const merged = channelFrom({
        ...channel,
        endpoint: next.endpoint,
        token: input.token === 'configured' ? channel.token : next.token,
        chatId: next.chatId,
        smtpHost: next.smtpHost,
        smtpPort: next.smtpPort,
        smtpSecure: next.smtpSecure,
        smtpUser: next.smtpUser,
        smtpPassword: input.smtpPassword === 'configured' ? channel.smtpPassword : next.smtpPassword,
        emailFrom: next.emailFrom,
        emailTo: next.emailTo,
        type,
        enabled: true,
      }, type);
      return merged;
    });
  }
  mirrorPrimary(next);
  if (!CHANNEL_TYPES.includes(next.type)) throw new Error('不支持的通知类型');
  next.memoryThreshold = Math.max(1, Math.min(Number(next.memoryThreshold) || 90, 100));
  next.dockerStorageThresholdGb = Math.max(1, Number(next.dockerStorageThresholdGb) || 50);
  next.intervalSeconds = Math.max(30, Math.min(Number(next.intervalSeconds) || 60, 3600));
  next.smtpPort = Math.max(1, Math.min(Number(next.smtpPort) || 465, 65535));
  setSetting('notifications.config', JSON.stringify(next));
  return getNotificationConfig(true);
}

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`通知服务返回 ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(type, config, title, body) {
  if (type === 'bark') {
    if (!config.endpoint) throw new Error('未配置 Bark 地址');
    await postJson(config.endpoint, { title, body, group: 'ComposeOps' });
  } else if (type === 'telegram') {
    if (!config.token || !config.chatId) throw new Error('未配置 Telegram Token/Chat ID');
    await postJson(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      chat_id: config.chatId,
      text: `${title}\n${body}`,
    });
  } else if (type === 'wecom') {
    if (!config.endpoint) throw new Error('未配置企业微信 Webhook');
    await postJson(config.endpoint, { msgtype: 'text', text: { content: `${title}\n${body}` } });
  } else if (type === 'dingtalk') {
    if (!config.endpoint) throw new Error('未配置钉钉 Webhook');
    await postJson(config.endpoint, { msgtype: 'text', text: { content: `${title}\n${body}` } });
  } else if (type === 'feishu') {
    if (!config.endpoint) throw new Error('未配置飞书 Webhook');
    await postJson(config.endpoint, { msg_type: 'text', content: { text: `${title}\n${body}` } });
  } else if (type === 'webhook') {
    if (!config.endpoint) throw new Error('未配置 Webhook');
    await postJson(config.endpoint, { title, body, source: 'ComposeOps', timestamp: new Date().toISOString() });
  } else if (type === 'email') {
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: !!config.smtpSecure,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
    });
    await transporter.sendMail({
      from: config.emailFrom || config.smtpUser,
      to: config.emailTo,
      subject: title,
      text: body,
    });
  } else {
    throw new Error('不支持的通知类型');
  }
}

function resolveChannel(channel, storedChannels) {
  const prev = storedChannels.find((item) => item.type === channel.type) || blankChannel(channel.type);
  const resolved = channelFrom({ ...prev, ...channel, type: channel.type }, channel.type);
  if (!channel.token || channel.token === 'configured') resolved.token = prev.token || '';
  if (!channel.smtpPassword || channel.smtpPassword === 'configured') resolved.smtpPassword = prev.smtpPassword || '';
  resolved.enabled = !!channel.enabled;
  return resolved;
}

export async function sendNotification(title, body, override = null) {
  const stored = getNotificationConfig(false);
  const config = override ? { ...stored, ...override, channels: stored.channels } : stored;
  if (!config.enabled && !override) return { skipped: true };
  if (override && override.enabled === false) return { skipped: true };
  const incoming = Array.isArray(override?.channels) ? override.channels : (override ? null : stored.channels);
  const enabled = (incoming || [{ ...config, type: config.type, enabled: true }])
    .filter((item) => item?.enabled)
    .map((item) => resolveChannel(item, stored.channels));
  if (!enabled.length) throw new Error('未启用任何通知渠道');
  const results = [];
  for (const channel of enabled) {
    try {
      await deliver(channel.type, { ...config, ...channel }, title, body);
      results.push({ type: channel.type, ok: true });
    } catch (error) {
      results.push({ type: channel.type, ok: false, error: error.message });
    }
  }
  if (!results.some((item) => item.ok)) {
    throw new Error(results.map((item) => `${item.type}: ${item.error}`).join('; '));
  }
  return { ok: true, results };
}
