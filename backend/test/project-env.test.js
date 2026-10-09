import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, chmod, rm, symlink, stat, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveProjectEnv, readProjectEnv, replaceEnvFileWithBackup, replaceWorkspaceEnvWithBackup } from '../src/services/project-env.js';
import { lstat, writeFile as fsWriteFile } from 'node:fs/promises';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'composeops-env-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, project: { id: `env-test-${path.basename(root)}`, projectName: 'env-test', workingDir: root, mounted: true, editable: true, managed: true } };
}

test('project env save: creates and replaces a regular file, backing up previous contents privately', async (t) => {
  const { root, project } = await fixture(t);
  const first = await saveProjectEnv(project, { raw: 'APP_MODE=one\n' });
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'APP_MODE=one\n');
  assert.equal(await readFile(path.join(root, first.backup), 'utf8'), '');
  assert.equal((await stat(path.join(root, first.backup))).mode & 0o777, 0o600);
  await chmod(path.join(root, '.env'), 0o640);
  const second = await saveProjectEnv(project, { raw: 'APP_MODE=two\n' });
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'APP_MODE=two\n');
  assert.equal(await readFile(path.join(root, second.backup), 'utf8'), 'APP_MODE=one\n');
  assert.equal((await stat(path.join(root, '.env'))).mode & 0o777, 0o640);
  assert.equal((await readProjectEnv(project)).raw, 'APP_MODE=two\n');
});

test('project env save: rejects symlinks without modifying or backing up their target', async (t) => {
  const { root, project } = await fixture(t);
  const outside = path.join(root, '..', `${path.basename(root)}-outside`);
  await writeFile(outside, 'DO_NOT_TOUCH=1\n');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(root, '.env'));
  await assert.rejects(saveProjectEnv(project, { raw: 'DO_NOT_TOUCH=2\n' }), (error) => error.code === 'ENV_UNSAFE_TARGET' && error.statusCode === 403);
  assert.equal(await readFile(outside, 'utf8'), 'DO_NOT_TOUCH=1\n');
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.env.backup.')), []);
});

test('project env save: rejects directories and other non-regular targets', async (t) => {
  const { root, project } = await fixture(t);
  await mkdir(path.join(root, '.env'));
  await assert.rejects(saveProjectEnv(project, { raw: 'APP_MODE=x\n' }), (error) => error.code === 'ENV_UNSAFE_TARGET' && error.statusCode === 403);
});

test('project env save: serializes same-process writes and leaves complete content and backups', async (t) => {
  const { root, project } = await fixture(t);
  await saveProjectEnv(project, { raw: 'APP_MODE=initial\n' });
  const a = `APP_MODE=${'a'.repeat(2048)}\n`;
  const b = `APP_MODE=${'b'.repeat(2048)}\n`;
  const results = await Promise.all([saveProjectEnv(project, { raw: a }), saveProjectEnv(project, { raw: b })]);
  const finalContent = await readFile(path.join(root, '.env'), 'utf8');
  assert.ok(finalContent === a || finalContent === b);
  const backupContents = await Promise.all(results.map((result) => readFile(path.join(root, result.backup), 'utf8')));
  assert.ok(backupContents.includes('APP_MODE=initial\n'));
  assert.ok(backupContents.every((value) => value === 'APP_MODE=initial\n' || value === a || value === b));
  assert.equal((await readdir(root)).filter((name) => name.includes('.tmp.')).length, 0);
});

test('mounted env transaction: temp write failure preserves target and cleans backup', async (t) => {
  const { root } = await fixture(t);
  const envPath = path.join(root, '.env');
  const backupPath = path.join(root, '.env.backup.injected');
  await writeFile(envPath, 'APP_MODE=stable\\n');
  const existingStat = await lstat(envPath);
  await assert.rejects(replaceEnvFileWithBackup({ envPath, backupPath, content: 'APP_MODE=changed\\n', existingStat, fsOps: {
    writeFile: async (filePath, ...args) => { if (filePath.includes('.tmp.')) throw new Error('injected temp write failure'); return fsWriteFile(filePath, ...args); },
  } }), /injected temp write failure/);
  assert.equal(await readFile(envPath, 'utf8'), 'APP_MODE=stable\\n');
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.backup.') || name.includes('.tmp.')), []);
});

test('mounted env transaction: version conflict returns 409 and preserves target', async (t) => {
  const { root } = await fixture(t);
  const envPath = path.join(root, '.env');
  const backupPath = path.join(root, '.env.backup.injected');
  await writeFile(envPath, 'APP_MODE=stable\\n');
  const existingStat = await lstat(envPath);
  await assert.rejects(replaceEnvFileWithBackup({ envPath, backupPath, content: 'APP_MODE=changed\\n', existingStat, fsOps: {
    assertTarget: async () => ({ ...existingStat, ino: existingStat.ino + 1 }),
  } }), (error) => error.code === 'ENV_VERSION_CONFLICT' && error.statusCode === 409);
  assert.equal(await readFile(envPath, 'utf8'), 'APP_MODE=stable\\n');
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.backup.') || name.includes('.tmp.')), []);
});

test('mounted env transaction: rename failure preserves target and cleans artifacts', async (t) => {
  const { root } = await fixture(t);
  const envPath = path.join(root, '.env');
  const backupPath = path.join(root, '.env.backup.injected');
  await writeFile(envPath, 'APP_MODE=stable\\n');
  const existingStat = await lstat(envPath);
  await assert.rejects(replaceEnvFileWithBackup({ envPath, backupPath, content: 'APP_MODE=changed\\n', existingStat, fsOps: {
    rename: async () => { throw new Error('injected rename failure'); },
  } }), /injected rename failure/);
  assert.equal(await readFile(envPath, 'utf8'), 'APP_MODE=stable\\n');
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.backup.') || name.includes('.tmp.')), []);
});

test('workspace env transaction: rejects a directory target before creating backup', async () => {
  let writes = 0;
  const ops = {
    exec: async (_container, args) => {
      if (args[0] === 'test' && args[1] === '!' && args[2] === '-L') return { code: 0 };
      if (args[0] === 'test' && args[1] === '-e') return { code: 0 };
      if (args[0] === 'test' && args[1] === '-f') return { code: 1 };
      return { code: 0 };
    },
    read: async () => { throw new Error('must not read directory'); },
    put: async () => { writes += 1; },
  };
  await assert.rejects(replaceWorkspaceEnvWithBackup({ container: {}, root: '/project', envPath: '/project/.env', backupPath: '/project/.env.backup.injected', backupName: '.env.backup.injected', content: 'APP_MODE=changed\\n', ops }), (error) => error.code === 'ENV_UNSAFE_TARGET' && error.statusCode === 403);
  assert.equal(writes, 0);
});

test('workspace env transaction: temp upload failure cleans the backup and leaves target unchanged', async () => {
  const files = new Map([['/project/.env', 'APP_MODE=stable\\n']]);
  const ops = {
    exec: async (_container, args) => {
      if (args[0] === 'test') return { code: 0 };
      if (args[0] === 'rm') { files.delete(args.at(-1)); return { code: 0 }; }
      if (args[0] === 'mv') { files.set(args.at(-1), files.get(args.at(-2))); files.delete(args.at(-2)); return { code: 0 }; }
      return { code: 0 };
    },
    read: async (_container, filePath) => ({ content: files.get(filePath), header: { mode: 0o640, uid: 1000, gid: 1000 } }),
    put: async (_container, directory, name, content) => {
      if (name.endsWith('.envtmp')) throw new Error('injected remote upload failure');
      files.set(path.posix.join(directory, name), content);
    },
  };
  await assert.rejects(replaceWorkspaceEnvWithBackup({ container: {}, root: '/project', envPath: '/project/.env', backupPath: '/project/.env.backup.injected', backupName: '.env.backup.injected', content: 'APP_MODE=changed\\n', ops }), /injected remote upload failure/);
  assert.equal(files.get('/project/.env'), 'APP_MODE=stable\\n');
  assert.deepEqual([...files.keys()].filter((name) => name.includes('.backup.') || name.includes('.envtmp')), []);
});

test('workspace env transaction: failed atomic move preserves target and removes temp and backup', async () => {
  const files = new Map([['/project/.env', 'APP_MODE=stable\\n']]);
  const ops = {
    exec: async (_container, args) => {
      if (args[0] === 'test') return { code: 0 };
      if (args[0] === 'mv') return { code: 1, stderr: 'injected move failure' };
      if (args[0] === 'rm') { files.delete(args.at(-1)); return { code: 0 }; }
      return { code: 0 };
    },
    read: async (_container, filePath) => ({ content: files.get(filePath), header: { mode: 0o600, uid: 0, gid: 0 } }),
    put: async (_container, directory, name, content) => files.set(path.posix.join(directory, name), content),
  };
  await assert.rejects(replaceWorkspaceEnvWithBackup({ container: {}, root: '/project', envPath: '/project/.env', backupPath: '/project/.env.backup.injected', backupName: '.env.backup.injected', content: 'APP_MODE=changed\\n', ops }), /injected move failure/);
  assert.equal(files.get('/project/.env'), 'APP_MODE=stable\\n');
  assert.deepEqual([...files.keys()].filter((name) => name.includes('.backup.') || name.includes('.envtmp')), []);
});

test('mounted env transaction: partial backup write is removed on failure', async (t) => {
  const { root } = await fixture(t);
  const envPath = path.join(root, '.env');
  const backupPath = path.join(root, '.env.backup.injected');
  await writeFile(envPath, 'APP_MODE=stable\\n');
  const existingStat = await lstat(envPath);
  await assert.rejects(replaceEnvFileWithBackup({ envPath, backupPath, content: 'APP_MODE=changed\\n', existingStat, fsOps: {
    writeFile: async (filePath, ...args) => {
      if (filePath === backupPath) {
        await fsWriteFile(filePath, 'PARTIAL', { encoding: 'utf8', flag: 'wx' });
        throw Object.assign(new Error('injected partial backup failure'), { code: 'EIO' });
      }
      return fsWriteFile(filePath, ...args);
    },
  } }), /injected partial backup failure/);
  assert.equal(await readFile(envPath, 'utf8'), 'APP_MODE=stable\\n');
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.backup.') || name.includes('.tmp.')), []);
});

test('workspace env transaction: partial backup upload is removed on failure', async () => {
  const files = new Map([['/project/.env', 'APP_MODE=stable\\n']]);
  const ops = {
    exec: async (_container, args) => {
      if (args[0] === 'test') return { code: 0 };
      if (args[0] === 'rm') { files.delete(args.at(-1)); return { code: 0 }; }
      return { code: 0 };
    },
    read: async (_container, filePath) => ({ content: files.get(filePath), header: { mode: 0o600, uid: 0, gid: 0 } }),
    put: async (_container, directory, name, content) => {
      const target = path.posix.join(directory, name);
      if (name === '.env.backup.injected') {
        files.set(target, 'PARTIAL');
        throw Object.assign(new Error('injected partial remote backup failure'), { code: 'EIO' });
      }
      files.set(target, content);
    },
  };
  await assert.rejects(replaceWorkspaceEnvWithBackup({ container: {}, root: '/project', envPath: '/project/.env', backupPath: '/project/.env.backup.injected', backupName: '.env.backup.injected', content: 'APP_MODE=changed\\n', ops }), /injected partial remote backup failure/);
  assert.equal(files.get('/project/.env'), 'APP_MODE=stable\\n');
  assert.deepEqual([...files.keys()].filter((name) => name.includes('.backup.') || name.includes('.envtmp')), []);
});

test('project env save: backup creation failure leaves the existing env untouched', async (t) => {
  const { root, project } = await fixture(t);
  await writeFile(path.join(root, '.env'), 'APP_MODE=stable\n', { mode: 0o600 });
  await chmod(root, 0o500);
  try {
    await assert.rejects(saveProjectEnv(project, { raw: 'APP_MODE=changed\n' }));
    assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'APP_MODE=stable\n');
  } finally {
    await chmod(root, 0o700);
  }
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.env.backup.')), []);
});
