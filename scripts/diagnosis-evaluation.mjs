#!/usr/bin/env node
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const configFile = option('--config-file'), output = option('--output');
if (!configFile || !output) throw new Error('用法：node scripts/diagnosis-evaluation.mjs --config-file /私有配置.json --output /验收/evaluation.json');
const directory = await mkdtemp(path.join(os.tmpdir(), 'composeops-diagnosis-eval-'));
process.env.DB_PATH = path.join(directory, 'isolated.db');
process.env.DISABLE_BACKGROUND_JOBS = '1'; process.env.SERVE_FRONTEND = '0';
let database;
try {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const { queueDiagnosisEvaluation, executeDiagnosisEvaluation, diagnosisSuiteInfo } = await import('../backend/src/services/diagnosis-evaluation.js');
  database = (await import('../backend/src/lib/db.js')).default;
  const run = queueDiagnosisEvaluation({ channelId: option('--channel') || undefined }, 'isolated-evaluation-cli', config);
  const result = await executeDiagnosisEvaluation(run.id, { config, onCase: row => console.log(JSON.stringify(row)) });
  await mkdir(path.dirname(path.resolve(output)), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify({ suite: diagnosisSuiteInfo(), evaluation: result, isolated: true }, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, quality: result.result.quality, summary: result.result.summary, output: path.resolve(output) }));
  if (result.status !== 'completed') process.exitCode = 1;
} finally { database?.close(); await rm(directory, { recursive: true, force: true }); }
