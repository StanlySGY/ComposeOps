import { PassThrough } from 'stream';

/**
 * Docker 容器日志流是 multiplexed 格式：
 * 每个 8 字节头描述 [streamType(1)][0(3)][length(4 big-endian)] + payload
 * streamType: 1=stdout, 2=stderr
 *
 * demuxStream 返回 { stdout, stderr } 两个可读流。
 */
export function demuxStream() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let header = Buffer.alloc(0);
  let payloadRemaining = 0;
  let currentStream = stdout;
  let buffering = true;

  function onData(chunk) {
    let buf = Buffer.concat([header, chunk]);

    while (buf.length > 0) {
      if (buffering) {
        if (buf.length < 8) {
          header = buf; // 等待更多数据
          return;
        }
        const streamType = buf.readUInt8(0);
        const length = buf.readUInt32BE(4);
        currentStream = streamType === 2 ? stderr : stdout;
        buf = buf.subarray(8);
        payloadRemaining = length;
        if (length === 0) {
          buffering = true;
          continue;
        }
        buffering = false;
      }

      if (!buffering) {
        const take = Math.min(buf.length, payloadRemaining);
        const piece = buf.subarray(0, take);
        buf = buf.subarray(take);
        payloadRemaining -= take;
        currentStream.write(piece);
        if (payloadRemaining === 0) {
          buffering = true;
        }
      }
    }
    header = Buffer.alloc(0);
  }

  const input = new PassThrough();
  input.on('data', onData);
  input.on('end', () => {
    stdout.end();
    stderr.end();
  });
  input.on('error', (e) => {
    stdout.destroy(e);
    stderr.destroy(e);
  });

  // 把 input 挂到返回对象上，外层可直接 .pipe(input)
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
