/**
 * 值级密钥脱敏(SecretSet 式,借鉴 EnsoCode src/main/services/secretRedactor.ts)。
 *
 * redaction.js 的键名正则只能挡"键名敏感"的结构化字段,防不住
 * `MYSQL_ROOT_PASSWORD=xxx` 这类值以自由文本形态出现在日志/工具结果里。
 * 这里补第二层:工具结果回喂 LLM 前先 harvest——凡键名命中 SENSITIVE_KEY 的
 * 值都会被收进"已知密钥值"集合;之后 redact() 把这些值在一切出站文本
 * (工具结果、挂载日志、页面上下文、最终回复、持久化历史)里的再次出现抹掉。
 *
 * 单用户控制台,集合按进程生命周期累积;提供 reset 仅供测试。
 */
import { isSensitiveKey, redactText } from './redaction.js';

const VALUE_MIN = 4;
const VALUE_MAX = 400;
const MAX_VALUES = 300;

/** KEY=VALUE(KEY 形态宽松,由 isSensitiveKey 把关)与 JSON "KEY":"VALUE" 两种收割形态。 */
const HARVEST_PATTERNS = [
  /(?:^|[\n|;,]|[\s"'{(])([A-Za-z][A-Za-z0-9_.-]{1,63})\s*=\s*(?:"([^"\n]{1,400})"|'([^'\n]{1,400})'|([^\s,;|&`]{1,400}))/g,
  /"([A-Za-z][A-Za-z0-9_.-]{1,63})"\s*:\s*"([^"\n]{1,400})"/g,
];

/** 不依赖键名的静态密钥形态(与 redaction.js 的键值形态互补)。 */
const STATIC_SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(gh[pou]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[bparsa]-[A-Za-z0-9-]{10,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
];

const harvested = new Set();

function looksLikePlaceholder(value) {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (/^(?:\[?redacted\]?|\*+|x{3,}|\.{3,}|<{2,}|>{2,}|null|none|empty|changeme|change[-_]?me|your[-_]?[a-z]+|todo|example|test|placeholder|<[^>]+>|\$\{[^}]*\})$/.test(v)) return true;
  return false;
}

/**
 * 从任意文本收割敏感值(键名命中 SENSITIVE_KEY 才收),去重并限制集合规模。
 * 返回本次新收割的值数量,便于测试与调试。
 */
export function harvestSecretValues(text) {
  const source = String(text ?? '');
  if (!source || source.length > 2_000_000) return 0;
  let added = 0;
  for (const pattern of HARVEST_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const key = match[1];
      const value = [match[2], match[3], match[4]].find((item) => typeof item === 'string' && item.length) || '';
      if (!key || !isSensitiveKey(key)) continue;
      const trimmed = value.trim();
      if (trimmed.length < VALUE_MIN || trimmed.length > VALUE_MAX) continue;
      if (looksLikePlaceholder(trimmed)) continue;
      if (!harvested.has(trimmed)) {
        // 集合超限时淘汰最早的一条,保持内存与替换成本有界
        if (harvested.size >= MAX_VALUES) harvested.delete(harvested.values().next().value);
        harvested.add(trimmed);
        added += 1;
      }
    }
  }
  return added;
}

/**
 * 对出站文本做值级脱敏:先过键值形态/Bearer 的静态规则,再按"最长优先"
 * 逐个替换已知密钥值(split/join 避免正则转义问题),最后补静态 token 形态。
 */
export function redactSecrets(text) {
  let out = redactText(text);
  if (harvested.size) {
    const values = [...harvested].sort((a, b) => b.length - a.length);
    for (const value of values) out = out.split(value).join('[REDACTED]');
  }
  for (const pattern of STATIC_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/**
 * 对将要持久化或输出的结构化数据递归脱敏。
 * 既处理敏感字段名，也处理此前从配置/日志中收割到的秘密值及自由文本中的重复出现。
 */
export function redactSecretValue(value, key = '') {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactSecretValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSecretValue(entryValue, entryKey),
    ]));
  }
  return value;
}

/** 仅供测试:清空已收割集合。 */
export function resetSecretRedactor() {
  harvested.clear();
}
