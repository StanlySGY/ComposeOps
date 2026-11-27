import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = await mkdtemp(path.join(os.tmpdir(), 'compose-file-safety-'));
process.env.DB_PATH = path.join(root, 'state.db');
const cli = path.join(root, 'compose.mjs');
await writeFile(cli, `import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const args=process.argv.slice(2), file=args[args.indexOf('-f')+1], folder=path.dirname(file);
if(existsSync(path.join(folder,'external-edit'))) writeFileSync(path.join(folder,'compose.yml'),readFileSync(path.join(folder,'external-edit')));
if(existsSync(path.join(folder,'external-chmod'))) chmodSync(path.join(folder,'compose.yml'),0o600);
if(existsSync(path.join(folder,'revoke-permission'))) { const db=new DatabaseSync(process.env.DB_PATH);db.prepare('UPDATE project_preferences SET mount_enabled=0 WHERE project_id=?').run(folder);db.close(); }
`);
process.env.COMPOSE_BIN = `${process.execPath} ${cli}`;
const { saveCompose, readCompose } = await import('../src/services/compose-runner.js');
const { listComposeBackups, setProjectPreference } = await import('../src/lib/db.js');
const original = 'services:\n  app:\n    image: nginx:old\n';
const desired = original.replace('old', 'new'), external = original.replace('old', 'external');
async function fixture() {
  const folder = await mkdtemp(path.join(root, 'project-')), file = path.join(folder, 'compose.yml');
  await writeFile(file, original, { mode: 0o640 });
  const project = { id: folder, projectName: 'safe-file', workingDir: folder, composeFiles: [file], managed: true, editable: true };
  setProjectPreference(project.id, { managed: true, mountEnabled: true });
  return { folder, file, project };
}
test('Compose CLI 校验期间发生外部编辑，保存必须拒绝覆盖且保留外部内容', async () => {
  const { project, folder, file } = await fixture();
  await writeFile(path.join(folder, 'external-edit'), external);
  await assert.rejects(saveCompose(project, 0, desired, 'save', original), { statusCode: 409, code: 'COMPOSE_VERSION_CONFLICT' });
  assert.equal(await readFile(file, 'utf8'), external);
  assert.equal(listComposeBackups(project.id).length, 0);
  assert.deepEqual((await readdir(folder)).filter(name => name.startsWith('.composeops-')), []);
});
test('本地 Compose 保存限制 UTF-8 字节数，不能用多字节文本绕过 2MiB', async () => {
  const { project, file } = await fixture();
  const oversized = 'x-test: "' + '中'.repeat(750_000) + '"\nservices: {}\n';
  await assert.rejects(saveCompose(project, 0, oversized), { statusCode: 413 });
  assert.equal(await readFile(file, 'utf8'), original);
});
test('本地 Compose 读取也拒绝超过 2MiB 的文件', async () => {
  const { project, file } = await fixture();
  await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(readCompose(project), { statusCode: 413 });
});
test('正常保存保留文件权限、完成备份，失败的旧版本不能覆盖新版本', async () => {
  const { project, file } = await fixture();
  await saveCompose(project, 0, desired, 'save', original);
  assert.equal(await readFile(file, 'utf8'), desired);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.equal(listComposeBackups(project.id).length, 1);
  await assert.rejects(saveCompose(project, 0, external, 'save', original), { statusCode: 409 });
  assert.equal(await readFile(file, 'utf8'), desired);
});
test('校验过程中撤销目录权限，旧快照不能落盘', async () => {
  const { project, folder, file } = await fixture();
  await writeFile(path.join(folder, 'revoke-permission'), '1');
  await assert.rejects(saveCompose(project, 0, desired, 'save', original), { statusCode: 403 });
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(listComposeBackups(project.id).length, 0);
});
test('校验过程中仅收紧文件权限，内容未变也不能用旧权限发布', async () => {
  const { project, folder, file } = await fixture();
  await writeFile(path.join(folder, 'external-chmod'), '1');
  await assert.rejects(saveCompose(project, 0, desired, 'save', original), { statusCode: 409, code: 'COMPOSE_VERSION_CONFLICT' });
  assert.equal(await readFile(file, 'utf8'), original); assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(listComposeBackups(project.id).length, 0);
});
test.after(async () => { (await import('../src/lib/db.js')).default.close(); await rm(root, { recursive: true, force: true }); });
