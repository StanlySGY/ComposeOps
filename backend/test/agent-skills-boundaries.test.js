import assert from 'node:assert/strict';
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { listSkills, listSkillCatalog, loadSkill, MAX_SKILL_DIRECTORY_ENTRIES, MAX_SKILL_SCAN_FILES } from '../src/services/agent/skills.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-skill-boundary-'));
  const previous = process.env.AGENT_SKILLS_DIR;
  process.env.AGENT_SKILLS_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_SKILLS_DIR;
    else process.env.AGENT_SKILLS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function write(root, name, body = '只读检查容器状态', extra = '') {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} 运维流程\n${extra}---\n${body}`);
  return file;
}

test('单个技能激活不扫描或打开其他技能，文件修改在下一次激活生效', async t => {
  const root = fixture(t);
  write(root, 'local-one'); write(root, 'unrelated');
  const readdir = t.mock.method(fsp, 'readdir');
  const readFile = t.mock.method(fsp, 'readFile');
  const open = t.mock.method(fsp, 'open');
  assert.match((await loadSkill('local-one')).content, /只读检查/);
  assert.equal(readdir.mock.callCount(), 0, '激活必须按名字定位，不枚举整个目录');
  const paths = [...readFile.mock.calls, ...open.mock.calls].map(c => String(c.arguments[0]));
  assert.equal(paths.some(p => p.includes('unrelated')), false);
  write(root, 'local-one', '最新的只读流程');
  assert.equal((await loadSkill('local-one')).content, '最新的只读流程');
});

test('list 限制在读取阶段生效，不预先打开全部技能正文', async t => {
  const root = fixture(t);
  for (let i = 0; i < 20; i++) write(root, 'test-' + String(i).padStart(2, '0'));
  const readFile = t.mock.method(fsp, 'readFile');
  const open = t.mock.method(fsp, 'open');
  assert.equal((await listSkills(1)).length, 1);
  const customReads = [...readFile.mock.calls, ...open.mock.calls].filter(c => /test-\d\d(?:\/SKILL\.md)?$/.test(String(c.arguments[0])));
  assert.ok(customReads.length <= 1, 'limit=1 只需读取一个合法技能');
});

test('拒绝超大 frontmatter，避免先读完整文件才检查正文大小', async t => {
  const root = fixture(t);
  write(root, 'huge-header', '正文很短', '# ' + 'x'.repeat(100000) + '\n');
  const readFile = t.mock.method(fsp, 'readFile');
  await assert.rejects(loadSkill('huge-header'), /上限|过大|超过/);
  assert.equal(readFile.mock.callCount(), 0, '禁止无边界 readFile');
  assert.equal((await listSkills()).some(s => s.name === 'huge-header'), false);
});

test('损坏的自定义同名技能仍回落到内置版本，普通错误不会暴露路径', async t => {
  const root = fixture(t);
  write(root, 'bad-gateway', '');
  const skill = await loadSkill('bad-gateway');
  assert.equal(skill.metadata.source, 'builtin');
  await assert.rejects(loadSkill('absent'), error => error.statusCode === 404 && !error.message.includes(root));
});

test('拒绝符号链接、硬链接和特殊文件，保留合法的中文多字节正文', async t => {
  const root = fixture(t);
  const original = write(root, 'original', '文'.repeat(20000));
  assert.equal((await loadSkill('original')).content.length, 20000);
  fs.mkdirSync(path.join(root, 'file-link'));
  fs.symlinkSync(original, path.join(root, 'file-link/SKILL.md'));
  fs.symlinkSync(path.join(root, 'original'), path.join(root, 'directory-link'));
  fs.mkdirSync(path.join(root, 'hard-link'));
  fs.linkSync(original, path.join(root, 'hard-link/SKILL.md'));
  fs.mkdirSync(path.join(root, 'named-pipe'));
  execFileSync('mkfifo', [path.join(root, 'named-pipe/SKILL.md')]);
  for (const name of ['file-link', 'directory-link', 'hard-link', 'named-pipe', 'original']) {
    await assert.rejects(loadSkill(name));
  }
});

test('目录在打开后被替换时仍读取原目录句柄内的文件，不跟随新符号链接', { skip: process.platform !== 'linux' }, async t => {
  const root = fixture(t), source = path.join(root, 'target');
  write(root, 'target', '来自允许目录的原文');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-skill-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const external = write(outside, 'target', '外部目录不得读取');
  const originalOpen = fsp.open;
  let replaced = false;
  t.mock.method(fsp, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (!replaced && String(args[0]).endsWith('/target')) {
      replaced = true;
      fs.renameSync(source, path.join(root, 'original-target'));
      fs.symlinkSync(path.dirname(external), source);
    }
    return handle;
  });
  assert.equal((await loadSkill('target')).content, '来自允许目录的原文');
  await assert.rejects(loadSkill('target'));
});

test('只读单个技能时大稀疏文件在读内容前拒绝，不影响正常技能', async t => {
  const root = fixture(t);
  const huge = write(root, 'huge'); fs.truncateSync(huge, 2 ** 31);
  write(root, 'normal');
  await assert.rejects(loadSkill('huge'), { statusCode: 413 });
  assert.equal((await loadSkill('normal')).metadata.name, 'normal');
});

test('目录和技能读取预算均可见，partial 不冒充完整目录', async t => {
  const root = fixture(t);
  for (let i = 0; i < MAX_SKILL_SCAN_FILES + 20; i++) write(root, 'invalid-' + String(i).padStart(4, '0'), '');
  const catalog = await listSkillCatalog();
  assert.equal(catalog.partial, true);
  assert.ok(catalog.scanned <= MAX_SKILL_SCAN_FILES);
  assert.ok(catalog.skipped <= MAX_SKILL_SCAN_FILES);
  assert.ok(catalog.skills.some(skill => skill.name === 'bad-gateway'), '损坏自定义目录不能挤掉内置目录');
  assert.equal((await loadSkill('bad-gateway')).metadata.source, 'builtin', '目录预算不能阻止按名称加载');
});

test('限制目录枚举数量，关闭目录句柄，过滤不符合命名要求的项', async t => {
  fixture(t);
  let reads = 0, closed = 0;
  t.mock.method(fsp, 'opendir', async () => ({
    async *[Symbol.asyncIterator]() {
      try {
        for (let i = 0; i < MAX_SKILL_DIRECTORY_ENTRIES * 2; i++) {
          reads++;
          yield { name: '.ignored-' + i, isDirectory: () => true, isSymbolicLink: () => false };
        }
      } finally { closed++; }
    },
  }));
  const catalog = await listSkillCatalog();
  assert.equal(catalog.partial, true);
  assert.equal(closed, 2);
  assert.equal(reads, 2 * (MAX_SKILL_DIRECTORY_ENTRIES + 1));
});

test('拒绝过大 YAML 头和非字符串元数据，错误不把宿主路径暴露给模型', async t => {
  const root = fixture(t);
  write(root, 'header-budget', '正文', '# ' + 'x'.repeat(9000) + '\n');
  await assert.rejects(loadSkill('header-budget'), /frontmatter 超过/);
  const invalid = write(root, 'invalid-type');
  fs.writeFileSync(invalid, '---\nname: invalid-type\ndescription: [a, b]\n---\ntext');
  await assert.rejects(loadSkill('invalid-type'), /必须是字符串/);
  t.mock.method(fsp, 'open', async () => { throw Object.assign(new Error('EACCES ' + root), { code: 'EACCES' }); });
  await assert.rejects(loadSkill('private'), cause => cause.statusCode === 404 && !cause.message.includes(root));
});

test('扫描受限时仍保证同名自定义技能优先，返回与按名称激活一致', async t => {
  const root = fixture(t);
  write(root, 'bad-gateway', '自定义只读规则');
  const original = fsp.opendir;
  t.mock.method(fsp, 'opendir', async location => location === root ? {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i <= MAX_SKILL_DIRECTORY_ENTRIES; i++) yield { name: '.skip-' + i, isDirectory: () => true, isSymbolicLink: () => false };
    },
  } : original(location));
  const catalog = await listSkillCatalog();
  const metadata = catalog.skills.find(s => s.name === 'bad-gateway');
  assert.equal(catalog.partial, true);
  assert.equal(metadata.source, 'custom');
  assert.deepEqual((await loadSkill('bad-gateway')).metadata, metadata);
});

test('并发成功和失败的技能读取结束后释放文件句柄', { skip: process.platform !== 'linux' }, async t => {
  const root = fixture(t); write(root, 'valid'); write(root, 'empty', '');
  const before = fs.readdirSync('/proc/self/fd').length;
  const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => loadSkill(i % 2 ? 'valid' : 'empty')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 20);
  assert.ok(fs.readdirSync('/proc/self/fd').length <= before + 1);
});

test('自定义根目录不可读时目录标记为部分，正常缺失目录不误报损坏文件', async t => {
  const root = fixture(t), original = fsp.opendir;
  t.mock.method(fsp, 'opendir', async location => {
    if (location === root) throw Object.assign(new Error('blocked'), { code: 'EACCES' });
    return original(location);
  });
  const catalog = await listSkillCatalog();
  assert.equal(catalog.partial, true);
  assert.equal(catalog.skipped, 0);
  assert.ok(catalog.skills.some(s => s.source === 'builtin'));
});
