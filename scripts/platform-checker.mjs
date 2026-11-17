#!/usr/bin/env node
// Independent process, no database access or Docker socket. Can run on another host.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export function advanceCheckerState(previous, observation, { failures = 3, recoveries = 3 } = {}) {
  const state = { version: 1, status: 'unknown', bad: 0, good: 0, episode: 0, transitions: [], ...previous };
  if (observation.at <= (state.observedAt || 0)) return state;
  const contiguous = observation.at - (state.observedAt || observation.at) <= 120000;
  state.bad = observation.ok ? 0 : (contiguous ? state.bad : 0) + 1;
  state.good = observation.ok ? (contiguous ? state.good : 0) + 1 : 0;
  let transition;
  if (!observation.ok && state.bad >= failures && state.status !== 'firing') { state.status = 'firing'; state.episode++; transition = 'firing'; }
  if (observation.ok && state.good >= recoveries && state.status !== 'healthy') { if (state.status === 'firing') transition = 'resolved'; state.status = 'healthy'; }
  if (transition) state.transitions = [...state.transitions, { id: randomUUID(), at: observation.at, transition, episode: state.episode,
    reason: observation.reason, notification: 'pending', attempts: 0 }].slice(-100);
  state.observedAt = observation.at; state.observation = observation;
  return state;
}
async function boundedJson(response) {
  let size = 0, text = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    size += chunk.byteLength; if (size > 65536) throw new Error('response_limit');
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
export async function checkPlatform(config, { fetcher = fetch, now = Date.now } = {}) {
  const started = now();
  try {
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid_url');
    const token = (await readFile(config.tokenFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid_credential');
    const response = await fetcher(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ location: config.location || 'same-host' }), signal: AbortSignal.timeout(config.timeoutMs || 10000) });
    const body = await boundedJson(response);
    const fresh = Number.isFinite(body.at) && Math.abs(now() - body.at) < 60000;
    return { at: now(), ok: response.ok && body.status === 'ok' && !body.stale && fresh, latencyMs: now() - started,
      reason: !fresh ? '面板响应时间戳缺失或过期' : body.status === 'degraded' ? '面板平台监测报告异常' : response.ok ? '面板健康检查通过' : `面板响应 HTTP ${response.status}` };
  } catch { return { at: now(), ok: false, latencyMs: now() - started, reason: '面板不可达、检查超时或响应无效' }; }
}
async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID();
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
export async function runCheckerOnce(config, { fetcher = fetch, now = Date.now } = {}) {
  let previous = {};
  try { previous = JSON.parse(await readFile(config.stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('独立检查器状态文件损坏或不可读，请保留文件后处理'); }
  for (const item of previous.transitions || []) if (item.notification === 'sending') item.notification = 'outcome_unknown';
  const state = advanceCheckerState(previous, await checkPlatform(config, { fetcher, now }));
  await saveState(config.stateFile, state);
  for (const item of state.transitions.filter(row => ['pending', 'retry'].includes(row.notification) && (!row.nextAt || row.nextAt <= now()))) {
    if (!config.webhookUrl) { item.notification = 'unconfigured'; continue; }
    if (item.episode !== state.episode || (item.transition === 'firing' && state.status !== 'firing')) { item.notification = 'superseded'; continue; }
    item.notification = 'sending'; item.attempts++;
    await saveState(config.stateFile, state);
    try {
      const response = await fetcher(config.webhookUrl, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': item.id },
        body: JSON.stringify({ id: item.id, source: 'composeops-independent-checker', location: config.location || 'same-host', ...item }), signal: AbortSignal.timeout(10000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('delivery_failed');
      item.notification = 'sent';
    } catch { item.notification = item.attempts >= 5 ? 'failed' : 'retry'; item.nextAt = now() + Math.min(3600000, 30000 * 2 ** item.attempts); }
    await saveState(config.stateFile, state);
  }
  await saveState(config.stateFile, state);
  return state;
}
async function main() {
  const file = process.argv[process.argv.indexOf('--config') + 1];
  if (!process.argv.includes('--config') || !file) throw new Error('用法：node platform-checker.mjs --config /安全路径/checker.json [--once]');
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (!config.stateFile || !config.tokenFile || !config.url || !['same-host', 'separate-host'].includes(config.location)) throw new Error('检查器配置不完整');
  if (process.argv.includes('--once')) { const result = await runCheckerOnce(config); console.log(JSON.stringify({ status: result.status, observation: result.observation })); return; }
  let stopped = false, wake;
  const stop = () => { stopped = true; wake?.(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  while (!stopped) {
    try { const state = await runCheckerOnce(config); console.log(JSON.stringify({ status: state.status, observation: state.observation })); }
    catch (error) { console.error(error.message === '独立检查器状态文件损坏或不可读，请保留文件后处理' ? error.message : '独立检查器执行失败，请检查配置与文件权限'); }
    if (!stopped) await new Promise(resolve => { const timer = setTimeout(resolve, Math.max(10000, Math.min(config.intervalMs || 30000, 60000))); wake = () => { clearTimeout(timer); resolve(); }; });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
