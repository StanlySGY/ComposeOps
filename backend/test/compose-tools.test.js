import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildExecCommand } from '../src/services/tools/compose-tools.js';
import { execInRunner } from '../src/services/compose-workspace.js';

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
