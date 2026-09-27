import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-notifications-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { getNotificationConfig, saveNotificationConfig } = await import('../src/services/notifications.js');

test('notifications: 旧版 bark 配置只落到 bark 渠道', () => {
  saveNotificationConfig({ enabled: true, type: 'bark', endpoint: 'https://bark.example/push' });
  const config = getNotificationConfig(false);
  const bark = config.channels.find((channel) => channel.type === 'bark');
  const webhook = config.channels.find((channel) => channel.type === 'webhook');
  assert.equal(bark.endpoint, 'https://bark.example/push');
  assert.equal(bark.enabled, true);
  assert.equal(webhook.endpoint, '');
  assert.equal(webhook.enabled, false);
});

test('notifications: 两个渠道各自独立保存', () => {
  saveNotificationConfig({
    channels: [
      { type: 'bark', enabled: true, endpoint: 'https://bark.example/a' },
      { type: 'webhook', enabled: true, endpoint: 'https://hook.example/b' },
    ],
  });
  const config = getNotificationConfig(false);
  const bark = config.channels.find((channel) => channel.type === 'bark');
  const webhook = config.channels.find((channel) => channel.type === 'webhook');
  assert.equal(bark.endpoint, 'https://bark.example/a');
  assert.equal(bark.enabled, true);
  assert.equal(webhook.endpoint, 'https://hook.example/b');
  assert.equal(webhook.enabled, true);
});

test('notifications: 脱敏后的 token 再次保存不会覆盖真实值', () => {
  saveNotificationConfig({
    channels: [{ type: 'telegram', enabled: true, token: 'secret-token', chatId: '123' }],
  });
  const masked = getNotificationConfig(true);
  const telegram = masked.channels.find((channel) => channel.type === 'telegram');
  assert.equal(telegram.token, 'configured');
  saveNotificationConfig({ channels: [{ type: 'telegram', enabled: true, token: 'configured', chatId: '123' }] });
  const stored = getNotificationConfig(false);
  assert.equal(stored.channels.find((channel) => channel.type === 'telegram').token, 'secret-token');
});

test('notifications: 钉钉与飞书渠道保存且互不串扰', () => {
  saveNotificationConfig({
    channels: [
      { type: 'dingtalk', enabled: true, endpoint: 'https://oapi.dingtalk.com/robot/send?access_token=abc' },
      { type: 'feishu', enabled: true, endpoint: 'https://open.feishu.cn/open-apis/bot/v2/hook/xyz' },
      { type: 'wecom', enabled: false },
    ],
  });
  const config = getNotificationConfig(false);
  const dingtalk = config.channels.find((channel) => channel.type === 'dingtalk');
  const feishu = config.channels.find((channel) => channel.type === 'feishu');
  const wecom = config.channels.find((channel) => channel.type === 'wecom');
  assert.equal(dingtalk.enabled, true);
  assert.match(dingtalk.endpoint, /access_token=abc/);
  assert.equal(feishu.enabled, true);
  assert.match(feishu.endpoint, /hook\/xyz/);
  assert.equal(wecom.enabled, false);
  // 新渠道加入后,旧渠道(bark/webhook)配置不丢
  assert.equal(config.channels.find((channel) => channel.type === 'bark').endpoint, 'https://bark.example/a');
});
