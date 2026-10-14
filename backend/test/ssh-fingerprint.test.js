import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import test from 'node:test';
import { createSshHostVerifier, normalizeSshFingerprint } from '../src/lib/ssh-fingerprint.js';
import { sshExec } from '../src/services/remote-shell.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs1' });
const parsedKey = ssh2.utils.parseKey(privatePem);
const digest = createHash('sha256').update(parsedKey.getPublicSSH()).digest();
const fingerprintHex = digest.toString('hex');
const fingerprintOpenSsh = `SHA256:${digest.toString('base64').replace(/=+$/, '')}`;

test('SSH fingerprint: accepts OpenSSH and hex formats, rejects malformed values', () => {
  assert.equal(normalizeSshFingerprint(fingerprintOpenSsh), fingerprintHex);
  assert.equal(normalizeSshFingerprint(fingerprintHex.match(/../g).join(':')), fingerprintHex);
  assert.equal(normalizeSshFingerprint(''), '');
  assert.throws(() => normalizeSshFingerprint('SHA256:not-a-fingerprint'), { statusCode: 400 });
  assert.throws(() => normalizeSshFingerprint('abcd'), { statusCode: 400 });
});

test('SSH fingerprint: verifier uses SHA-256 and refuses mismatched host keys', () => {
  const verifier = createSshHostVerifier(fingerprintOpenSsh);
  assert.equal(verifier(fingerprintHex), true);
  assert.equal(verifier(fingerprintHex.toUpperCase()), true);
  assert.equal(verifier('a'.repeat(64)), false);
  assert.equal(verifier(Buffer.from('bad')), false);
  assert.equal(createSshHostVerifier(''), null);
});

test('SSH remote shell: accepts a pinned local SSH host and rejects a different fingerprint', async (t) => {
  const server = new ssh2.Server({ hostKeys: [privatePem] }, (client) => {    client.on('error', () => {}); // 不匹配指纹时,服务端应将握手断开视为预期事件。

    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === 'test' && context.password === 'test') context.accept();
      else context.reject();
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('exec', (acceptStream) => {
          const stream = acceptStream();
          stream.write('fixture-ok\n');
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = { host: '127.0.0.1', port: server.address().port, username: 'test', password: 'test', hostFingerprint: fingerprintOpenSsh };

  const result = await sshExec(host, ['printf', 'hello'], { timeoutMs: 3000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'fixture-ok\n');

  await assert.rejects(
    sshExec({ ...host, hostFingerprint: 'a'.repeat(64) }, ['printf', 'hello'], { timeoutMs: 3000 }),
    /Host denied|verification|fingerprint|handshake|Error/i,
  );
});
