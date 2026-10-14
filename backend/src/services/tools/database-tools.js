import { getActivityDocker } from '../docker-hosts.js';
import { demuxStream } from '../../lib/docker-streams.js';

const PROBE_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 4096;

export function databaseProbeCommand(engine) {
  if (engine === 'redis') return ['redis-cli', '--raw', 'PING'];
  if (engine === 'postgres') return ['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-q'];
  throw Object.assign(new Error('数据库类型仅支持 redis 或 postgres'), { statusCode: 400 });
}

export function isSupportedDatabaseImage(engine, image) {
  const imageName = String(image || '').split('@')[0].split('/').pop().split(':')[0].toLowerCase();
  if (engine === 'redis') return imageName === 'redis';
  if (engine === 'postgres') return imageName === 'postgres';
  return false;
}

function collectBounded(target, buffer, state) {
  if (state.bytes >= OUTPUT_LIMIT) return;
  const chunk = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const remaining = OUTPUT_LIMIT - state.bytes;
  const accepted = chunk.subarray(0, remaining);
  target.push(accepted);
  state.bytes += accepted.length;
}

/** Execute only fixed, read-only health commands; never accepts SQL or arbitrary command text. */
async function runFixedProbe(container, engine) {
  const command = databaseProbeCommand(engine);
  const exec = await container.exec({
    AttachStdout: true,
    AttachStderr: true,
    Cmd: command,
    Tty: false,
  });
  const stream = await exec.start({ Tty: false });
  const demux = demuxStream();
  const stdout = [];
  const stderr = [];
  const state = { bytes: 0 };
  demux.stdout.on('data', (chunk) => collectBounded(stdout, chunk, state));
  demux.stderr.on('data', (chunk) => collectBounded(stderr, chunk, state));

  let timedOut = false;
  let timer;
  const completion = new Promise((resolve) => {
    let ended = 0;
    const finish = () => { ended++; if (ended >= 2) resolve(); };
    demux.stdout.once('end', finish);
    demux.stderr.once('end', finish);
    stream.once('error', resolve);
    stream.once('close', resolve);
  });
  stream.pipe(demux);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      stream.destroy();
      demux.destroy();
      resolve();
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  try { await Promise.race([completion, timeout]); }
  finally { clearTimeout(timer); }

  const inspection = await exec.inspect().catch(() => null);
  return {
    command: command[0],
    exitCode: timedOut ? 124 : inspection?.ExitCode ?? null,
    timedOut,
    stdout: Buffer.concat(stdout).toString('utf8').trim(),
    stderr: Buffer.concat(stderr).toString('utf8').trim(),
  };
}

export function registerDatabaseTools(agent) {
  agent.registerTool('database.probe', {
    description: '对已纳管的 Redis/PostgreSQL 容器执行固定只读健康探测（Redis PING 或 pg_isready），不执行用户提供的命令或 SQL；若探测失败先查看日志，再经确认后决定是否重启服务。',
    category: 'diagnostic',
    requiredPermission: 'managed',
    confirmationRequired: false,
    requiresProject: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', minLength: 1 },
        containerId: { type: 'string', minLength: 1 },
        engine: { type: 'string', enum: ['redis', 'postgres'] },
      },
      required: ['projectId', 'containerId', 'engine'],
    },
    execute: async (params, context) => {
      const engine = params.engine;
      const contextProject = context.project;
      const contextContainer = context.container;
      if (!contextProject?.id || String(contextProject.id) !== String(params.projectId)) {
        throw Object.assign(new Error('项目不属于当前纳管上下文'), { statusCode: 403 });
      }
      if (!contextContainer?.id || String(contextContainer.id) !== String(params.containerId)) {
        throw Object.assign(new Error('容器不属于当前纳管项目或上下文不匹配'), { statusCode: 403 });
      }

      const docker = getActivityDocker();
      const container = docker.getContainer(contextContainer.id);
      let inspection;
      try { inspection = await container.inspect(); }
      catch (error) {
        return {
          engine,
          status: 'unavailable',
          healthy: false,
          error: String(error?.message || error).slice(0, 500),
          checkedAt: new Date().toISOString(),
        };
      }

      const image = inspection?.Config?.Image || contextContainer.image || contextContainer.imageName || '';
      if (!isSupportedDatabaseImage(engine, image)) {
        throw Object.assign(new Error(`数据库探测拒绝不匹配的容器镜像: engine=${engine}, image=${String(image).slice(0, 160)}`), { statusCode: 400 });
      }

      const startedAt = Date.now();
      try {
        const result = await runFixedProbe(container, engine);
        const healthy = !result.timedOut && result.exitCode === 0;
        return {
          engine,
          container: {
            id: String(contextContainer.id),
            name: String(inspection?.Name || contextContainer.name || '').replace(/^\//, '').slice(0, 200),
            image: String(image).slice(0, 200),
          },
          status: result.timedOut ? 'timeout' : healthy ? 'healthy' : 'unhealthy',
          healthy,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        return {
          engine,
          status: 'unavailable',
          healthy: false,
          error: String(error?.message || error).slice(0, 500),
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        };
      }
    },
  });
}
