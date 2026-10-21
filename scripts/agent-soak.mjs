#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULTS = {
  durationSeconds: 300, workers: 4, sampleIntervalMs: 5000, warmupSeconds: 10,
  requestsPerMinute: 120, slowEvery: 23, cancelEvery: 17, slowPayloadKiB: 64,
  slowDelayMs: 200, maxRssGrowthMiB: 256, maxFdGrowth: 48,
  maxAverageCpuPercent: 200, maxEventLoopP95Ms: 250,
};

function parseArgs(argv) {
  const config = { ...DEFAULTS, reportFile: null };
  const keys = {
    'duration-seconds': 'durationSeconds', workers: 'workers',
    'sample-interval-ms': 'sampleIntervalMs', 'warmup-seconds': 'warmupSeconds',
    'requests-per-minute': 'requestsPerMinute', 'slow-every': 'slowEvery',
    'cancel-every': 'cancelEvery', 'slow-payload-kib': 'slowPayloadKiB',
    'slow-delay-ms': 'slowDelayMs', 'max-rss-growth-mib': 'maxRssGrowthMiB',
    'max-fd-growth': 'maxFdGrowth', 'max-average-cpu-percent': 'maxAverageCpuPercent',
    'max-event-loop-p95-ms': 'maxEventLoopP95Ms',
  };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      console.log([
        'Usage: npm run test:agent-soak -- [options]',
        '',
        '  --duration-seconds=N       Duration, default 300; maximum 43200',
        '  --workers=N                Concurrent clients, default 4',
        '  --sample-interval-ms=N     Resource sampling interval, default 5000',
        '  --warmup-seconds=N         Warmup ignored for growth limits, default 10',
        '  --requests-per-minute=N    Global request-start budget, default 120',
        '  --slow-every=N             Pause slow reader every N requests, default 23',
        '  --cancel-every=N           Disconnect client every N requests, default 17',
        '  --slow-payload-kib=N       Slow-reader response size, default 64 KiB',
        '  --slow-delay-ms=N          Pause before reading, default 200',
        '  --max-rss-growth-mib=N     RSS growth limit, default 256 MiB',
        '  --max-fd-growth=N          File descriptor growth limit, default 48',
        '  --max-average-cpu-percent=N CPU limit (100% = one core), default 200',
        '  --max-event-loop-p95-ms=N  Event-loop p95 limit, default 250 ms',
        '  --report-file=PATH      Write the JSON result to a file with mode 0600',
        '',
        'Formal example: --duration-seconds=14400 --workers=4 --report-file=soak-report.json',
      ].join('\n'));
      process.exit(0);
    }
    if (raw.startsWith('--report-file=')) {
      const reportFile = raw.slice('--report-file='.length).trim();
      if (!reportFile || reportFile.includes('\0')) throw new Error('--report-file requires a valid path');
      config.reportFile = path.resolve(reportFile);
      continue;
    }
    const match = /^--([a-z0-9-]+)(?:=(.+))?$/.exec(raw);
    if (!match || !(match[1] in keys)) throw new Error('Unknown option: ' + raw);
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid numeric option: ' + raw);
    config[keys[match[1]]] = value;
  }
  const integerKeys = ['durationSeconds', 'workers', 'sampleIntervalMs', 'warmupSeconds',
    'requestsPerMinute', 'slowEvery', 'cancelEvery', 'slowPayloadKiB', 'slowDelayMs',
    'maxRssGrowthMiB', 'maxFdGrowth', 'maxEventLoopP95Ms'];
  for (const key of integerKeys) assert.ok(Number.isInteger(config[key]), key + ' must be an integer');
  assert.ok(config.durationSeconds >= 5 && config.durationSeconds <= 43200, 'duration-seconds must be in 5..43200');
  assert.ok(config.workers >= 1 && config.workers <= 32, 'workers must be in 1..32');
  assert.ok(config.sampleIntervalMs >= 250 && config.sampleIntervalMs <= 60000, 'sample-interval-ms must be in 250..60000');
  assert.ok(config.warmupSeconds < config.durationSeconds, 'warmup-seconds must be shorter than duration-seconds');
  assert.ok(config.requestsPerMinute >= 1 && config.requestsPerMinute <= 600, 'requests-per-minute must be in 1..600');
  assert.ok(config.slowEvery >= 0 && config.cancelEvery >= 0, 'slow-every and cancel-every must be zero or positive');
  assert.ok(config.slowPayloadKiB >= 1 && config.slowPayloadKiB <= 128, 'slow-payload-kib must be in 1..128');
  assert.ok(config.slowDelayMs <= 10000, 'slow-delay-ms must be <= 10000');
  assert.ok(config.maxRssGrowthMiB >= 0 && config.maxFdGrowth >= 0 && config.maxAverageCpuPercent >= 0 && config.maxEventLoopP95Ms >= 0, 'resource thresholds must be non-negative');
  return config;
}

const config = parseArgs(process.argv.slice(2));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-agent-soak-'));
process.env.DB_PATH = path.join(tempDir, 'soak.db');
process.env.ENABLE_SHELL = '0';
// Never use the operator database or any production encryption key in this disposable harness.
delete process.env.DB_ENCRYPTION_KEY;
delete process.env.DB_ENCRYPTION_KEY_FILE;

const modelBase = 'http://composeops-soak-model.test/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const counters = {
  scheduled: 0, completed: 0, clientDisconnects: 0, slowClients: 0,
  streamedEvents: 0, responseBytes: 0, modelCalls: 0, modelAborts: 0, failures: [],
};
const resourceSamples = [];
const cpuSamples = [];
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
let app;
let db;
const originalFetch = globalThis.fetch;
let resetBackgroundTasks;
let agent;
let base;
let cookie;
let samplerStop = false;
let testStartedAt = performance.now();
let deadline = 0;
let nextSlotAt = 0;
let requestSequence = 0;
let lastCheckpointAt = 0;
let stopReason = null;
let resourceBaseline = null;
let peakRssMiB = 0;
let peakFds = null;
let lastCpuUsage = process.cpuUsage();
let lastCpuSampleAt = performance.now();
let lastResourceSampleAt = performance.now();

function fdCount() {
  try { return fs.readdirSync('/proc/self/fd').length; } catch { return null; }
}

function makeModelResponse(content, chunkSize, signal) {
  const frames = [];
  for (let index = 0; index < content.length; index += chunkSize) {
    frames.push('data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(index, index + chunkSize) } }] }) + '\n\n');
  }
  frames.push('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n', 'data: [DONE]\n\n');
  let position = 0;
  let streamController;
  let aborted = false;
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  const onAbort = () => {
    aborted = true;
    counters.modelAborts++;
    try { streamController?.error(new DOMException('Soak request aborted', 'AbortError')); } catch { /* stream already closed */ }
  };
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    },
    async pull(controller) {
      await delay(1);
      if (aborted || signal?.aborted) {
        cleanup();
        try { controller.error(new DOMException('Soak request aborted', 'AbortError')); } catch { /* already errored */ }
        return;
      }
      if (position >= frames.length) {
        cleanup();
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frames[position++]));
    },
    cancel() { cleanup(); },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

function syntheticClientIp(sequence) {
  // Reserved TEST-NET-1 addresses simulate distinct clients inside the disposable test server.
  return '192.0.2.' + (((sequence - 1) % 254) + 1);
}

async function takeRequestSlot() {
  if (samplerStop || performance.now() >= deadline) return null;
  const intervalMs = 60000 / config.requestsPerMinute;
  const now = performance.now();
  const scheduledAt = Math.max(now, nextSlotAt);
  nextSlotAt = scheduledAt + intervalMs;
  if (scheduledAt >= deadline) return null;
  const sequence = ++requestSequence;
  counters.scheduled++;
  const waitMs = scheduledAt - performance.now();
  if (waitMs > 0) await delay(waitMs);
  if (samplerStop || performance.now() >= deadline) return null;
  return sequence;
}

async function newSession() {
  const response = await app.inject({ method: 'POST', url: '/api/v1/ai/agent/sessions', headers: { cookie } });
  assert.equal(response.statusCode, 200, 'session creation failed: ' + response.statusCode);
  return response.json().sessionId;
}

async function consumeOne(sequence) {
  const disconnect = config.cancelEvery > 0 && (sequence === 3 || (sequence > 3 && sequence % config.cancelEvery === 0));
  const slow = !disconnect && config.slowEvery > 0 && (sequence === 2 || (sequence > 3 && sequence % config.slowEvery === 0));
  const sessionId = await newSession();
  const controller = new AbortController();
  const marker = disconnect ? '[SOAK_CANCEL]' : slow ? '[SOAK_SLOW]' : '[SOAK_NORMAL]';
  const response = await originalFetch(base + '/api/v1/ai/agent/execute-stream', {
    method: 'POST',
    signal: controller.signal,
    headers: { cookie, 'content-type': 'application/json', 'x-forwarded-for': syntheticClientIp(sequence) },
    body: JSON.stringify({ sessionId, message: 'ComposeOps 长期稳定性测试 ' + marker + ' #' + sequence }),
  });
  assert.equal(response.status, 200, 'Agent SSE returned HTTP ' + response.status);
  const reader = response.body.getReader();
  if (slow) await delay(config.slowDelayMs);
  let buffer = '';
  let completed = false;
  let disconnected = false;
  const readFrames = async () => {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      counters.responseBytes += item.value.byteLength;
      buffer += decoder.decode(item.value, { stream: true });
      let splitAt;
      while ((splitAt = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt + 2);
        if (!frame.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(frame.slice(6)); } catch { throw new Error('Agent SSE emitted invalid JSON'); }
        counters.streamedEvents++;
        if (event.type === 'done') completed = true;
        if (disconnect && event.type === 'token') {
          disconnected = true;
          controller.abort();
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
  };
  try {
    await readFrames();
  } catch (error) {
    if (!disconnected) throw error;
  } finally {
    if (disconnected) {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  }
  if (disconnect) {
    assert.ok(disconnected, 'disconnect probe did not receive a token before stream completion');
    counters.clientDisconnects++;
  } else {
    assert.ok(completed, 'Agent SSE stream ended without a done event');
    counters.completed++;
    if (slow) counters.slowClients++;
  }
}

async function sampleResources() {
  const elapsed = (performance.now() - testStartedAt) / 1000;
  const memory = process.memoryUsage();
  const currentCpu = process.cpuUsage();
  const now = performance.now();
  const actualSampleIntervalMs = Math.max(0, now - lastResourceSampleAt);
  lastResourceSampleAt = now;
  const wallMs = Math.max(1, now - lastCpuSampleAt);
  const cpuMs = ((currentCpu.user - lastCpuUsage.user) + (currentCpu.system - lastCpuUsage.system)) / 1000;
  const cpuPercent = Math.max(0, (cpuMs / wallMs) * 100);
  lastCpuUsage = currentCpu;
  lastCpuSampleAt = now;
  const sample = {
    atSeconds: Number(elapsed.toFixed(1)),
    actualSampleIntervalMs: Number(actualSampleIntervalMs.toFixed(1)),
    rssMiB: Number((memory.rss / 1024 / 1024).toFixed(1)),
    heapUsedMiB: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
    externalMiB: Number((memory.external / 1024 / 1024).toFixed(1)),
    fileDescriptors: fdCount(),
    cpuPercent: Number(cpuPercent.toFixed(1)),
    eventLoopP95Ms: Number((eventLoop.percentile(95) / 1e6).toFixed(1)),
    eventLoopMaxMs: Number((eventLoop.max / 1e6).toFixed(1)),
  };
  if (elapsed >= config.warmupSeconds && !resourceBaseline) {
    resourceBaseline = sample;
    peakRssMiB = sample.rssMiB;
    peakFds = sample.fileDescriptors;
  } else if (resourceBaseline) {
    peakRssMiB = Math.max(peakRssMiB, sample.rssMiB);
    if (sample.fileDescriptors != null) peakFds = Math.max(peakFds ?? sample.fileDescriptors, sample.fileDescriptors);
    cpuSamples.push(cpuPercent);
  }
  resourceSamples.push(sample);
  eventLoop.reset();
  const checkpointNow = performance.now();
  if (config.reportFile && checkpointNow - lastCheckpointAt >= 60000) {
    writeCheckpoint(sample, elapsed);
    lastCheckpointAt = checkpointNow;
  }
}

function writeCheckpoint(finalSample, elapsedSeconds) {
  if (!config.reportFile || !agent) return;
  const postWarmup = resourceSamples.filter((sample) => sample.atSeconds >= config.warmupSeconds);
  const worstEventLoopSample = postWarmup.reduce((worst, sample) =>
    !worst || sample.eventLoopP95Ms > worst.eventLoopP95Ms ? sample : worst, null);
  const checkpoint = {
    status: 'running', checkpoint: true, updatedAt: new Date().toISOString(),
    configuredDurationSeconds: config.durationSeconds,
    elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
    configuration: config,
    requests: {
      scheduled: counters.scheduled, completed: counters.completed,
      clientDisconnects: counters.clientDisconnects, slowClients: counters.slowClients,
      modelCalls: counters.modelCalls, modelAborts: counters.modelAborts,
      streamedEvents: counters.streamedEvents, responseBytes: counters.responseBytes,
      failures: counters.failures,
    },
    resources: {
      baselineAfterWarmup: resourceBaseline, final: finalSample, peakRssMiB,
      rssGrowthMiB: resourceBaseline ? Number((peakRssMiB - resourceBaseline.rssMiB).toFixed(1)) : 0,
      baselineFileDescriptors: resourceBaseline?.fileDescriptors ?? null,
      peakFileDescriptors: peakFds,
      fileDescriptorGrowth: resourceBaseline && resourceBaseline.fileDescriptors != null && peakFds != null
        ? peakFds - resourceBaseline.fileDescriptors : null,
      averageCpuPercent: cpuSamples.length
        ? Number((cpuSamples.reduce((sum, value) => sum + value, 0) / cpuSamples.length).toFixed(1)) : 0,
      maxSampledEventLoopP95Ms: postWarmup.length
        ? Math.max(...postWarmup.map((sample) => sample.eventLoopP95Ms)) : 0,
      worstEventLoopSample,
      maxSampleIntervalMs: postWarmup.length
        ? Math.max(...postWarmup.map((sample) => sample.actualSampleIntervalMs)) : 0,
      sampleCount: resourceSamples.length,
    },
    cleanup: { activeExecutions: agent.activeExecutions.size, pendingApprovals: agent.pendingApprovals?.size ?? 0 },
  };
  fs.mkdirSync(path.dirname(config.reportFile), { recursive: true, mode: 0o700 });
  const temporaryReport = config.reportFile + '.tmp';
  fs.writeFileSync(temporaryReport, JSON.stringify(checkpoint, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(temporaryReport, 0o600);
  fs.renameSync(temporaryReport, config.reportFile);
}

async function main() {
  const { buildApp } = await import('../backend/src/app.js');
  const dbModule = await import('../backend/src/lib/db.js');
  db = dbModule.default;
  const { getAgent } = await import('../backend/src/services/agent.js');
  ({ resetBackgroundTasks } = await import('../backend/src/services/agent/background-tasks.js'));

  app = await buildApp({ logger: false });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { password: 'soak-' + Date.now() + '-' + process.pid } });
  assert.equal(setup.statusCode, 200, 'isolated authentication setup failed: ' + setup.body);
  cookie = String(setup.headers['set-cookie']).split(';')[0];
  assert.ok(cookie.includes('='), 'isolated authentication cookie missing');

  dbModule.setSetting('ai.api_key', 'composeops-soak-test-key');
  dbModule.setSetting('ai.base_url', modelBase);
  agent = getAgent();

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!url.startsWith(modelBase)) return originalFetch(input, init);
    counters.modelCalls++;
    if (init.signal?.aborted) throw new DOMException('Soak request aborted', 'AbortError');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const lastUserMessage = [...(body.messages || [])].reverse().find((message) => message.role === 'user')?.content || '';
    if (String(lastUserMessage).includes('[SOAK_CANCEL]')) {
      return makeModelResponse('cancel-stream '.repeat(512), 24, init.signal);
    }
    if (String(lastUserMessage).includes('[SOAK_SLOW]')) {
      return makeModelResponse('s'.repeat(config.slowPayloadKiB * 1024), 256, init.signal);
    }
    return makeModelResponse('稳定性测试通过。'.repeat(8), 12, init.signal);
  };

  testStartedAt = performance.now();
  deadline = testStartedAt + config.durationSeconds * 1000;
  nextSlotAt = testStartedAt;
  lastCheckpointAt = testStartedAt;
  lastCpuUsage = process.cpuUsage();
  lastCpuSampleAt = performance.now();
  lastResourceSampleAt = lastCpuSampleAt;
  eventLoop.enable();
  console.log('Agent/SSE soak started: duration=' + config.durationSeconds + 's workers=' + config.workers + ' requestBudget=' + config.requestsPerMinute + '/min');
  console.log('Using a temporary SQLite database and an in-process mock model; no real AI channel, host, or production database is contacted.');

  const sampler = (async () => {
    while (!samplerStop && performance.now() < deadline) {
      await delay(Math.min(config.sampleIntervalMs, Math.max(1, deadline - performance.now())));
      await sampleResources();
    }
  })();
  const workers = Array.from({ length: config.workers }, async () => {
    while (!samplerStop && performance.now() < deadline) {
      const sequence = await takeRequestSlot();
      if (sequence == null) break;
      try {
        await consumeOne(sequence);
      } catch (error) {
        counters.failures.push({ sequence, message: String(error?.message || error).slice(0, 500) });
        if (counters.failures.length <= 5) console.error('Request ' + sequence + ' failed: ' + String(error?.message || error));
      }
    }
  });

  await Promise.all(workers);
  samplerStop = true;
  await sampler;
  const settleUntil = performance.now() + 5000;
  while ((agent.activeExecutions.size || (agent.pendingApprovals?.size ?? 0)) && performance.now() < settleUntil) await delay(25);
  await sampleResources();
  eventLoop.disable();

  const postWarmup = resourceSamples.filter((sample) => sample.atSeconds >= config.warmupSeconds);
  const finalSample = resourceSamples.at(-1) || resourceSamples[0] || {};
  const averageCpuPercent = cpuSamples.length
    ? Number((cpuSamples.reduce((sum, value) => sum + value, 0) / cpuSamples.length).toFixed(1))
    : 0;
  const rssGrowthMiB = resourceBaseline ? Number((peakRssMiB - resourceBaseline.rssMiB).toFixed(1)) : 0;
  const fdGrowth = resourceBaseline && resourceBaseline.fileDescriptors != null && peakFds != null
    ? peakFds - resourceBaseline.fileDescriptors : null;
  const eventLoopP95Ms = postWarmup.length
    ? Math.max(...postWarmup.map((sample) => sample.eventLoopP95Ms))
    : (finalSample.eventLoopP95Ms || 0);
  const worstEventLoopSample = postWarmup.reduce((worst, sample) =>
    !worst || sample.eventLoopP95Ms > worst.eventLoopP95Ms ? sample : worst, null);
  const maxSampleIntervalMs = postWarmup.length
    ? Math.max(...postWarmup.map((sample) => sample.actualSampleIntervalMs)) : 0;

  const elapsedSeconds = Number(((performance.now() - testStartedAt) / 1000).toFixed(1));
  const summary = {
    status: 'pending',
    durationSeconds: elapsedSeconds,
    configuredDurationSeconds: config.durationSeconds,
    interrupted: Boolean(stopReason),
    stopReason,
    configuration: config,
    requests: {
      scheduled: counters.scheduled, completed: counters.completed,
      clientDisconnects: counters.clientDisconnects, slowClients: counters.slowClients,
      modelCalls: counters.modelCalls, modelAborts: counters.modelAborts,
      streamedEvents: counters.streamedEvents, responseBytes: counters.responseBytes,
      failures: counters.failures,
    },
    resources: {
      baselineAfterWarmup: resourceBaseline, final: finalSample,
      peakRssMiB, rssGrowthMiB, baselineFileDescriptors: resourceBaseline?.fileDescriptors ?? null,
      peakFileDescriptors: peakFds, fileDescriptorGrowth: fdGrowth,
      averageCpuPercent, maxSampledEventLoopP95Ms: eventLoopP95Ms,
      worstEventLoopSample, maxSampleIntervalMs, sampleCount: resourceSamples.length,
    },
    cleanup: { activeExecutions: agent.activeExecutions.size, pendingApprovals: agent.pendingApprovals?.size ?? 0 },
  };
  const problems = [];
  if (stopReason) problems.push('Test interrupted by ' + stopReason + ' before its configured monotonic deadline');
  if (!counters.completed) problems.push('No normal SSE request completed');
  if (!counters.clientDisconnects) problems.push('No client-disconnect cleanup probe completed');
  if (!counters.slowClients) problems.push('No slow-client probe completed');
  if (counters.failures.length) problems.push(counters.failures.length + ' request(s) failed');
  if (agent.activeExecutions.size || (agent.pendingApprovals?.size ?? 0)) problems.push('Agent execution/approval state did not drain after client disconnects');
  if (resourceBaseline && rssGrowthMiB > config.maxRssGrowthMiB) problems.push('RSS growth ' + rssGrowthMiB + ' MiB exceeds ' + config.maxRssGrowthMiB + ' MiB');
  if (fdGrowth != null && fdGrowth > config.maxFdGrowth) problems.push('File descriptor growth ' + fdGrowth + ' exceeds ' + config.maxFdGrowth);
  if (averageCpuPercent > config.maxAverageCpuPercent) problems.push('Average CPU ' + averageCpuPercent + '% exceeds ' + config.maxAverageCpuPercent + '%');
  if (eventLoopP95Ms > config.maxEventLoopP95Ms) problems.push('Event-loop p95 ' + eventLoopP95Ms + ' ms exceeds ' + config.maxEventLoopP95Ms + ' ms');
  summary.status = stopReason ? 'interrupted' : problems.length ? 'failed' : 'passed';
  summary.problems = problems;
  if (config.reportFile) {
    fs.mkdirSync(path.dirname(config.reportFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(config.reportFile, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(config.reportFile, 0o600);
    console.log('Agent/SSE JSON report written to ' + config.reportFile);
  }
  console.log(JSON.stringify(summary, null, 2));
  if (stopReason) {
    console.error('Agent/SSE soak INTERRUPTED. Partial results were preserved; this is not a pass.');
    process.exitCode = 2;
  } else if (problems.length) {
    console.error('Agent/SSE soak FAILED. A bounded run is diagnostic evidence, not a substitute for the multi-hour release soak.');
    process.exitCode = 1;
  } else {
    console.log('Agent/SSE soak PASSED for this configured duration.');
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    stopReason = signal;
    samplerStop = true;
    deadline = performance.now();
    console.warn('Received ' + signal + '; stopping workers and preserving the current soak report.');
  });
}

try {
  await main();
} finally {
  globalThis.fetch = originalFetch;
  try { if (resetBackgroundTasks) resetBackgroundTasks(); } catch { /* best-effort cleanup */ }
  try { if (app) await app.close(); } catch { /* preserve primary result */ }
  try { if (db) db.close(); } catch { /* preserve primary result */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* preserve primary result */ }
}
