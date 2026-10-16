#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { auditDatabaseReadiness } from '../src/lib/database-readiness-audit.js';

try {
  const { values } = parseArgs({
    options: {
      db: { type: 'string' },
      backup: { type: 'string' },
      'key-file': { type: 'string' },
    },
    strict: true,
  });
  console.log(JSON.stringify(auditDatabaseReadiness({
    dbPath: values.db,
    backupPath: values.backup,
    keyFilePath: values['key-file'],
  }), null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    readOnly: true,
    blockers: [String(error?.message || error)],
  }, null, 2));
  process.exitCode = 1;
}
