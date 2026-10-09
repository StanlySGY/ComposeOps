import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildExecCommand } from '../src/services/tools/compose-tools.js';
import { execInRunner } from '../src/services/compose-workspace.js';
import { replaceComposeWithBackup } from '../src/services/compose-runner.js';

test('compose.exec: 命令包装器写入 PID 标记并保留 shell 安全转义', () => {
  const command = "printf '%s' 'a'b";
  const wrapped = buildExecCommand(command, '/tmp/composeops-exec-test.pid');
  assert.match(wrapped, /echo "\$\$"/);
  assert.match(wrapped, /composeops-exec-test\.pid/);
  assert.match(wrapped, /timeout --signal=TERM 120s/);
  assert.match(wrapped, /a'\\''b/);
});

test('compose workspace: exec 超时销毁输出流并返回 504', async () => {
  let stream;
  const container = {
    async exec() {
      return {
        async start() {
          stream = new PassThrough();
          return stream;
        },
        async inspect() { return { ExitCode: 0 }; },
      };
    },
  };
  await assert.rejects(
    execInRunner(container, ['sleep', '1'], { timeoutMs: 10 }),
    (error) => error.statusCode === 504,
  );
  assert.equal(stream.destroyed, true);
});

test('compose save: 文件替换失败时不写入备份并尝试恢复原文件', async () => {
  const calls = [];
  await assert.rejects(replaceComposeWithBackup({
    replace: async () => { calls.push('replace'); throw new Error('rename failed'); },
    backup: async () => { calls.push('backup'); },
    rollback: async () => { calls.push('rollback'); },
  }), /rename failed/);
  assert.deepEqual(calls, ['replace', 'rollback']);
});

test('compose save: 备份持久化失败时恢复原文件且返回原始错误', async () => {
  const calls = [];
  const backupError = new Error('database unavailable');
  await assert.rejects(replaceComposeWithBackup({
    replace: async () => { calls.push('replace'); },
    backup: async () => { calls.push('backup'); throw backupError; },
    rollback: async () => { calls.push('rollback'); },
  }), (error) => error === backupError);
  assert.deepEqual(calls, ['replace', 'backup', 'rollback']);
});

test('compose save: 原文件恢复失败时返回明确错误代码', async () => {
  await assert.rejects(replaceComposeWithBackup({
    replace: async () => {},
    backup: async () => { throw new Error('database unavailable'); },
    rollback: async () => { throw new Error('disk unavailable'); },
  }), (error) => error.code === 'COMPOSE_SAVE_ROLLBACK_FAILED' && error.statusCode === 500 && /disk unavailable/.test(error.message));
});
