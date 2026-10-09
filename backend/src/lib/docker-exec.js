/**
 * 只读容器命令执行与日志读取。
 *
 * 供 AI 排障(services/ai 调用链)与 Agent 工具(services/agent-tools)共用,
 * 避免两处各自维护一份 exec 白名单 / 日志读取实现(曾因两份实现出现严格性漂移)。
 */

/** 只读探测命令白名单:curl/wget 与可启动子进程的 env 参数模式不允许。 */
export const READONLY_EXEC = /^(?:env|printenv|ps|top|netstat|ss|cat|head|tail|ls|df|du|free|uptime|uname|hostname|date|whoami|id|ip|ping)(?:\s|$)/;
const READONLY_COMMANDS = new Set([
  'env', 'printenv', 'ps', 'top', 'netstat', 'ss', 'cat', 'head', 'tail', 'ls', 'df', 'du',
  'free', 'uptime', 'uname', 'hostname', 'date', 'whoami', 'id', 'ip', 'ping',
]);
const SHELL_CONTROL = /[;&|`$()<>\\\\\0\r\n]/;

/** 校验命令及参数，而非只检查首 token；Docker Cmd 使用 argv，但 env 可启动任意子进程。 */
export function assertReadonlyExecutable(cmdString) {
  const text = String(cmdString ?? '').trim();
  if (!text) throw new Error('命令为空');
  if (SHELL_CONTROL.test(text)) throw new Error('只读探测命令不允许 shell 控制符');
  const parts = text.split(/\s+/);
  const [command, ...args] = parts;
  if (!READONLY_COMMANDS.has(command)) {
    throw new Error('仅允许执行只读探测命令(env/ps/netstat/cat/tail/ls/df/free 等)');
  }
  // env <program> 可直接启动 shell/任意子进程，不能作为只读探测入口。
  if (command === 'env' && args.length) throw new Error('env 只允许无参数输出环境变量');
  if (command === 'top' && !(args.length === 3 && args[0] === '-b' && args[1] === '-n' && args[2] === '1')) {
    throw new Error('top 仅允许单次采样:top -b -n 1');
  }
  if (command === 'ip' && !(args.length === 1 && args[0] === 'addr')) {
    throw new Error('ip 仅允许查看地址:ip addr');
  }
  if (command === 'ping') {
    const count = args[0] === '-c' ? Number(args[1]) : NaN;
    if (args.length !== 3 || args[0] !== '-c' || !Number.isInteger(count) || count < 1 || count > 10 || args[2]?.startsWith('-')) {
      throw new Error('ping 仅允许 ping -c 1..10 <host>');
    }
  }
}

/**
 * 在容器内静默执行一条只读命令,返回 stdout/stderr/exitCode/durationMs。
 * @param {object} container - dockerode Container 实例
 * @param {string} cmdString - 完整命令字符串，须通过命令及参数级只读白名单校验
 */
export async function execReadonly(container, cmdString) {
  assertReadonlyExecutable(cmdString);
  const parts = String(cmdString || '').trim().split(/\s+/);
  const started = Date.now();
  const exec = await container.exec({ AttachStdout: true, AttachStderr: true, Cmd: parts });
  const stream = await exec.start({ Tty: false });
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const output = Buffer.concat(chunks).toString('utf8');
  const inspect = await exec.inspect().catch(() => null);
  return { stdout: output.slice(0, 20000), exitCode: inspect?.ExitCode ?? null, durationMs: Date.now() - started };
}

/**
 * 读取容器最近 tail 行日志(自动处理 TTY 单流与多路复用流)。失败时返回错误描述字符串,绝不抛出。
 * @param {object} container - dockerode Container 实例
 * @param {number} tail - 读取的行数
 */
export async function readContainerLogs(container, tail = 200) {
  try {
    const inspection = await container.inspect().catch(() => null);
    const logStream = await container.logs({ follow: false, stdout: true, stderr: true, tail, timestamps: false });
    if (inspection?.Config?.Tty) {
      return Buffer.isBuffer(logStream) ? logStream.toString('utf8') : '';
    }
    const { demuxStream } = await import('./docker-streams.js');
    const demux = demuxStream();
    const chunks = [];
    demux.stdout.on('data', (b) => chunks.push(b));
    demux.stderr.on('data', (b) => chunks.push(b));
    if (Buffer.isBuffer(logStream)) demux.end(logStream);
    else logStream.pipe(demux);
    await Promise.all([
      new Promise((resolve) => demux.stdout.on('end', resolve)),
      new Promise((resolve) => demux.stderr.on('end', resolve)),
    ]);
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    return `读取日志失败: ${error.message}`;
  }
}
