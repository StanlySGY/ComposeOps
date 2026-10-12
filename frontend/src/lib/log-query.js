/**
 * 结构化日志查询解析器(Dozzle 式字段谓词 + 短语 + 正则 + 或)。
 *
 * 语法:
 *   空格 = 与;`|` = 或;前缀 `!` = 非
 *   level:error            级别(error / warn / info,别名 lv、lvl)
 *   container:api          容器名子串匹配(别名 service、name、svc)
 *   stream:stderr          输出流(stdout / stderr,别名 type、io)
 *   after:09:30            时间下限,接受 HH:MM[:SS] 或完整 RFC3339(别名 since、from)
 *   before:2026-10-12T09:00 时间上限(别名 until、to)
 *   "连接超时"             整串短语(含空格时必须加引号)
 *   /retry|timeout/i       正则逃生舱
 *   !health                取反任意条件
 *
 * 未知字段(如 `http://x`)按普通文本处理,避免把日志里的冒号误判成语法错误。
 */

const FIELD_ALIASES = {
  level: 'level', lv: 'level', lvl: 'level',
  container: 'container', service: 'container', name: 'container', svc: 'container',
  stream: 'stream', type: 'stream', io: 'stream',
  after: 'after', since: 'after', from: 'after',
  before: 'before', until: 'before', to: 'before',
};
const LEVEL_ALIASES = { error: 'error', err: 'error', fatal: 'error', warn: 'warn', warning: 'warn', info: 'info', debug: 'info' };
const STREAM_VALUES = new Set(['stdout', 'stderr']);

export const QUERY_SYNTAX = [
  { token: 'level:error', note: '只看某个级别(可写 lv:、lvl:)' },
  { token: 'container:api', note: '只看某个容器(可写 service:、name:)' },
  { token: 'stream:stderr', note: '只看标准错误(可写 type:、io:)' },
  { token: 'after:09:30', note: '时间下限,HH:MM[:SS] 或 RFC3339' },
  { token: '"连接超时"', note: '整串短语,含空格必须加引号' },
  { token: '/retry|timeout/i', note: '正则逃生舱' },
  { token: '!health', note: '取反任意条件' },
  { token: 'a b | c', note: '空格即“与”,`|` 即“或”' },
];

/** 按引号外的 `|` 切“或”分支。 */
function splitBranches(text) {
  return scanTop(text, (char) => char === '|');
}

/** 按引号外的空白切条件。空段直接丢弃,`a  b`、`a |` 这类写法不该报错。 */
function splitTerms(text) {
  const scanned = scanTop(text, (char) => /\s/.test(char));
  return { parts: scanned.parts.filter(Boolean), quote: scanned.quote };
}

const isTopSeparator = (char) => char === '|' || /\s/.test(char);

/**
 * 从 `text[index]` 的 `/` 起尝试匹配一个完整的正则字面量:非空正文 + 闭合斜杠 + 标志位,
 * 且字面量之后必须是分隔符或结尾。返回 `{ close, end }`,不是字面量时返回 `null`。
 * 这样 `/var/log/app`、`http://x` 这类路径不会被误判成正则。
 */
function scanRegexLiteral(text, index) {
  let cursor = index + 1;
  while (cursor < text.length) {
    // 正文里的 \/ 是转义斜杠,不能当成闭合。
    if (text[cursor] === '\\') { cursor += 2; continue; }
    if (text[cursor] === '/') break;
    cursor += 1;
  }
  if (cursor <= index + 1 || cursor >= text.length) return null;
  const close = cursor;
  cursor += 1;
  while (cursor < text.length && /[a-z]/.test(text[cursor])) cursor += 1;
  if (cursor < text.length && !isTopSeparator(text[cursor])) return null;
  return { close, end: cursor };
}

/**
 * 统一的顶层扫描:引号串与 `/正则/` 都算一个整体,内部的 `|` 和空白不作为分隔符。
 * 只有在条件起始处出现的 `/` 才尝试按正则字面量处理。
 */
function scanTop(text, isSeparator) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '/' && (current === '' || current === '!')) {
      const literal = scanRegexLiteral(text, index);
      if (literal) {
        current += text.slice(index, literal.end);
        index = literal.end - 1;
        continue;
      }
    }
    if (isSeparator(char)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return { parts, quote };
}

function parseTime(value) {
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    const seconds = clock[3] === undefined ? 0 : Number(clock[3]);
    if (hours <= 23 && minutes <= 59 && seconds <= 59) return { hours, minutes, seconds };
    return null;
  }
  if (!/[T ]/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : { at };
}

const REGEX_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);
/** 标志位必须全是合法正则标志,否则 `/var/log/app` 这类路径会被误判成正则。 */
function isLegalFlags(flags) {
  return [...flags].every((flag) => REGEX_FLAGS.has(flag));
}

function parseTerm(raw) {
  let text = raw;
  let negate = false;
  if (text.startsWith('!')) {
    negate = true;
    text = text.slice(1);
  }
  if (!text) return { error: '取反符 `!` 后面缺少条件' };

  const quote = text[0];
  if (quote === '"' || quote === "'") {
    if (text.length < 2 || text.at(-1) !== quote) return { error: `引号没有闭合:${raw}` };
    return { kind: 'text', value: text.slice(1, -1).toLowerCase(), negate };
  }

  // 词法阶段已把 `/正则/标志` 当一个整体,这里只负责拆正文与标志位。
  const literal = /^\/(.+)\/([a-z]*)$/.exec(text);
  if (literal && isLegalFlags(literal[2])) {
    try {
      // 固定加 i:日志级别与容器名匹配本来就忽略大小写。
      return { kind: 'regex', regex: new RegExp(literal[1], 'i'), negate };
    } catch {
      return { error: `正则表达式无效:${raw}` };
    }
  }

  const colon = text.indexOf(':');
  const field = colon > 0 ? FIELD_ALIASES[text.slice(0, colon).toLowerCase()] : null;
  if (!field) return { kind: 'text', value: text.toLowerCase(), negate };

  const value = text.slice(colon + 1);
  if (!value) return { error: `字段 ${field}: 缺少取值` };
  if (field === 'level') {
    const level = LEVEL_ALIASES[value.toLowerCase()];
    if (!level) return { error: `级别 "${value}" 不存在(可用 error / warn / info)` };
    return { kind: 'level', level, negate };
  }
  if (field === 'stream') {
    const stream = value.toLowerCase();
    if (!STREAM_VALUES.has(stream)) return { error: `输出流 "${value}" 不存在(可用 stdout / stderr)` };
    return { kind: 'stream', stream, negate };
  }
  if (field === 'container') return { kind: 'container', value: value.toLowerCase(), negate };

  const time = parseTime(value);
  if (!time) return { error: `时间 "${value}" 无法解析(可用 HH:MM:SS 或 2026-10-12T09:30)` };
  return { kind: 'time', mode: field, time, negate };
}

/** 解析查询串。返回 `{ branches, error }`;`error` 非空时调用方应保留上一批日志而不是静默清空。 */
export function parseLogQuery(input) {
  const text = String(input || '').trim();
  if (!text) return { branches: [], error: '', active: false };

  const { parts: rawBranches, quote } = splitBranches(text);
  if (quote) return { branches: [], error: '引号没有闭合', active: true };

  const branches = [];
  for (const branch of rawBranches) {
    const { parts: terms, quote: branchQuote } = splitTerms(branch);
    if (branchQuote) return { branches: [], error: '引号没有闭合', active: true };
    if (!terms.length) continue;
    const parsed = [];
    for (const term of terms) {
      const result = parseTerm(term);
      if (result.error) return { branches: [], error: result.error, active: true };
      parsed.push(result);
    }
    branches.push(parsed);
  }
  return { branches, error: '', active: true };
}

function matchTime(term, line) {
  // 没有服务端时间戳的行无法证明落在窗口内,直接判否,避免把未知时间当成命中。
  if (!line.ts) return false;
  if (term.time.at) {
    const at = Date.parse(line.ts);
    return !Number.isNaN(at) && (term.mode === 'after' ? at >= term.time.at : at <= term.time.at);
  }
  // HH:MM 形式按时间戳字符串自身的时刻比较,和行首显示的时间一致;
  // 若按本地时区解释,查询窗口会和界面显示差一个时区偏移。
  const clock = /T(\d{2}):(\d{2}):(\d{2})/.exec(line.ts);
  if (!clock) return false;
  const at = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const target = term.time.hours * 3600 + term.time.minutes * 60 + term.time.seconds;
  return term.mode === 'after' ? at >= target : at <= target;
}

function matchTerm(term, line) {
  let hit;
  switch (term.kind) {
    case 'text': hit = String(line.data || '').toLowerCase().includes(term.value); break;
    case 'regex': hit = term.regex.test(String(line.data || '')); break;
    case 'level': hit = (line.level || 'info') === term.level; break;
    case 'stream': hit = (line.type || 'stdout') === term.stream; break;
    case 'container': hit = String(line.containerName || '').toLowerCase().includes(term.value); break;
    case 'time': hit = matchTime(term, line); break;
    default: hit = true;
  }
  return term.negate ? !hit : hit;
}

/** 命中判定:无有效条件时全通过;分支之间“或”,分支内条件“与”。 */
export function matchLogQuery(parsed, line) {
  if (!parsed || !parsed.branches || !parsed.branches.length) return true;
  return parsed.branches.some((terms) => terms.every((term) => matchTerm(term, line)));
}
