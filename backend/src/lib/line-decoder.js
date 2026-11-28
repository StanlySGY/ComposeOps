import { StringDecoder } from 'node:string_decoder';

/** Pull one bounded line at a time, so asynchronous consumers apply backpressure. */
export async function* readBoundedLines(stream, maxLineBytes = 256 * 1024) {
  let parts = [], size = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      size += part.length;
      if (size > maxLineBytes) throw new Error('Docker 事件行超过读取上限');
      parts.push(part);
      if (newline < 0) break;
      const line = Buffer.concat(parts, size).toString('utf8');
      parts = []; size = 0;
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      start = newline + 1;
    }
  }
  if (size) {
    const line = Buffer.concat(parts, size).toString('utf8');
    yield line.endsWith('\r') ? line.slice(0, -1) : line;
  }
}

/** 按换行而非网络 chunk 划分记录,保留跨分片 UTF-8 字符与流末尾的不完整行。 */
export function createLineDecoder(onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let ended = false;
  function consume(text) {
    pending += text;
    let start = 0;
    let newline;
    while ((newline = pending.indexOf('\n', start)) !== -1) {
      const line = pending.slice(start, newline);
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      start = newline + 1;
    }
    pending = pending.slice(start);
  }
  return {
    write(chunk) { if (!ended) consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); },
    end() {
      if (ended) return;
      ended = true;
      consume(decoder.end());
      if (pending) onLine(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
      pending = '';
    },
  };
}
