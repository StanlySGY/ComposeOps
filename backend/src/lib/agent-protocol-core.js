/**
 * Agent 文本协议核心(纯函数、零依赖)。
 *
 * 本文件在 backend/src/lib/ 与 frontend/src/lib/ 各存一份,必须保持字节一致
 * (与 dotenv.js 同一约定),修改时两处同步;两侧的 sync 测试会比对字节兜底。
 *
 * - stripAgentInternalText: 移除模型把内部工具编排伪代码当作回答输出的残片。
 * - scanIcallProtocols: 剥离 _icall 文本工具协议块;onCall 用于收集解析出的
 *   工具调用 JSON(后端据此转成原生 tool_calls),前端仅用于清洗可见文本。
 */

/** 模型有时会把内部伪代码/工具编排变量当成回答输出,不能进入用户可见文本或历史。 */
export function stripAgentInternalText(text) {
  let source = String(text || '');
  const internalStart = /\b(?:result|res)\s*=\s*composeOps\.[\w.-]+\(\)|\b(?:iNdEx|index)\s*\+\+\s*(?:(?:\r?\n|\s)+(?:result|project_ids|project_names|project_list)\s*=)/i;
  const visibleBoundary = /(?:您当前|您可以|当前可以|以下是|当然|请告诉|如需|查看我|查看其|以\s*markdown|项目列表)/iu;
  let match;
  while ((match = internalStart.exec(source))) {
    const tail = source.slice(match.index + match[0].length);
    const boundary = tail.search(visibleBoundary);
    const end = boundary < 0 ? source.length : match.index + match[0].length + boundary;
    source = source.slice(0, match.index) + source.slice(end);
  }
  return source.replace(/^[ \t]+\n/gm, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 剥离 _icall 文本工具协议块,返回 { content, incomplete }。
 * 协议未闭合(JSON 未写完或缺少收尾 '>')时 incomplete 为 true,
 * content 只含协议块之前的文本,保证流式场景下残片不会被提前外发。
 * onCall 在协议块 JSON 解析成功时收到该对象;不传则跳过解析。
 */
export function scanIcallProtocols(source, onCall = null) {
  const marker = /_icall/gi;
  let cursor = 0;
  let output = '';
  let match;
  while ((match = marker.exec(source)) !== null) {
    const start = match.index;
    output += source.slice(cursor, start);
    let jsonStart = marker.lastIndex;
    while (jsonStart < source.length && /\s/.test(source[jsonStart])) jsonStart += 1;
    if (source[jsonStart] === ':') {
      jsonStart += 1;
      while (jsonStart < source.length && /\s/.test(source[jsonStart])) jsonStart += 1;
    }
    if (source[jsonStart] !== '{') {
      cursor = marker.lastIndex;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let jsonEnd = -1;
    for (let index = jsonStart; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (character === '{') depth += 1;
      if (character === '}') {
        depth -= 1;
        if (depth === 0) { jsonEnd = index + 1; break; }
      }
    }
    if (jsonEnd < 0) return { content: output, incomplete: true };

    let end = jsonEnd;
    while (end < source.length && /\s/.test(source[end])) end += 1;
    if (source[end] !== '>') return { content: output, incomplete: true };
    if (onCall) {
      try { onCall(JSON.parse(source.slice(jsonStart, jsonEnd))); } catch { /* 协议块解析失败时只清理可见文本。 */ }
    }
    cursor = end + 1;
    marker.lastIndex = cursor;
  }
  const remainder = output + source.slice(cursor);
  return {
    content: remainder.replace(/_ic(?:a(?:l{0,2})?)?$/i, ''),
    incomplete: false,
  };
}
