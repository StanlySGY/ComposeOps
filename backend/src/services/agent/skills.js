/**
 * Agent Skills 的受限读取器。
 *
 * 只处理每个技能目录下的 SKILL.md 元数据和正文,不执行 scripts/ 或读取其它附件。
 * 自定义技能放在 backend/data/skills(可用 AGENT_SKILLS_DIR 覆盖),内置技能随代码发布。
 */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { readHostConfigFile } from '../../lib/config-file-read.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILLS_DIR = path.resolve(__dirname, '../../data/skills');
const DEFAULT_CUSTOM_SKILLS_DIR = path.resolve(__dirname, '../../../data/skills');
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SKILL_BODY_LENGTH = 20000;
export const MAX_SKILL_FILE_BYTES = 96 * 1024;
export const MAX_SKILL_FRONTMATTER_BYTES = 8 * 1024;
export const MAX_SKILL_DIRECTORY_ENTRIES = 2048;
export const MAX_SKILL_SCAN_FILES = 256;
const CUSTOM_SCAN_RESERVE = 32; // Leave room for builtin skills and exact custom overrides.

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
  if (Buffer.byteLength(match[1], 'utf8') > MAX_SKILL_FRONTMATTER_BYTES) {
    throw error(`SKILL.md frontmatter 超过 ${MAX_SKILL_FRONTMATTER_BYTES} 字节上限`);
  }
  let frontmatter;
  try {
    frontmatter = YAML.parse(match[1]) || {};
  } catch (cause) {
    throw error(`SKILL.md frontmatter 无法解析: ${cause.message}`);
  }
  if (typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string') {
    throw error('技能 name 与 description 必须是字符串');
  }
  const name = frontmatter.name.trim();
  const description = frontmatter.description.replace(/\s+/g, ' ').trim();
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
  let rootHandle, directoryHandle;
  try {
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    rootHandle = await fs.open(root, flags);
    // Linux production uses directory descriptors so a renamed directory or a
    // symlink swapped into an ancestor cannot redirect the subsequent file read.
    const anchoredRoot = process.platform === 'linux' ? `/proc/self/fd/${rootHandle.fd}` : root;
    directoryHandle = await fs.open(path.join(anchoredRoot, directoryName), flags);
    const directoryStat = await directoryHandle.stat();
    if (!directoryStat.isDirectory()) return null;
    const anchoredDirectory = process.platform === 'linux' ? `/proc/self/fd/${directoryHandle.fd}` : directoryPath;
    const filePath = path.join(anchoredDirectory, 'SKILL.md');
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.nlink !== 1) return null;
    const { content, stat } = await readHostConfigFile(filePath, { maxBytes: MAX_SKILL_FILE_BYTES });
    if (stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev) throw error('读取期间技能文件发生变化，请重新读取', 409);
    if (process.platform !== 'linux') {
      const after = await fs.lstat(directoryPath);
      if (!after.isDirectory() || after.ino !== directoryStat.ino || after.dev !== directoryStat.dev) throw error('读取期间技能目录发生变化，请重新读取', 409);
    }
    return parseSkillDocument(content, directoryName, source);
  } finally {
    try { await directoryHandle?.close(); }
    finally { await rootHandle?.close(); }
  }
}

async function readRoot(rootConfig) {
  const entries = [];
  let scanned = 0, partial = false;
  try {
    const directory = await fs.opendir(rootConfig.root);
    for await (const entry of directory) {
      if (++scanned > MAX_SKILL_DIRECTORY_ENTRIES) { partial = true; break; }
      if (entry.isDirectory() && !entry.isSymbolicLink() && SKILL_NAME.test(entry.name)) entries.push(entry.name);
    }
  } catch (cause) {
    // A missing custom root is normal; unreadable/incomplete scans are not proof
    // that no additional skills exist.
    if (cause.code !== 'ENOENT') partial = true;
  }
  return { names: entries.sort((a, b) => a.localeCompare(b)), partial };
}

export async function listSkillCatalog(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 100), 100));
  const byName = new Map(), attemptedCustom = new Set(), roots = skillRoots();
  let scanned = 0, customScanned = 0, skipped = 0, partial = false;
  async function read(root, name) {
    if (scanned >= MAX_SKILL_SCAN_FILES) { partial = true; return null; }
    scanned++;
    if (root.source === 'custom') attemptedCustom.add(name);
    try { return await readSkill(root.root, name, root.source); }
    catch (cause) { if (cause.code !== 'ENOENT') skipped++; return null; }
  }
  for (const root of roots) {
    const catalog = await readRoot(root);
    partial ||= catalog.partial;
    for (const name of catalog.names) {
      if (byName.has(name)) continue;
      if (byName.size >= safeLimit || scanned >= MAX_SKILL_SCAN_FILES
        || (root.source === 'custom' && customScanned >= MAX_SKILL_SCAN_FILES - CUSTOM_SCAN_RESERVE)) { partial = true; break; }
      // Even a truncated custom directory cannot make builtin metadata disagree
      // with the higher-priority custom skill that activation would actually use.
      let skill = root.source === 'builtin' && !attemptedCustom.has(name)
        ? await read(roots[0], name) : null;
      if (root.source === 'custom') customScanned++;
      skill ||= await read(root, name);
      if (skill) byName.set(name, { ...skill.metadata });
    }
  }
  return { skills: [...byName.values()], partial, scanned, skipped };
}

export async function listSkills(limit = 100) {
  return (await listSkillCatalog(limit)).skills;
}

export async function loadSkill(name) {
  const requested = assertSkillName(name);
  let invalid;
  for (const root of skillRoots()) {
    try {
      const skill = await readSkill(root.root, requested, root.source);
      if (skill) return skill;
    } catch (cause) {
      if (cause.statusCode) invalid ||= cause;
    }
  }
  if (invalid) throw invalid;
  throw error(`未找到可读取的技能: ${requested}`, 404);
}

export { MAX_SKILL_BODY_LENGTH, SKILL_NAME };
