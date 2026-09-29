/**
 * Agent Skills 的受限读取器。
 *
 * 只处理每个技能目录下的 SKILL.md 元数据和正文,不执行 scripts/ 或读取其它附件。
 * 自定义技能放在 backend/data/skills(可用 AGENT_SKILLS_DIR 覆盖),内置技能随代码发布。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, '../../data/skills');
const DEFAULT_CUSTOM_SKILLS_DIR = path.resolve(__dirname, '../../../data/skills');
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SKILL_BODY_LENGTH = 20000;

function error(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function customSkillsDir() {
  return path.resolve(process.env.AGENT_SKILLS_DIR || DEFAULT_CUSTOM_SKILLS_DIR);
}

function skillRoots() {
  const roots = [
    { root: customSkillsDir(), source: 'custom' },
    { root: BUILTIN_SKILLS_DIR, source: 'builtin' },
  ];
  const seen = new Set();
  return roots.filter(({ root }) => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}

function assertSkillName(name) {
  const value = String(name || '').trim();
  if (!SKILL_NAME.test(value)) throw error('技能名称格式不合法,只允许小写字母、数字和连字符');
  return value;
}

function childPath(root, name) {
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, name);
  const relative = path.relative(rootPath, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw error('技能路径不在允许目录内');
  }
  return target;
}

function parseSkillDocument(raw, directoryName, source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw error('SKILL.md 缺少 YAML frontmatter');
  let frontmatter;
  try {
    frontmatter = YAML.parse(match[1]) || {};
  } catch (cause) {
    throw error(`SKILL.md frontmatter 无法解析: ${cause.message}`);
  }
  const name = String(frontmatter.name || '').trim();
  const description = String(frontmatter.description || '').replace(/\s+/g, ' ').trim();
  if (!SKILL_NAME.test(name) || name !== directoryName) {
    throw error('技能 name 必须是小写字母/数字/连字符,且与目录名一致');
  }
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    throw error(`技能 description 必须为 1-${MAX_DESCRIPTION_LENGTH} 个字符`);
  }
  const content = raw.slice(match[0].length).trim();
  if (!content) throw error('SKILL.md 正文不能为空');
  if (content.length > MAX_SKILL_BODY_LENGTH) {
    throw error(`SKILL.md 正文不能超过 ${MAX_SKILL_BODY_LENGTH} 个字符`);
  }
  return {
    metadata: { name, description, source },
    content,
  };
}

async function readSkill(root, directoryName, source) {
  const directoryPath = childPath(root, directoryName);
  const directoryStat = await fs.lstat(directoryPath).catch(() => null);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) return null;
  const filePath = path.join(directoryPath, 'SKILL.md');
  const fileStat = await fs.lstat(filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) return null;
  const raw = await fs.readFile(filePath, 'utf8');
  return parseSkillDocument(raw, directoryName, source);
}

async function readRoot(rootConfig) {
  const entries = await fs.readdir(rootConfig.root, { withFileTypes: true }).catch(() => []);
  const skills = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SKILL_NAME.test(entry.name)) continue;
    try {
      const skill = await readSkill(rootConfig.root, entry.name, rootConfig.source);
      if (skill) skills.push(skill);
    } catch {
      // 单个技能损坏时跳过,不让一个用户文件阻断 Agent 其它能力。
    }
  }
  return skills;
}

async function readAllSkills() {
  const byName = new Map();
  for (const root of skillRoots()) {
    for (const skill of await readRoot(root)) {
      // custom 在前,同名自定义技能覆盖内置版本,便于用户针对环境调整流程。
      if (!byName.has(skill.metadata.name)) byName.set(skill.metadata.name, skill);
    }
  }
  return [...byName.values()];
}

export async function listSkills(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 100), 100));
  return (await readAllSkills()).slice(0, safeLimit).map(({ metadata }) => ({ ...metadata }));
}

export async function loadSkill(name) {
  const requested = assertSkillName(name);
  const skill = (await readAllSkills()).find((item) => item.metadata.name === requested);
  if (!skill) throw error(`未找到技能: ${requested}`, 404);
  return skill;
}

export { MAX_SKILL_BODY_LENGTH, SKILL_NAME };
