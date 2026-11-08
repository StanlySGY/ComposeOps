import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';

/**
 * Docker 容器日志流是 multiplexed 格式：
 * 每个 8 字节头描述 [streamType(1)][0(3)][length(4 big-endian)] + payload
 * streamType: 1=stdout, 2=stderr
 *
 * 返回带 stdout/stderr 的 Writable；消费者读取速度决定上游速度。
 * strict 用于下载等不能接受截断帧的场景，日志旧调用保留宽松结尾。
 */
export function demuxStream({ strict = false } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let header = Buffer.alloc(0);
  let payloadRemaining = 0;
  let currentStream = stdout;
  let completed = false;
  const controller = new AbortController();

  async function decode(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!payloadRemaining) {
        const take = Math.min(8 - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (header.length < 8) continue;
        const streamType = header[0];
        if (strict && ![1, 2].includes(streamType)) throw new Error('Docker 输出数据帧无效');
        currentStream = streamType === 2 ? stderr : stdout;
        payloadRemaining = header.readUInt32BE(4);
        header = Buffer.alloc(0);
        if (!payloadRemaining) continue;
      }
      const take = Math.min(chunk.length - offset, payloadRemaining);
      const piece = chunk.subarray(offset, offset + take);
      offset += take;
      payloadRemaining -= take;
      if (!currentStream.write(piece)) await once(currentStream, 'drain', { signal: controller.signal });
    }
  }

  const input = new Writable({
    write(chunk, encoding, callback) { decode(chunk).then(() => callback(), callback); },
    final(callback) {
      if (strict && (header.length || payloadRemaining)) return callback(new Error('Docker 输出数据流提前结束'));
      completed = true;
      stdout.end();
      stderr.end();
      callback();
    },
    destroy(error, callback) {
      controller.abort();
      if (!completed || error) {
        stdout.destroy(error);
        stderr.destroy(error);
      }
      callback(error);
    },
  });
  // Legacy consumers handle output errors; keep input errors observable without
  // introducing a second unhandled error event for the same failure.
  input.on('error', () => {});

  // 外层可直接 source.pipe(input)，两个输出均需被消费或显式 resume。
  input.stdout = stdout;
  input.stderr = stderr;
  return input;
}

/** Dockerode 非 follow 日志返回 Buffer,部分传输实现返回 Readable;完整消费两种形式。 */
export function collectDockerOutput(logs) {
  return new Promise((resolve, reject) => {
    const demux = demuxStream();
    let output = '';
    let ended = 0;
    function fail(error) {
      demux.destroy();
      demux.stdout.destroy();
      demux.stderr.destroy();
      logs?.destroy?.();
      reject(error);
    }
    for (const stream of [demux.stdout, demux.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', text => { output += text; });
      stream.on('error', fail);
      stream.on('end', () => { if (++ended === 2) resolve(output); });
    }
    demux.on('error', fail);
    if (Buffer.isBuffer(logs) || logs instanceof Uint8Array) demux.end(logs);
    else if (logs && typeof logs.pipe === 'function') {
      logs.on('error', fail);
      logs.on('close', () => { if (!logs.readableEnded) fail(new Error('Docker 输出流未完整结束')); });
      logs.pipe(demux);
    } else fail(new TypeError('Docker 日志响应不是 Buffer 或 Readable'));
  });
}
