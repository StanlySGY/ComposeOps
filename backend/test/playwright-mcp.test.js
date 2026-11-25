import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlaywrightMcpBridge,
  playwrightMcpInternals,
  validatePublicWebUrl,
} from '../src/services/playwright-mcp.js';

const BASE = 'https://example.com/';

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function createFakeClient(handler) {
  const calls = [];
  let closeCount = 0;
  const client = {
    async callTool(request) {
      calls.push(request);
      return handler(request, calls);
    },
    async close() { closeCount += 1; },
  };
  return { connect: async () => client, calls, get closeCount() { return closeCount; } };
}

function metadataResult(url = BASE) {
  return textResult(JSON.stringify({
    url,
    title: 'Example Domain',
    description: 'Example description',
    links: [
      { title: 'Documentation', url: 'https://example.com/docs' },
      { title: 'Private link', url: 'http://127.0.0.1/admin' },
      { title: 'External link', url: 'https://outside.example.org/' },
    ],
  }));
}

test('Playwright MCP parses Microsoft browser_evaluate result envelopes', () => {
  const json = JSON.stringify({ title: 'Example Domain', url: 'https://example.com/' });
  const wrapped = '### Result\n' + JSON.stringify(json) + '\n### Ran Playwright code';
  assert.deepEqual(playwrightMcpInternals.jsonOf(textResult(wrapped)), JSON.parse(json));
});

test('Playwright MCP open navigates, snapshots, extracts safe links, and closes its MCP session', async () => {
  const fake = createFakeClient(({ name }) => {
    if (name === 'browser_snapshot') return textResult('- heading "Example Domain" [level=1]\n- link "Documentation" [ref=e1]');
    if (name === 'browser_evaluate') return metadataResult();
    return textResult('ok');
  });
  const bridge = createPlaywrightMcpBridge({
    connect: fake.connect,
    resolveUrl: async (value) => new URL(value),
  });

  const page = await bridge.open(BASE);

  assert.equal(page.rendered, true);
  assert.equal(page.title, 'Example Domain');
  assert.match(page.text, /Example Domain/);
  assert.equal(page.links.length, 2);
  assert.equal(page.links[0].url, 'https://example.com/docs');
  assert.equal(page.links[1].url, 'https://outside.example.org/');
  assert.equal(fake.calls[0].name, 'browser_navigate');
  assert.equal(fake.calls[0].arguments.url, BASE);
  assert.equal(fake.closeCount, 1);
});

test('Playwright MCP interaction keeps browser actions inside one session and preserves bounded click workflow', async () => {
  const fake = createFakeClient(({ name }) => {
    if (name === 'browser_snapshot') return textResult('- button "Refresh" [ref=e7]');
    if (name === 'browser_evaluate') return textResult(JSON.stringify({ tag: 'button', type: 'button', inForm: false }));
    return textResult('ok');
  });
  const bridge = createPlaywrightMcpBridge({
    connect: fake.connect,
    resolveUrl: async (value) => new URL(value),
  });

  const result = await bridge.interact(BASE, [{ type: 'click', role: 'button', name: 'Refresh' }]);

  assert.deepEqual(result.steps, [{ step: 1, type: 'click', ok: true }]);
  assert.ok(fake.calls.some((call) => call.name === 'browser_click' && call.arguments.target === 'e7'));
  assert.equal(fake.closeCount, 1);
});

test('Playwright MCP refuses form and submit buttons', async () => {
  const fake = createFakeClient(({ name }) => {
    if (name === 'browser_snapshot') return textResult('- button "Save" [ref=e2]');
    if (name === 'browser_evaluate') return textResult(JSON.stringify({ tag: 'button', type: 'submit', inForm: true }));
    return textResult('ok');
  });
  const bridge = createPlaywrightMcpBridge({ connect: fake.connect, resolveUrl: async (value) => new URL(value) });

  await assert.rejects(
    () => bridge.interact(BASE, [{ type: 'click', role: 'button', name: 'Save' }]),
    /不允许点击表单内或提交按钮/,
  );
  assert.equal(fake.calls.some((call) => call.name === 'browser_click'), false);
  assert.equal(fake.closeCount, 1);
});

test('Playwright MCP refuses cross-origin links even when their accessible name is unique', async () => {
  const fake = createFakeClient(({ name }) => {
    if (name === 'browser_snapshot') return textResult('- link "Continue" [ref=e3]');
    if (name === 'browser_evaluate') return textResult(JSON.stringify({ tag: 'a', href: 'https://attacker.example/path', target: '' }));
    return textResult('ok');
  });
  const bridge = createPlaywrightMcpBridge({ connect: fake.connect, resolveUrl: async (value) => new URL(value) });

  await assert.rejects(
    () => bridge.interact(BASE, [{ type: 'click', role: 'link', name: 'Continue' }]),
    /只允许点击当前站点内/,
  );
  assert.equal(fake.calls.some((call) => call.name === 'browser_click'), false);
});

test('Playwright MCP refuses credential fields and never types into them', async () => {
  const fake = createFakeClient(() => textResult('- textbox "Password" [ref=e4]'));
  const bridge = createPlaywrightMcpBridge({ connect: fake.connect, resolveUrl: async (value) => new URL(value) });

  await assert.rejects(
    () => bridge.interact(BASE, [{ type: 'fill', label: 'Password', value: 'not-a-secret' }]),
    /不允许自动填写密码/,
  );
  assert.equal(fake.calls.some((call) => call.name === 'browser_type'), false);
  assert.equal(fake.closeCount, 1);
});

test('Playwright MCP only fills plain text fields with autocomplete disabled', async () => {
  const fake = createFakeClient(({ name }) => {
    if (name === 'browser_snapshot') return textResult('- textbox "Search" [ref=e5]');
    if (name === 'browser_evaluate') return textResult(JSON.stringify({ tag: 'input', type: 'text', autocomplete: 'email' }));
    return textResult('ok');
  });
  const bridge = createPlaywrightMcpBridge({ connect: fake.connect, resolveUrl: async (value) => new URL(value) });

  await assert.rejects(
    () => bridge.interact(BASE, [{ type: 'fill', label: 'Search', value: 'hello' }]),
    /无自动补全/,
  );
  assert.equal(fake.calls.some((call) => call.name === 'browser_type'), false);
});

test('Playwright MCP selects by exact option label instead of passing untrusted option text as a selector', async () => {
  const fake = createFakeClient(({ name }) => {
    if (name === 'browser_snapshot') return textResult('- combobox "Region" [ref=e6]');
    if (name === 'browser_evaluate') return textResult(JSON.stringify({
      tag: 'select',
      labels: [{ label: 'West', value: 'west' }, { label: 'East', value: 'east' }],
    }));
    return textResult('ok');
  });
  const bridge = createPlaywrightMcpBridge({ connect: fake.connect, resolveUrl: async (value) => new URL(value) });

  await bridge.interact(BASE, [{ type: 'select', label: 'Region', option: 'West' }]);

  const select = fake.calls.find((call) => call.name === 'browser_select_option');
  assert.deepEqual(select.arguments, { target: 'e6', values: ['west'] });
});

test('Playwright MCP tracks temporary tab selection and closes the active tab by default', async () => {
  let count = 1;
  let active = 0;
  const fake = createFakeClient(({ name, arguments: args }) => {
    if (name === 'browser_tabs' && args.action === 'list') {
      const tabs = Array.from({ length: count }, (_, index) => '- ' + index + ': ' + (index === active ? '(current) ' : '') + '[Example](https://tab' + index + '.example/)').join('\n');
      return textResult('### Result\n' + tabs + '\n### Open tabs\n' + tabs + '\n### Ran Playwright code\n// tabs');
    }
    if (name === 'browser_tabs' && args.action === 'new') {
      count += 1;
      return textResult('created');
    }
    if (name === 'browser_tabs' && args.action === 'select') {
      active = args.index;
      return textResult('selected');
    }
    if (name === 'browser_tabs' && args.action === 'close') {
      count -= 1;
      active = Math.min(active, count - 1);
      return textResult('closed');
    }
    if (name === 'browser_snapshot') return textResult('- heading "Example"');
    if (name === 'browser_evaluate') return textResult(JSON.stringify({ url: BASE, title: 'Example', links: [] }));
    return textResult('ok');
  });
  const bridge = createPlaywrightMcpBridge({ connect: fake.connect, resolveUrl: async (value) => new URL(value) });

  const result = await bridge.interact(BASE, [
    { type: 'new_tab', url: 'https://second.example/' },
    { type: 'switch_tab', index: 0 },
    { type: 'switch_tab', index: 1 },
    { type: 'close_tab' },
  ]);

  assert.equal(result.tabCount, 1);
  assert.equal(result.activeTab, 0);
  assert.ok(fake.calls.some((call) => call.name === 'browser_tabs' && call.arguments.action === 'close' && call.arguments.index === 1));
});

test('Playwright MCP does not close the last browser tab', async () => {
  const fake = createFakeClient(({ name }) => {
    if (name === 'browser_tabs') return textResult('0: https://example.com/');
    return textResult('ok');
  });
  const bridge = createPlaywrightMcpBridge({ connect: fake.connect, resolveUrl: async (value) => new URL(value) });

  await assert.rejects(
    () => bridge.interact(BASE, [{ type: 'close_tab', index: 0 }]),
    /至少保留一个浏览器标签页/,
  );
  assert.equal(fake.calls.some((call) => call.name === 'browser_tabs' && call.arguments.action === 'close'), false);
});

test('Playwright MCP screenshot payload is size-bounded', async () => {
  const fake = createFakeClient(({ name }) => {
    if (name === 'browser_take_screenshot') return { content: [{ type: 'image', mimeType: 'image/jpeg', data: 'A'.repeat(120001) }] };
    if (name === 'browser_snapshot') return textResult('- heading "Example"');
    return textResult('ok');
  });
  const bridge = createPlaywrightMcpBridge({ connect: fake.connect, resolveUrl: async (value) => new URL(value) });

  await assert.rejects(
    () => bridge.interact(BASE, [{ type: 'screenshot' }]),
    /超过安全大小上限/,
  );
  assert.equal(fake.closeCount, 1);
});

test('Playwright MCP public URL validator rejects non-public DNS answers and local literals', async () => {
  await assert.rejects(
    () => validatePublicWebUrl('https://public.example', async () => [{ address: '10.0.0.8', family: 4 }]),
    /解析到本机或内网地址/,
  );
  await assert.rejects(() => validatePublicWebUrl('http://127.0.0.1/'), /不能访问本机或内网地址/);
  await assert.rejects(() => validatePublicWebUrl('http://[::1]/'), /不能访问本机或内网地址/);
  const publicUrl = await validatePublicWebUrl('https://public.example', async () => [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(publicUrl.href, 'https://public.example/');
  assert.equal(playwrightMcpInternals.publicIp('8.8.8.8'), true);
  assert.equal(playwrightMcpInternals.publicIp('192.168.1.2'), false);
});
