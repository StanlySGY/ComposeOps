import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSshPrivateKey, inspectSshPrivateKey } from '../src/lib/ssh-private-key.js';

test('SSH 私钥校验允许未配置密钥', () => {
  assert.deepEqual(inspectSshPrivateKey(''), { ok: true, kind: 'none' });
});

test('SSH 私钥字段误填文件路径时给出明确诊断', () => {
  const result = inspectSshPrivateKey('/home/user/.ssh/id_ed25519');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ssh_private_key_path');
  assert.match(result.message, /完整私钥内容/);
});

test('不支持或损坏的私钥格式返回脱敏诊断', () => {
  const marker = 'DO_NOT_ECHO_PRIVATE_KEY_MATERIAL';
  const result = inspectSshPrivateKey(`-----BEGIN OPENSSH PRIVATE KEY-----\n${marker}\n-----END OPENSSH PRIVATE KEY-----`);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ssh_private_key_format');
  assert.doesNotMatch(result.message, new RegExp(marker));
});

test('assertSshPrivateKey 使用稳定错误码且不包含密钥内容', () => {
  const marker = 'DO_NOT_ECHO_PRIVATE_KEY_MATERIAL';
  assert.throws(
    () => assertSshPrivateKey(`-----BEGIN OPENSSH PRIVATE KEY-----\n${marker}\n-----END OPENSSH PRIVATE KEY-----`),
    (error) => error.statusCode === 400 && error.code === 'ssh_private_key_format' && !error.message.includes(marker),
  );
});
