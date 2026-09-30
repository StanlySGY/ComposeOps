import { StringDecoder } from 'node:string_decoder';

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
