#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runEncryptionRecoveryDrill } from '../src/lib/encryption-recovery.js';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: npm run recovery:drill -- --backup=/path/to/encrypted-backup.db --key-file=/outside/repo/db-key [--report-file=/outside/repo/report.json]');
  process.exit(0);
}

try {
  const { values } = parseArgs({
    options: {
      backup: { type: 'string' },
      'key-file': { type: 'string' },
      'report-file': { type: 'string' },
    },
    strict: true,
  });
  const result = await runEncryptionRecoveryDrill({
    backupPath: values.backup,
    keyFilePath: values['key-file'],
    reportPath: values['report-file'] || null,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Encryption recovery drill failed: ' + String(error?.message || error));
  process.exitCode = 1;
}
