#!/usr/bin/env node
// Host-side release evidence maintenance. Never connects to Docker or a database.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ARCHIVE = 'database-before.tar';
const META = ['database-before.sha256', 'deployment-result.json', 'release-method.json'];
const MAX_PLAN_AGE = 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = info => ({ dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(message); };

function rootIdentity(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== fs.realpathSync(root) || [path.parse(root).root, os.homedir()].includes(root)) fail('请指定真实、独立的发布资料目录');
  const info = fs.lstatSync(root);
  if (!info.isDirectory()) fail('发布资料根路径必须为目录');
  return { dev: info.dev, ino: info.ino };
}

function regular(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1) fail('仅处理无符号链接或硬链接的普通文件');
  return info;
}

function metadata(file) {
  const before = regular(file);
  if (before.size > 1024 * 1024) fail('元数据超过 1 MiB');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!same(identity(before), identity(fs.fstatSync(fd)))) fail('读取期间文件已变化');
    const text = fs.readFileSync(fd, 'utf8');
    return { text, digest: hash(text) };
  } finally { fs.closeSync(fd); }
}

function inventory(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (entries.length > 10000) fail('目录条目过多，请缩小发布资料范围');
  const records = [], skipped = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^deploy-\d{8}-[a-zA-Z0-9-]+$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      if (!entry.isDirectory() || fs.realpathSync(directory) !== directory) fail('不是普通发布目录');
      if (fs.existsSync(path.join(directory, '.deploying'))) fail('发布尚未完成');
      const pinned = fs.existsSync(path.join(directory, '.retain'));
      const info = regular(path.join(directory, ARCHIVE));
      const meta = Object.fromEntries(META.map(name => [name, metadata(path.join(directory, name))]));
      const result = JSON.parse(meta['deployment-result.json'].text), method = JSON.parse(meta['release-method.json'].text);
      if (result.healthy !== true || !/^[0-9a-f]{40}$/.test(result.revision || '') || result.revision !== (method.revision || method.sourceRevision)) fail('缺少匹配的成功发布凭据');
      const checksum = /^([a-f0-9]{64})\s+\*?database-before\.tar\s*$/.exec(meta['database-before.sha256'].text);
      if (!checksum || info.size === 0) fail('备份校验记录无效');
      records.push({ directory: entry.name, file: `${entry.name}/${ARCHIVE}`, ...identity(info), sha256: checksum[1], revision: result.revision,
        pinned, directoryIdentity: rootIdentity(directory), metadata: Object.fromEntries(META.map(name => [name, meta[name].digest])) });
    } catch (error) { skipped.push({ directory: entry.name, reason: error.code === 'ENOENT' ? '无完整数据库发布备份' : error.message }); }
  }
  return { records: records.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file)), skipped };
}

function policyOptions({ keep = 2, minAgeHours = 168 } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 2 || keep > 100) fail('至少保留 2 份备份，最多 100 份');
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0 || minAgeHours > 87600) fail('备份最小年龄无效');
  return { keep, minAgeHours };
}

/** Read-only preview. No backup contents, secrets, or broad filesystem traversal. */
export function planRetention(root, options = {}, now = Date.now()) {
  const rootStat = rootIdentity(root), policy = policyOptions(options), { records, skipped } = inventory(root);
  const protectedFiles = new Set(records.slice(0, policy.keep).map(row => row.file));
  const retained = [], candidates = [];
  for (const row of records) {
    const reason = protectedFiles.has(row.file) ? '最近备份' : row.pinned ? '.retain 保留标记' : now - row.mtimeMs < policy.minAgeHours * 3600000 ? '尚未达到清理年龄' : null;
    (reason ? retained : candidates).push(reason ? { ...row, reason } : row);
  }
  const plan = { version: 1, root, rootIdentity: rootStat, policy, createdAt: now, expiresAt: now + MAX_PLAN_AGE,
    retained, candidates, skipped, candidateBytes: candidates.reduce((n, row) => n + row.size, 0) };
  return { ...plan, fingerprint: hash(JSON.stringify(plan)) };
}

async function verifyRetained(root, row) {
  const file = path.join(root, row.file), info = regular(file);
  if (!same(identity(info), identity(row))) fail('保留备份已变化，请重新预览');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!same(identity(fs.fstatSync(fd)), identity(row))) fail('保留备份已变化');
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { fd, autoClose: false, highWaterMark: 1024 * 1024 })) digest.update(chunk);
    if (digest.digest('hex') !== row.sha256 || !same(identity(fs.fstatSync(fd)), identity(row))) fail('保留备份校验失败，已停止清理');
  } finally { fs.closeSync(fd); }
}

function assertCurrent(plan) {
  const current = planRetention(plan.root, plan.policy, plan.createdAt);
  if (!same(plan, current)) fail('清理计划或目录内容已变化，请重新预览');
}

/** Deletes only the exact reviewed old archives, after verifying the newest two. */
export async function applyRetention(plan, now = Date.now()) {
  if (!plan || plan.version !== 1 || !Number.isSafeInteger(plan.createdAt) || now < plan.createdAt || now > plan.expiresAt) fail('清理计划已过期或无效，请重新预览');
  assertCurrent(plan);
  if (plan.retained.length < 2) fail('没有至少两份可保留的有效备份，已停止清理');
  if (!plan.candidates.length) return { deleted: [], reclaimedBytes: 0 };
  const lock = path.join(plan.root, '.release-retention.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  let auditFd;
  try {
    for (const row of plan.retained.filter(row => row.reason === '最近备份')) await verifyRetained(plan.root, row);
    assertCurrent(plan); // A deployment, pin or backup may have changed during hashing.
    if (Date.now() > plan.expiresAt) fail('备份核验期间计划已过期，请重新预览');
    const audit = path.join(plan.root, `release-retention-${randomUUID()}.jsonl`);
    auditFd = fs.openSync(audit, 'wx', 0o600);
    const record = entry => { fs.writeSync(auditFd, JSON.stringify({ at: Date.now(), ...entry }) + '\n'); fs.fsyncSync(auditFd); };
    record({ event: 'started', fingerprint: plan.fingerprint, policy: plan.policy, retained: plan.retained.map(row => row.file) });
    const result = { deleted: [], reclaimedBytes: 0, audit };
    for (const row of plan.candidates) {
      const directory = path.join(plan.root, row.directory), file = path.join(plan.root, row.file);
      if (!same(rootIdentity(plan.root), plan.rootIdentity) || !same(rootIdentity(directory), row.directoryIdentity)
        || fs.existsSync(path.join(directory, '.retain')) || fs.existsSync(path.join(directory, '.deploying'))
        || !same(identity(regular(file)), identity(row))) fail('删除前身份或保留标记变化，已停止后续清理');
      for (const name of META) if (metadata(path.join(directory, name)).digest !== row.metadata[name]) fail('删除前发布凭据变化，已停止后续清理');
      record({ event: 'delete_intent', file: row.file, bytes: row.size, sha256: row.sha256 });
      fs.unlinkSync(file);
      result.deleted.push(row.file); result.reclaimedBytes += row.size;
      record({ event: 'deleted', file: row.file, bytes: row.size });
    }
    record({ event: 'completed', reclaimedBytes: result.reclaimedBytes, deletedCount: result.deleted.length });
    return result;
  } finally { if (auditFd !== undefined) fs.closeSync(auditFd); fs.rmdirSync(lock); }
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('预览: node scripts/release-retention.mjs --root=/outside/releases --plan=/outside/plan.json [--keep=2] [--min-age-hours=168]\n执行: node scripts/release-retention.mjs --apply=/outside/plan.json\n只处理成功发布目录的 database-before.tar；保留最新两份并校验 SHA-256，.retain 可固定保留。');
    return;
  }
  const options = {};
  for (const arg of args) {
    const match = /^--(root|plan|keep|min-age-hours|apply)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) fail('参数无效或重复；使用 --help 查看用法');
    options[match[1]] = match[2];
  }
  if (options.apply) {
    if (Object.keys(options).length !== 1) fail('--apply 不能混用预览参数');
    console.log(JSON.stringify(await applyRetention(JSON.parse(metadata(options.apply).text)), null, 2));
  } else {
    if (!options.root || !options.plan) fail('请指定 --root 与 --plan；默认只预览');
    const plan = planRetention(options.root, { keep: options.keep === undefined ? 2 : Number(options.keep), minAgeHours: options['min-age-hours'] === undefined ? 168 : Number(options['min-age-hours']) });
    fs.writeFileSync(options.plan, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ plan: options.plan, fingerprint: plan.fingerprint, candidates: plan.candidates.map(row => row.file), candidateBytes: plan.candidateBytes, retained: plan.retained.map(row => ({ file: row.file, reason: row.reason })), skipped: plan.skipped }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
