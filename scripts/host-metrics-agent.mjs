#!/usr/bin/env node
// Runs outside Docker: no listener, Docker socket, database, or credentials.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectHostProbe } from '../backend/src/lib/host-probe.js';

const output = process.env.COMPOSEOPS_HOST_METRICS_OUTPUT;
if (!output || !path.isAbsolute(output)) throw new Error('COMPOSEOPS_HOST_METRICS_OUTPUT 必须为仓库外的绝对路径');
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
let stopped = false;
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { stopped = true; });
do {
  try {
    const snapshot = await collectHostProbe();
    await writeFile(`${output}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(`${output}.tmp`, output);
  } catch (error) { console.error('宿主采集失败:', error.message); }
  if (process.argv.includes('--once')) break;
  if (!stopped) await new Promise(resolve => setTimeout(resolve, 10000));
} while (!stopped);
