/**
 * .env 解析与序列化工具(与具体存储位置解耦,便于独立单测)。
 *
 * 格式说明(兼容 docker compose / dotenv 常见语法):
 *  - 行首 `#` 为整行注释;行内 ` #` 起始的注释可附加到条目(仅单行值场景)。
 *  - 支持 `KEY=v`、`KEY='v'`、`KEY="v"`、`export KEY=v`。
 *  - 引号内的 `#` 不会被视为注释,支持基础转义。
 *  - 空行与纯注释行保留在 raw 中,序列化时尽量保持原样。
 *
 * 敏感变量识别:KEY 中含 SECRET / TOKEN / PASSWORD / PASSWD / PASS / API_KEY 等。
 */

const SECRET_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|\bPASS\b|(?:API|PRIVATE|ACCESS|SECRET|AUTH|SIGNING)[_-]?KEY)/i;

/** 判断键名是否应默认脱敏。 */
export function isSecretKey(key) {
  return SECRET_PATTERN.test(key || '');
}

/**
 * 解析 .env 文本为条目；保留转义文本，不执行变量替换。
 * @param {string} text
 * @returns {Array<{key:string, value:string, comment?:string, isSecret:boolean}>}
 */
export function parseDotenv(text) {
  return parseDotenvDocument(text).nodes.map(({ key, value, comment, isSecret }) => ({ key, value, comment, isSecret }));
}

/**
 * 序列化结构化条目为 .env 文本。条目按给定顺序输出。
 */
export function serializeDotenv(entries) {
  return (entries || [])
    .map((entry) => {
      const key = String(entry.key || '').trim();
      if (!key) return '';
      const lines = [];
      if (entry.comment) lines.push(`# ${entry.comment}`);
      const value = String(entry.value ?? '');
      lines.push(`${key}=${encodeEditedValue(value, value.includes('$') ? "'" : '')}`);
      return lines.join('\n');
    })
    .filter(Boolean)
    .join('\n') + '\n';
}

/**
 * 校验 .env 语法:不允许格式错误的行静默写入。返回 { ok, errors }。
 */
export function validateDotenv(text) {
  const { errors } = parseDotenvDocument(text);
  return { ok: errors.length === 0, errors };
}

/**
 * Lexical document used for validation and lossless table edits. This does not
 * evaluate substitutions: Compose remains responsible for interpolation.
 */
export function parseDotenvDocument(text) {
  const raw = String(text ?? '');
  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) || [];
  const nodes = [], errors = [];
  let leading = [], tableSafe = true;
  for (let index = 0; index < lines.length; index++) {
    const startLine = index + 1;
    const line = lines[index].replace(/\r?\n$/, '');
    if (!line.trim() || /^\s*#/.test(line)) { leading.push(lines[index]); continue; }
    const match = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/.exec(line);
    if (!match) { errors.push(`第 ${startLine} 行不是合法的 KEY=VALUE 格式`); leading.push(lines[index]); tableSafe = false; continue; }
    let rest = match[4], source = lines[index], suffix, token, value, quote = '';
    if (/^["']/.test(rest)) {
      quote = rest[0];
      let end = -1;
      for (let offset = 1; ; offset++) {
        if (offset >= rest.length) {
          if (++index >= lines.length) break;
          rest += '\n' + lines[index].replace(/\r?\n$/, '');
          source += lines[index];
        }
        if (rest[offset] === '\\') { offset++; continue; }
        if (rest[offset] === quote) { end = offset; break; }
      }
      if (end < 0) { errors.push(`第 ${startLine} 行的引号未闭合`); tableSafe = false; leading.push(source); continue; }
      token = rest.slice(0, end + 1); value = token.slice(1, -1); suffix = rest.slice(end + 1);
      if (!/^[ \t]*(?:#.*)?$/.test(suffix)) errors.push(`第 ${startLine} 行引号后存在无效内容`);
    } else {
      const comment = /(^|[ \t])#/.exec(rest);
      const commentAt = comment ? comment.index + comment[1].length : rest.length;
      token = rest.slice(0, commentAt).trimEnd(); value = token;
      suffix = rest.slice(token.length);
    }
    // Multiline and escaped forms stay in raw mode; never flatten them.
    if (/[\r\n\\]/.test(value)) tableSafe = false;
    const inlineComment = suffix.indexOf('#');
    let leadingCommentIndex = -1;
    leading.forEach((part, i) => { if (/^\s*#/.test(part)) leadingCommentIndex = i; });
    const comment = inlineComment >= 0 ? suffix.slice(inlineComment + 1).trim()
      : leadingCommentIndex >= 0 ? leading[leadingCommentIndex].trim().replace(/^#\s*/, '') : undefined;
    nodes.push({ key: match[2], value, comment, quote, token, suffix, prefix: match[1], separator: match[3], leading, leadingCommentIndex, inlineComment,
      source, eol: /\r?\n$/.exec(source)?.[0] || '', isSecret: isSecretKey(match[2]), _sourceId: nodes.length });
    leading = [];
  }
  return { raw, nodes, trailing: leading.join(''), errors, tableSafe: tableSafe && !errors.length };
}

function encodeEditedValue(value, quote = '') {
  const literal = quote === "'";
  if (literal && !/[\\\r\n]/.test(value)) return `'${value.replaceAll("'", "\\'")}'`;
  if (literal) quote = '"';
  if (quote === '"' || /[\s"'#\\]/.test(value)) {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('$', literal ? '\\$' : '$')}"`;
  }
  return value;
}

/** Preserve every untouched token, comment, blank line and line ending. */
export function editDotenvDocument(document, entries) {
  if (!document.tableSafe) return document.raw;
  const eol = document.raw.includes('\r\n') ? '\r\n' : '\n';
  const blocks = (entries || []).map(entry => {
    const key = String(entry.key || '').trim();
    if (!key) return '';
    const value = String(entry.value ?? ''), comment = String(entry.comment ?? '').replace(/[\r\n]+/g, ' ');
    const original = document.nodes[entry._sourceId];
    if (!original) {
      // New values are literal when they contain a dollar; existing quote style
      // continues to control whether existing values use interpolation.
      const quote = value.includes('$') ? "'" : '';
      return `${key}=${encodeEditedValue(value, quote)}${comment ? ` # ${comment}` : ''}${eol}`;
    }
    if (key === original.key && value === original.value && comment === (original.comment ?? '')) return original.leading.join('') + original.source;
    const leading = [...original.leading];
    let suffix = original.suffix;
    if (comment !== (original.comment ?? '')) {
      if (original.inlineComment >= 0) suffix = suffix.slice(0, original.inlineComment) + (comment ? `# ${comment}` : '');
      else if (original.leadingCommentIndex >= 0) {
        const i = original.leadingCommentIndex;
        const ending = /\r?\n$/.exec(leading[i])?.[0] || eol;
        leading[i] = comment ? `${/^[ \t]*#[ \t]*/.exec(leading[i])?.[0] || '# '}${comment}${ending}` : ending;
      } else if (comment) suffix += ` # ${comment}`;
    }
    const token = value === original.value ? original.token : encodeEditedValue(value, original.quote);
    return `${leading.join('')}${original.prefix}${key}${original.separator}${token}${suffix}${original.eol}`;
  }).filter(Boolean);
  return blocks.reduce((result, block) => result + (result && !result.endsWith('\n') ? eol : '') + block, '') + document.trailing;
}
