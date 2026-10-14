import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-notifications-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { enabledAlertEvents, getNotificationConfig, saveNotificationConfig, postJson } = await import('../src/services/notifications.js');

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

test('notifications: 临时 503 与网络错误会有界重试,成功后停止', async () => {
  let calls = 0;
  await postJson('http://notification.test/hook', { title: 'test' }, {}, {
    attempts: 3,
    baseDelayMs: 0,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response('temporary failure', { status: 503 });
      if (calls === 2) throw new TypeError('connection reset');
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(calls, 3);
});

test('notifications: real loopback webhook receives JSON and recovers after a 503 retry', async (t) => {
  let calls = 0;
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      calls++;
      requests.push({
        method: request.method,
        contentType: request.headers['content-type'],
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      if (calls === 1) response.writeHead(503, { 'Retry-After': '0' }).end('temporary outage');
      else response.writeHead(204).end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const payload = { event: 'redis-unhealthy', service: 'cache', timestamp: 'test-fixture' };
  await postJson(
    `http://127.0.0.1:${server.address().port}/hooks/composeops`,
    payload,
    { Authorization: 'Bearer local-fixture-token' },
    { attempts: 3, baseDelayMs: 0 },
  );
  assert.equal(calls, 2);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].contentType, 'application/json');
  assert.equal(requests[0].authorization, 'Bearer local-fixture-token');
  assert.deepEqual(requests[0].body, payload);
  assert.deepEqual(requests[1].body, payload);
});

test('notifications: 鉴权类 4xx 不重试,避免无效凭据重复投递', async () => {
  let calls = 0;
  await assert.rejects(postJson('http://notification.test/hook', {}, {}, {
    attempts: 4,
    baseDelayMs: 0,
    fetchImpl: async () => { calls++; return new Response('unauthorized', { status: 401 }); },
  }), /通知服务返回 401/);
  assert.equal(calls, 1);
});

test('notifications: honours Retry-After for rate-limited responses', async () => {
  let calls = 0;
  const delays = [];
  await postJson('http://notification.test/hook', {}, {}, {
    attempts: 3,
    baseDelayMs: 0,
    sleep: async (ms) => { delays.push(ms); },
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } })
        : new Response(null, { status: 204 });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
});

test('notifications: caller cancellation stops attempts without retry', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  let calls = 0;
  await assert.rejects(postJson('http://notification.test/hook', {}, {}, {
    signal: controller.signal,
    fetchImpl: async () => { calls++; return new Response(null, { status: 204 }); },
  }), /cancelled|aborted/i);
  assert.equal(calls, 0);
});

test('notifications: 触发事件默认三项,自定义勾选可持久化', () => {
  assert.deepEqual(enabledAlertEvents(null), ['exit', 'oom', 'unhealthy']);
  saveNotificationConfig({ events: ['oom'] });
  assert.deepEqual(enabledAlertEvents(getNotificationConfig(false)), ['oom']);
  assert.deepEqual(getNotificationConfig(true).events, ['oom']);
  // 空数组回退默认,避免"全不勾选"变成静默无告警的歧义状态
  saveNotificationConfig({ events: [] });
  assert.deepEqual(enabledAlertEvents(getNotificationConfig(false)), ['exit', 'oom', 'unhealthy']);
});
