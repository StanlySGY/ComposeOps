/**
 * Compose 域工具注册(compose.* 生命周期 / 编排 / 日志 / ps)。
 * 由 agent-tools.js 拆分 —— 工具注册链与 helper 逐字节搬运。
 */
import { randomUUID } from 'node:crypto';
import { readContainerLogs } from '../../lib/docker-exec.js';
import { spawnComposeCommand } from '../compose-runner.js';
import { runWorkspaceComposeArgs } from '../compose-workspace.js';
import { getActivityDocker } from '../docker-hosts.js';
import { createBackgroundTask } from '../agent/background-tasks.js';
import { prepareProjectAction } from '../project-action-runner.js';
import { findProjectContainer, scanProjects } from '../scanner.js';
import { redactText } from '../../lib/redaction.js';
import { assertCommandAllowed } from '../../lib/command-guard.js';

function collectOutput() {
  let text = '';
  return {
    push: (stream, chunk) => { text = `${text}${chunk}`.slice(-1024 * 1024); },
    text: () => text.slice(-20000),
  };
}

const COMPOSE_EXEC_TIMEOUT_MS = 125000;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Docker exec 没有稳定的跨版本 stop API。把 exec shell PID 写入容器内临时文件，
 * 超时后通过第二个短 exec 终止该 shell及其直接子进程，避免把整个业务容器杀掉。
 */
export function buildExecCommand(command, marker) {
  const escaped = String(command).replace(/'/g, "'\\''");
  const markerArg = shellQuote(marker);
  return `marker=${markerArg}; echo "$$" > "$marker"; if command -v timeout >/dev/null 2>&1; then timeout --signal=TERM 120s /bin/sh -c '${escaped}'; else /bin/sh -c '${escaped}'; fi`;
}

async function cleanupExecMarker(container, marker) {
  try {
    const cleanup = await container.exec({ AttachStdout: false, AttachStderr: false, Cmd: ['/bin/sh', '-c', `rm -f ${shellQuote(marker)}`] });
    const cleanupStream = await cleanup.start({ Tty: false });
    await new Promise((resolve) => {
      cleanupStream.once('end', resolve);
      cleanupStream.once('close', resolve);
      cleanupStream.once('error', resolve);
      cleanupStream.resume?.();
    });
  } catch { /* marker 清理失败不影响后续工具调用。 */ }
}

export async function terminateExecProcess(container, marker, stream) {
  try { stream?.destroy?.(); } catch { /* 超时时 stream 可能已经结束。 */ }
  const killCommand = `pid=$(cat ${shellQuote(marker)} 2>/dev/null) || exit 0; [ -n "$pid" ] || exit 0; kill -TERM "$pid" 2>/dev/null || true; pkill -TERM -P "$pid" 2>/dev/null || true; sleep 1; kill -KILL "$pid" 2>/dev/null || true; pkill -KILL -P "$pid" 2>/dev/null || true; rm -f ${shellQuote(marker)}`;
  try {
    const killer = await container.exec({ AttachStdout: false, AttachStderr: false, Cmd: ['/bin/sh', '-c', killCommand] });
    const killStream = await killer.start({ Tty: false });
    await new Promise((resolve) => {
      killStream.once('end', resolve);
      killStream.once('close', resolve);
      killStream.once('error', resolve);
      killStream.resume?.();
    });
  } catch {
    await cleanupExecMarker(container, marker);
  }
}
/** 在 mounted / workspace 两种可编辑模式下执行任意 docker compose 参数。 */
async function runComposeArgs(project, args, onOutput = () => {}) {
  const output = collectOutput();
  if (project.mounted) {
    const code = await new Promise((resolve, reject) => {
      const child = spawnComposeCommand(project, args);
      child.stdout.on('data', (chunk) => { onOutput('stdout', chunk.toString('utf8')); output.push('stdout', chunk); });
      child.stderr.on('data', (chunk) => { onOutput('stderr', chunk.toString('utf8')); output.push('stderr', chunk); });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
      }, 300000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve(signal ? 124 : code ?? 1);
      });
    });
    return { mode: 'compose', exitCode: code, output: output.text() };
  }
  const code = await runWorkspaceComposeArgs(project, args, (stream, chunk) => {
    onOutput(stream, chunk.toString('utf8'));
    output.push(stream, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });
  return { mode: 'workspace', exitCode: code, output: output.text() };
}

export function registerComposeTools(agent) {
  // background=true 的动作转后台执行:立即返回 taskId,产出经后台任务管理器
  // 搭车注入同会话后续轮次;后置验收(PostconditionValidator)对后台结果跳过。
  // 后台路径放宽超时到 15 分钟——转后台的意义就是容纳长构建/大拉取。
  const BACKGROUND_TIMEOUT_MS = 15 * 60 * 1000;
  const lifecycleAction = (action) => async (params, context) => {
    const project = context.project;
    const prepared = await prepareProjectAction(project, action);
    if (params.background === true) {
      const taskId = createBackgroundTask({
        sessionId: context.sessionId,
        projectId: project.id,
        label: `compose.${action} ${project.name || project.id}`,
        run: (onOutput, onChild) => prepared.run(onOutput, onChild, { timeoutMs: BACKGROUND_TIMEOUT_MS }),
      });
      return {
        background: true,
        taskId,
        action,
        note: `compose.${action} 已转后台执行(超时上限 15 分钟),任务 ID ${taskId}。用 task.output(taskId, waitMs) 等待或读取输出;完成后同会话也会自动收到提醒。`,
      };
    }
    const output = collectOutput();
    const exitCode = await prepared.run((stream, chunk) => output.push(stream, chunk));
    return { mode: prepared.mode, action, exitCode, output: output.text() };
  };

  agent
    .registerTool('compose.up', {
      description: '启动 Compose 项目,可指定服务(仅整个项目级启动);构建耗时长时可 background=true 转后台',
      category: 'compose',
      requiredPermission: 'managed',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          services: { type: 'array', items: { type: 'string' }, description: '指定服务(可选)' },
          background: { type: 'boolean', description: '转后台执行,立即返回 taskId(适合带构建/拉取的长启动)' },
        },
        required: ['projectId'],
      },
      execute: lifecycleAction('up'),
    })
    .registerTool('compose.stop', {
      description: '停止 Compose 项目或指定服务',
      category: 'compose',
      requiredPermission: 'managed',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          services: { type: 'array', items: { type: 'string' }, description: '指定服务(可选)' },
        },
        required: ['projectId'],
      },
      execute: lifecycleAction('stop'),
    })
    .registerTool('compose.restart', {
      description: '重启 Compose 项目或指定服务',
      category: 'compose',
      requiredPermission: 'managed',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          services: { type: 'array', items: { type: 'string' }, description: '指定服务(可选)' },
        },
        required: ['projectId'],
      },
      execute: lifecycleAction('restart'),
    })
    .registerTool('compose.pull', {
      description: '拉取项目镜像(需可编辑的 Compose 目录能力);大镜像拉取可 background=true 转后台',
      category: 'compose',
      requiredPermission: 'editable',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          background: { type: 'boolean', description: '转后台执行,立即返回 taskId' },
        },
        required: ['projectId'],
      },
      execute: lifecycleAction('pull'),
    })
    .registerTool('compose.logs', {
      description: '读取项目容器最近日志(只读),可按服务过滤与关键词检索',
      category: 'diagnostic',
      requiredPermission: 'managed',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          containerId: { type: 'string', description: '指定容器(可选)' },
          services: { type: 'array', items: { type: 'string' }, description: '指定服务(可选)' },
          tail: { type: 'number', description: '最后 N 行(默认 100)' },
          grep: { type: 'string', description: '搜索关键词(可选)' },
        },
        required: ['projectId'],
      },
      execute: async (params, context) => {
        const tail = Math.min(Math.max(Number(params.tail) || 100, 20), 2000);
        const docker = getActivityDocker();
        let targets = context.project.containers || [];
        if (params.containerId) {
          const match = await findProjectContainer(params.projectId, params.containerId);
          targets = match?.container ? [match.container] : [];
        } else if (Array.isArray(params.services) && params.services.length) {
          const wanted = params.services.map((s) => String(s).toLowerCase());
          targets = targets.filter((c) => wanted.some((s) => c.name.toLowerCase().includes(s)));
        }
        const lines = [];
        for (const item of targets) {
          const logs = await readContainerLogs(docker.getContainer(item.id), tail);
          const needle = params.grep ? String(params.grep) : '';
          const filtered = needle
            ? logs.split('\n').filter((line) => line.includes(needle))
            : logs.split('\n');
          for (const line of filtered) lines.push(`[${item.name}] ${line}`);
        }
        return { containers: targets.map((item) => item.name), logs: lines.slice(-tail).join('\n') };
      },
    })
    .registerTool('compose.ps', {
      description: '列出项目或全部纳管项目的容器状态(只读)',
      category: 'compose',
      requiredPermission: 'readonly',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: '项目 ID(可选,缺省返回全部纳管项目)' } },
      },
      execute: async (params, _context) => {
        const projects = await scanProjects();
        const managed = projects.filter((project) => project.managed);
        const scoped = params.projectId ? managed.filter((project) => project.id === params.projectId) : managed;
        return scoped.map((project) => ({
          projectId: project.id,
          projectName: project.projectName,
          status: project.status,
          containers: project.containers.map((c) => ({
            name: c.name,
            state: c.state,
            statusText: c.statusText,
            image: c.image,
          })),
        }));
      },
    })
    .registerTool('compose.scale', {
      description: '调整服务副本数(需可编辑的 Compose 目录能力)',
      category: 'compose',
      requiredPermission: 'editable',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          service: { type: 'string', description: '服务名' },
          replicas: { type: 'number', description: '目标副本数' },
        },
        required: ['projectId', 'service', 'replicas'],
      },
      execute: async (params, context) => {
        const replicas = Math.max(0, Math.min(Math.floor(Number(params.replicas)), 100));
        const service = String(params.service || '').trim();
        if (!service) throw new Error('服务名不能为空');
        const result = await runComposeArgs(context.project, ['up', '-d', '--scale', `${service}=${replicas}`]);
        return { service, replicas, ...result };
      },
    })
    .registerTool('compose.exec', {
      description: '在项目容器内执行命令(会写入容器,需确认)',
      category: 'compose',
      requiredPermission: 'managed',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          containerId: { type: 'string', description: '容器 ID' },
          command: { type: 'string', description: '要执行的命令' },
        },
        required: ['projectId', 'containerId', 'command'],
      },
      execute: async (params, context) => {
        if (!context.container) throw new Error('容器不属于当前项目');
        const command = String(params.command || '').trim();
        if (!command) throw new Error('命令不能为空');

        // 输出侧护栏:拦下灾难性命令(rm -rf /、mkfs、fork 炸弹、curl|sh 等)
        assertCommandAllowed(command);

        // 检查 ENABLE_SHELL 全局开关(与 Web Shell 一致的安全边界)
        const enableShell = process.env.ENABLE_SHELL === '1';
        if (!enableShell) {
          throw Object.assign(
            new Error('Shell 执行未启用,设置 ENABLE_SHELL=1 后重启'),
            { statusCode: 403 }
          );
        }

        const docker = getActivityDocker();
        const container = docker.getContainer(context.container.id);
        const started = Date.now();
        const marker = `/tmp/composeops-exec-${randomUUID()}.pid`;
        const boundedCommand = buildExecCommand(command, marker);
        const exec = await container.exec({ AttachStdout: true, AttachStderr: true, Cmd: ['/bin/sh', '-c', boundedCommand] });
        const stream = await exec.start({ Tty: false });
        const chunks = [];
        const maxBytes = 1024 * 1024;
        let totalBytes = 0;
        let deadlineTimer;
        let timedOut = false;
        const deadline = new Promise((_, reject) => {
          deadlineTimer = setTimeout(() => {
            timedOut = true;
            reject(Object.assign(new Error('容器命令执行超时,已尝试终止实际命令'), { statusCode: 504, timedOut: true }));
          }, COMPOSE_EXEC_TIMEOUT_MS);
          deadlineTimer.unref?.();
        });
        const readOutput = (async () => {
          for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (totalBytes < maxBytes) {
              const remaining = maxBytes - totalBytes;
              chunks.push(buffer.subarray(0, remaining));
              totalBytes += Math.min(buffer.length, remaining);
            }
          }
        })();
        try {
          await Promise.race([readOutput, deadline]);
        } catch (error) {
          if (timedOut) await terminateExecProcess(container, marker, stream);
          readOutput.catch(() => {});
          throw error;
        } finally {
          clearTimeout(deadlineTimer);
        }
        await cleanupExecMarker(container, marker);
        const inspect = await exec.inspect().catch(() => null);
        return {
          stdout: redactText(Buffer.concat(chunks).toString('utf8')),
          exitCode: inspect?.ExitCode ?? null,
          durationMs: Date.now() - started,
        };
      },
    });
  return agent;
}
