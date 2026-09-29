import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-skills-'));
process.env.AGENT_SKILLS_DIR = tempDir;

const { listSkills, loadSkill } = await import('../src/services/agent/skills.js');
const { getAgent } = await import('../src/services/agent.js');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function writeSkill(name, body, description = `${name} test skill`) {
  const directory = path.join(tempDir, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
  ].join('\n'));
}

test('agent-skills: 只发现元数据,自定义技能覆盖同名内置技能', async () => {
  writeSkill('compose-incident-triage', 'custom procedure');
  writeSkill('local-check', 'read-only procedure');
  fs.mkdirSync(path.join(tempDir, 'invalid'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'invalid', 'SKILL.md'), '# no frontmatter');
  fs.mkdirSync(path.join(tempDir, 'not-a-skill'), { recursive: true });

  const skills = await listSkills();
  const names = new Set(skills.map((skill) => skill.name));
  assert.ok(names.has('compose-incident-triage'));
  assert.ok(names.has('bad-gateway'), '内置技能仍应可发现');
  assert.ok(names.has('local-check'));
  assert.equal(skills.find((skill) => skill.name === 'compose-incident-triage').source, 'custom');
  assert.equal('content' in skills[0], false, '发现阶段不得加载正文');
});

test('agent-skills: 按需读取正文并拒绝路径穿越/超长正文', async () => {
  writeSkill('local-check', '先读取状态,再输出证据');
  const skill = await loadSkill('local-check');
  assert.equal(skill.metadata.name, 'local-check');
  assert.match(skill.content, /先读取状态/);

  await assert.rejects(() => loadSkill('../local-check'), /技能名称格式不合法/);
  writeSkill('too-long', 'x'.repeat(20001));
  assert.equal((await listSkills()).some((item) => item.name === 'too-long'), false);
});

test('agent-skills: 两个技能工具是只读工具且 skill.use 不执行附件', async () => {
  const tools = new Map(getAgent().listTools().map((tool) => [tool.name, tool]));
  assert.equal(tools.get('skill.list').requiredPermission, 'readonly');
  assert.equal(tools.get('skill.use').confirmationRequired, false);
  assert.equal(tools.get('skill.use').parameters.required[0], 'name');

  const agent = getAgent();
  const result = await agent.executeTool('skill.use', { name: 'local-check' });
  assert.equal(result.success, true);
  assert.equal(result.result.untrusted, true);
  assert.match(result.result.instructions, /AGENT_SKILL#/);
  assert.match(result.result.instructions, /先读取状态/);
});
