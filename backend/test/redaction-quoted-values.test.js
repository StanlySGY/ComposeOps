import assert from 'node:assert/strict';
import test from 'node:test';
import { redactText } from '../src/lib/redaction.js';
import { harvestSecretValues, redactSecrets, redactSecretStreamTail, resetSecretRedactor, secretStreamHoldbackLength } from '../src/lib/secret-redactor.js';

const fixtures = [
  ['PASSWORD="fictional alpha beta" PORT=8080', ['fictional', 'alpha', 'beta']],
  ["DB_PASSWORD='fictional alpha beta' PORT=8080", ['fictional', 'alpha', 'beta']],
  [JSON.stringify({ DB_PASSWORD: 'fictional "quoted" tail', port: 8080 }), ['fictional', 'quoted', 'tail']],
  ['{"API_KEY":\n  "fictional escaped \\" marker"}', ['fictional', 'escaped', 'marker']],
  ["DB_PASSWORD='fictional ''quoted'' tail'\nPORT=8080", ['fictional', 'quoted', 'tail']],
  ["PASSWORD='fictional\nmultiline tail'\nPORT=8080", ['fictional', 'multiline', 'tail']],
  ['Authorization: Basic ZmljdGlvbmFsOnBhc3N3b3Jk\nAccept: application/json', ['ZmljdGlvbmFsOnBhc3N3b3Jk']],
  ['_DATABASE_PASSWORD="fictional alpha beta" PORT=8080', ['fictional', 'alpha', 'beta']],
  ['{"PASSWORD"\n : "fictional secret phrase", "port":8080}', ['fictional', 'secret phrase']],
];
for (const [index, [input, forbidden]] of fixtures.entries()) test(`quoted redaction ${index}: quoted/escaped values are fully hidden`, () => {
  resetSecretRedactor(); harvestSecretValues(input);
  for (const redact of [redactText, redactSecrets]) {
    const result = redact(input);
    for (const fragment of forbidden) assert.ok(!result.includes(fragment), `${redact.name} leaked ${fragment}: ${result}`);
    if (input.includes('8080')) assert.ok(result.includes('8080'), 'unrelated value preserved');
  }
});

test('quoted redaction: harvested raw and JSON-decoded values are hidden outside key/value pairs', () => {
  resetSecretRedactor(); const value = 'fictional "escaped" phrase';
  harvestSecretValues(JSON.stringify({ DB_PASSWORD: value }));
  assert.equal(redactSecrets(`echo ${value}`), 'echo [REDACTED]');
  harvestSecretValues('SECRET="opaque TOKEN=middle ending"');
  assert.equal(redactSecrets('echo opaque TOKEN=middle ending'), 'echo [REDACTED]');
  harvestSecretValues('SECRET="fictional boundary credential"');
  const long = 'x'.repeat(11990) + 'fictional boundary credential';
  assert.ok(!redactSecrets(long).includes('fictional'));
});

// Mirrors the AI emitter: accumulate raw text, hold ambiguous suffixes, then
// redact only the not-yet-emitted prefix. Run every possible two-chunk split.
for (const [index, [input, forbidden]] of fixtures.entries()) test(`quoted stream ${index}: every chunk boundary keeps secret suffixes private`, () => {
  for (let split = 1; split < input.length; split++) {
    resetSecretRedactor(); let text = '', emitted = 0, output = '';
    for (const chunk of [input.slice(0, split), input.slice(split)]) {
      text += chunk;
      const safe = text.length - secretStreamHoldbackLength(text);
      if (safe > emitted) { output += redactSecrets(text.slice(emitted, safe)); emitted = safe; }
    }
    output += redactSecretStreamTail(text.slice(emitted));
    for (const fragment of forbidden) assert.ok(!output.includes(fragment), `split=${split} leaked ${fragment}: ${output}`);
  }
});

test('quoted redaction: incomplete final values stay hidden while ordinary text survives', () => {
  resetSecretRedactor();
  assert.ok(!redactSecretStreamTail('PASSWORD="fictional unfinished phrase').includes('unfinished'));
  assert.equal(redactSecrets('healthy service PORT=8080, retry in 2 seconds.'), 'healthy service PORT=8080, retry in 2 seconds.');
  assert.equal(redactSecrets('compass=east passwordRequired=true'), 'compass=east passwordRequired=[REDACTED]');
  for (const input of ['TOKEN=[REDACTED]', ...fixtures.map(([value]) => value)]) assert.equal(redactText(redactText(input)), redactText(input));
});

test('quoted stream: one-character chunks preserve whitespace and complete secret boundaries', () => {
  for (const [input, forbidden] of [...fixtures, ['普通诊断\n\n```yaml\nPORT: 8080\n```\n', []], ['PASSWORD=\nPORT=8080', null]]) {
    resetSecretRedactor(); let text = '', output = '', emitted = 0;
    for (const chunk of input) {
      text += chunk; const safe = text.length - secretStreamHoldbackLength(text);
      if (safe > emitted) { output += redactSecrets(text.slice(emitted, safe)); emitted = safe; }
    }
    output += redactSecretStreamTail(text.slice(emitted));
    for (const fragment of forbidden || []) assert.ok(!output.includes(fragment), `${fragment}: ${output}`);
    if (forbidden?.length === 0) assert.equal(output, input);
    if (input.includes('8080')) assert.ok(output.includes('8080'), `lost ordinary setting: ${output}`);
  }
});
