import assert from 'node:assert/strict';
import test from 'node:test';
import { harvestSecretValues, redactSecrets, redactSecretValue, resetSecretRedactor } from '../src/lib/secret-redactor.js';

test('secret-redactor: 键名敏感的 KEY=VALUE 被收割并能在任意文本中抹除', () => {
  resetSecretRedactor();
  const added = harvestSecretValues('启动配置:\nMYSQL_ROOT_PASSWORD=Sup3rS3cret!\nPORT=3306');
  assert.ok(added >= 1, '应至少收割 1 个敏感值');
  const out = redactSecrets('连接失败,请检查 MYSQL_ROOT_PASSWORD=Sup3rS3cret! 是否正确');
  assert.ok(!out.includes('Sup3rS3cret!'), '明文密钥不应出现在脱敏结果中');
  assert.ok(out.includes('[REDACTED]'), '应替换为 [REDACTED]');
  // 非敏感键不收割
  assert.ok(!redactSecrets('PORT=3306').includes('[REDACTED]PORT'), '普通键值不受影响');
});

test('secret-redactor: 静态 token 形态(sk-/ghp_/xox/AKIA)无需键名直接抹除', () => {
  resetSecretRedactor();
  const out = redactSecrets('token=sk-abcdefgh12345678 ghp_abcdefghijklmnopqrstuv xoxb-1234567890abcdef AKIAIOSFODNN7EXAMPLE');
  assert.ok(!out.includes('sk-abcdefgh12345678'));
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuv'));
  assert.ok(!out.includes('xoxb-1234567890abcdef'));
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('secret-redactor: 占位符/短值不收割,JSON "KEY":"VALUE" 形态可收割', () => {
  resetSecretRedactor();
  assert.equal(harvestSecretValues('API_KEY=changeme'), 0, '占位符不收割');
  assert.equal(harvestSecretValues('TOKEN=abc'), 0, '过短值不收割');
  const added = harvestSecretValues('{"SECRET_API_KEY":"real-secret-value-123"}');
  assert.equal(added, 1, 'JSON 形态应收割');
  assert.ok(!redactSecrets('see real-secret-value-123 here').includes('real-secret-value-123'));
});

test('secret-redactor: harvest 后 redactSecrets 对同值多次出现全部替换', () => {
  resetSecretRedactor();
  harvestSecretValues('DB_PASSWORD=LongSecretValue99');
  const text = 'a=LongSecretValue99 b=LongSecretValue99 LongSecretValue99';
  assert.equal((redactSecrets(text).match(/LongSecretValue99/g) || []).length, 0);
});

test('secret-redactor: 深层对象、数组及自由文本中的重复秘密值均脱敏', () => {
  resetSecretRedactor();
  const secret = 'AuditSecretValue-47';
  harvestSecretValues(`API_KEY=${secret}`);
  const result = redactSecretValue({
    nested: { token: secret, note: `command failed using ${secret}; retry with ${secret}` },
    list: [`first ${secret}`, { output: `TOKEN=${secret}` }],
    safe: 'keep diagnostic context',
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret), '不得在任何嵌套字段或重复文本中保留秘密');
  assert.equal(result.nested.token, '[REDACTED]');
  assert.equal(result.safe, 'keep diagnostic context');
});
