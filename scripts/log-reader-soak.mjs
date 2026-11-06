// Sustained UI/retention check against the offline preview, not a Docker network
// throughput benchmark. Real outage replay is covered by project-workspace-browser.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const seconds = Math.max(1, Number(process.env.LOG_SOAK_SECONDS) || 900);
const output = process.env.LOG_SOAK_OUTPUT || '/tmp/composeops-log-reader-soak.json';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true });
const started = Date.now();
const samples = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.PREVIEW_BASE_URL || 'http://127.0.0.1:4174/ComposeOps/#/services');
  await expect(page.locator('#project-knowledge-base')).toBeVisible();
  await page.evaluate(() => {
    const message = WebSocket.prototype.message;
    WebSocket.prototype.message = function (value) {
      if (this.url.includes('/ws/logs')) window.__soakSocket = this;
      return message.call(this, value);
    };
    location.hash = '/logs?projectId=knowledge-base&containerId=demo-wiki-api';
  });
  await expect.poll(() => page.evaluate(() => !!window.__soakSocket)).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  let sent = 0;
  let maxDom = 0;
  let maxBatchMs = 0;
  const injectionStart = Date.now();
  for (let segment = 0; segment < Math.ceil(seconds / 60); segment++) {
    const batches = Math.min(600, Math.ceil(seconds * 10) - segment * 600);
    await page.setViewportSize(segment % 2 ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const result = await page.evaluate(async ({ start, batches }) => {
      let sent = start, maxDom = 0, maxBatchMs = 0;
      for (let batch = 0; batch < batches; batch++) {
        const begin = performance.now();
        const ts = new Date().toISOString();
        for (let i = 0; i < 100; i++) window.__soakSocket.message({ type: 'stdout', containerId: 'demo-wiki-api', ts, data: `soak-${sent++}` });
        maxBatchMs = Math.max(maxBatchMs, performance.now() - begin);
        maxDom = Math.max(maxDom, document.querySelectorAll('[data-log-id]').length);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { sent, maxDom, maxBatchMs, overflow: document.documentElement.scrollWidth > innerWidth };
    }, { start: sent, batches });
    sent = result.sent; maxDom = Math.max(maxDom, result.maxDom); maxBatchMs = Math.max(maxBatchMs, result.maxBatchMs);
    assert.equal(result.overflow, false);
    await expect(page.getByText(`soak-${sent - 1}`, { exact: true })).toBeVisible();
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    samples.push({ seconds: (Date.now() - injectionStart) / 1000, sent, postGcHeap: heap.usedSize, dom: result.maxDom });
    assert.ok(maxDom < 100); assert.deepEqual(errors, []);
    writeFileSync(output, JSON.stringify({ status: 'running', sent, maxDom, maxBatchMs, samples, errors }, null, 2));
    console.log(JSON.stringify(samples.at(-1)));
  }
  await expect(page.getByText('仅保留最近 5000 条', { exact: true })).toBeVisible();
  await page.screenshot({ path: output.replace(/\.json$/, '.png') });
  const result = { status: 'passed', sent, durationSeconds: (Date.now() - injectionStart) / 1000, totalSeconds: (Date.now() - started) / 1000, maxDom, maxBatchMs, samples, errors };
  writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
