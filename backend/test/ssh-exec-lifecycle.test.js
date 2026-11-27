import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import ssh2 from 'ssh2';
import { sshExec } from '../src/services/remote-shell.js';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
async function fixture(t, stage) {
  const clients = new Set();
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => client.on('session', acceptSession => {
      if (stage === 'session') return;
      const session = acceptSession();
      session.on('exec', accept => {
        if (stage === 'exec') return;
        const channel = accept(); channel.on('error', () => {});
        if (stage === 'stream') return;
        if (stage === 'disconnect') { client.end(); return; }
        channel.write('你好'); channel.stderr.write('diagnostic'); channel.exit(3); channel.end();
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  return { host: '127.0.0.1', port: server.address().port, username: 'test', password: 'test' };
}
for (const stage of ['session', 'exec', 'stream']) {
  test(`SSH ${stage} 阶段停滞都会到期退出`, async t => {
    const host = await fixture(t, stage);
    await assert.rejects(sshExec(host, ['true'], { timeoutMs: 250 }), { statusCode: 504 });
  });
}
test('SSH 完整消费 stdout/stderr 并保留非零退出码', async t => {
  const host = await fixture(t, 'normal');
  assert.deepEqual(await sshExec(host, ['true']), { code: 3, stdout: '你好', stderr: 'diagnostic' });
});
test('SSH 同步取消立即中止等待，不能当作成功', async t => {
  const host = await fixture(t, 'stream');
  await assert.rejects(sshExec(host, ['true'], { onExec: handle => handle.kill(), timeoutMs: 1000 }), { name: 'AbortError' });
});
test('SSH 回调失败有清理，不留下未处理异常', async t => {
  const host = await fixture(t, 'normal');
  await assert.rejects(sshExec(host, ['true'], { onOutput: () => { throw new Error('consumer stopped'); } }), /consumer stopped/);
});

test('SSH 外部取消覆盖会话建立，不需要等到命令句柄回调', async t => {
  const host = await fixture(t, 'session');
  await assert.rejects(sshExec(host, ['true'], { signal: AbortSignal.timeout(200), timeoutMs: 1000 }), { name: 'TimeoutError' });
});
