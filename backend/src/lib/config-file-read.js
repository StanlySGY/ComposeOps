import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';

export const CONFIG_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const configReadError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

// The same deadline covers opening the transfer and receiving its last byte.
// Aborting also disposes resources that arrive after the caller has timed out.
export async function withFileReadDeadline(read, { timeoutMs = 15000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('文件读取期限必须为正数');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = configReadError('配置文件读取超时，请检查节点连接后重试', 504);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => read(controller.signal)), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

export function assertConfigSize(size, maxBytes = CONFIG_FILE_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('文件读取上限无效');
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw configReadError(`配置文件超过读取上限（${maxBytes} 字节）`, 413);
  }
}

export function readConfigArchive(container, filePath, { maxBytes = CONFIG_FILE_MAX_BYTES, timeoutMs } = {}) {
  assertConfigSize(0, maxBytes);
  return withFileReadDeadline(async signal => {
    const archive = await container.getArchive({ path: filePath, abortSignal: signal });
    if (signal.aborted) { archive.destroy(); throw signal.reason; }
    const extract = tar.extract();
    let result, entryCount = 0, archiveBytes = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      archiveBytes += chunk.length;
      // Allow tar/PAX framing, but never buffer an unbounded extended header.
      callback(archiveBytes > maxBytes + 128 * 1024
        ? configReadError('配置文件归档超过读取上限', 413) : null, chunk);
    } });
    extract.on('entry', (header, stream, next) => {
      const chunks = [];
      let bytes = 0;
      stream.on('error', error => extract.destroy(error));
      try {
        if (++entryCount !== 1 || header.type !== 'file') {
          throw configReadError('配置路径必须指向单个普通文件', 403);
        }
        assertConfigSize(header.size, maxBytes);
      } catch (error) { extract.destroy(error); return; }
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { extract.destroy(configReadError('配置文件超过读取上限', 413)); return; }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        result = { content: Buffer.concat(chunks, bytes).toString('utf8'), header };
        next();
      });
    });
    await pipeline(archive, limiter, extract, { signal });
    if (!result) throw configReadError('配置文件不存在', 404);
    return result;
  }, { timeoutMs });
}
