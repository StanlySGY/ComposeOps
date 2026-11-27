#!/usr/bin/env node
// Parse synthetic env fixtures with the installed Compose CLI. No containers
// are created, no application configuration or secrets are read or printed.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDotenvDocument, editDotenvDocument, validateDotenv, serializeDotenv } from '../backend/src/lib/dotenv.js';
const root = await mkdtemp(path.join(tmpdir(), 'composeops-env-semantics-'));
let checks = 0;
try {
  const compose = path.join(root, 'compose.yml'), envFile = path.join(root, 'test.env');
  await writeFile(compose, 'services:\n  sample:\n    image: busybox:latest\n    environment:\n      VALUE: ${VALUE:-}\n      MODE: ${MODE:-}\n');
  async function resolved(raw) {
    assert.equal(validateDotenv(raw).ok, true);
    await writeFile(envFile, raw, { mode: 0o600 });
    const output = execFileSync('docker', ['compose', '--env-file', envFile, '-f', compose, 'config', '--environment'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, UNIT_REFERENCE: 'expanded' }, timeout: 15000,
    });
    // config JSON re-escapes literal dollars for reusable Compose output.
    // --environment reports the actual interpolation inputs. Only parse our
    // synthetic fixture values, never dump the rest of the environment.
    return Object.fromEntries(output.replace(/\n$/, '').split(/\n(?=[A-Za-z_][A-Za-z0-9_]*=)/).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
  }
  for (const token of ["'literal$UNIT_REFERENCE'", '$UNIT_REFERENCE', '"prefix $UNIT_REFERENCE"', "''", '你好']) {
    const raw = `# fixture\r\nVALUE=${token} # preserve\r\nMODE=before\r\n\r\n`;
    const doc = parseDotenvDocument(raw), entries = doc.nodes.map(node => ({ ...node }));
    entries[1].value = 'after';
    const changed = editDotenvDocument(doc, entries);
    assert.equal(changed, raw.replace('MODE=before', 'MODE=after'));
    assert.equal((await resolved(changed)).VALUE, (await resolved(raw)).VALUE);
    checks++;
  }
  for (const value of ['simple', 'two words', 'literal$UNIT_REFERENCE', 'ends\\', "quote'with\\'", 'line\nbreak', 'dollar$UNIT_REFERENCE\\', '#hash', '你好']) {
    const doc = parseDotenvDocument("VALUE='before'\n");
    const changed = editDotenvDocument(doc, [{ ...doc.nodes[0], value }]);
    assert.equal((await resolved(changed)).VALUE, value);
    assert.equal((await resolved(serializeDotenv([{ key: 'VALUE', value }]))).VALUE, value);
    checks++;
  }
  const multiline = "VALUE='first\nsecond'\n";
  assert.equal(parseDotenvDocument(multiline).tableSafe, false);
  assert.equal((await resolved(multiline)).VALUE, 'first\nsecond'); checks++;
  console.log(JSON.stringify({ passed: true, checks, scope: 'Compose config only; no containers or real env files' }));
} finally { await rm(root, { recursive: true, force: true }); }
