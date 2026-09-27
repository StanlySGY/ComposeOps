import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import { getActivityDocker } from '../services/docker-hosts.js';
import { parseContainerStat } from '../services/stats.js';
import { getMcpStatus, saveMcpConfig, revealMcpToken } from './mcp.js';

/**
 * 宿主机指标：CPU / 内存 / 磁盘 / 网络
 * 纯 Node 实现，避免额外依赖。
 */
let previousHostCpu = null;

function readHostMetrics() {
  const cpus = os.cpusInfo ? os.cpusInfo() : os.cpus();
  let cpuUser = 0, cpuNice = 0, cpuSys = 0, cpuIdle = 0;
  for (const c of cpus || []) {
    cpuUser += c.times.user;
    cpuNice += c.times.nice;
    cpuSys += c.times.sys;
    cpuIdle += c.times.idle;
  }
  const total = cpuUser + cpuNice + cpuSys + cpuIdle;
  let cpuPercent = 0;
  if (previousHostCpu) {
    const totalDelta = total - previousHostCpu.total;
    const idleDelta = cpuIdle - previousHostCpu.idle;
    cpuPercent = totalDelta > 0 ? +((totalDelta - idleDelta) / totalDelta * 100).toFixed(1) : 0;
  }
  previousHostCpu = { total, idle: cpuIdle };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    cpu: { percent: cpuPercent, cores: cpus?.length || 0, loadavg: os.loadavg() },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: +(usedMem / totalMem * 100).toFixed(1),
    },
    uptime: os.uptime(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
  };
}

/** 用 `df -B1` 解析磁盘占用（关注 / 与 /var/lib/docker） */
function readDiskStats() {
  const disk = [];
  const wanted = new Set(['/', '/var/lib/docker']);
  try {
    const out = execSync("df -B1 --output=target,size,used,avail,pcent 2>/dev/null", { encoding: 'utf8' });
    for (const line of out.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const mountpoint = parts[0];
      if (!wanted.has(mountpoint)) continue;
      const size = parseInt(parts[1], 10) || 0;
      const used = parseInt(parts[2], 10) || 0;
      const avail = parseInt(parts[3], 10) || 0;
      const pcent = parseInt(parts[4], 10) || 0;
      disk.push({ mountpoint, total: size, used, free: avail, percent: pcent });
    }
  } catch { /* df 不可用时返回空磁盘统计。 */ }
  return disk;
}

/** 网络累计字节 -> 增量速率（每调用周期） */
function readNetStats(prev) {
  let net = { rx: 0, tx: 0 };
  try {
    const netDev = readFileSync('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of netDev.split('\n')) {
      const m = line.trim().match(/^(\S+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (!m) continue;
      if (m[1] === 'lo') continue;
      rx += parseInt(m[2], 10);
      tx += parseInt(m[3], 10);
    }
    const now = Date.now();
    if (prev && prev.ts) {
      const dt = (now - prev.ts) / 1000;
      net = {
        rx: dt > 0 ? Math.max(0, Math.round((rx - (prev.netRx || 0)) / dt)) : 0,
        tx: dt > 0 ? Math.max(0, Math.round((tx - (prev.netTx || 0)) / dt)) : 0,
        rxTotal: rx,
        txTotal: tx,
      };
    } else {
      net = { rx: 0, tx: 0, rxTotal: rx, txTotal: tx };
    }
    prev.netRx = rx;
    prev.netTx = tx;
    prev.ts = now;
  } catch { /* /proc/net/dev 不可读时返回零速率。 */ }
  return net;
}
async function readContainerStats() {
  const docker = getActivityDocker();
  const containers = await docker.listContainers({ all: false });
  const rows = await Promise.all(containers.map(async (c) => {
    try {
      const stat = await docker.getContainer(c.Id).stats({ stream: false });
      const parsed = parseContainerStat(stat);
      return {
        id: c.Id,
        name: (c.Names[0] || '').replace(/^\//, ''),
        image: c.Image,
        cpuPercent: parsed.cpuPercent,
        memUsage: Math.round(parsed.memUsageMB * 1024 * 1024),
        memLimit: Math.round(parsed.memLimitMB * 1024 * 1024),
        memPercent: parsed.memPercent,
      };
    } catch { return null; }
  }));
  const stats = rows.filter(Boolean);
  stats.sort((a, b) => b.memUsage - a.memUsage);
  return stats;
}

// 模块级状态：前一次网络/容器快照
const prevNet = {};

export default async function systemRoutes(fastify) {
  fastify.get('/capabilities', async () => ({
    shellEnabled: process.env.ENABLE_SHELL === '1',
    hostMetricsScope: process.env.HOST_METRICS === '1' ? 'host' : 'container',
  }));
  // GET /api/v1/system/metrics
  fastify.get('/metrics', async () => {
    const host = readHostMetrics();
    const disk = readDiskStats();
    const net = readNetStats(prevNet);
    let containers;
    try {
      containers = await readContainerStats();
    } catch (error) {
      console.error('[system] 读取容器指标失败:', error.message);
      containers = [];
    }
    return { host, disk, network: net, containers };
  });

  // ---- MCP 服务管理(token/模式/开关) ----
  fastify.get('/mcp', async () => getMcpStatus());
  fastify.post('/mcp', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          mode: { type: 'string', enum: ['readonly', 'all'] },
          regenerateToken: { type: 'boolean' },
        },
      },
    },
  }, async (request) => saveMcpConfig(request.body || {}));
  // token 只经此端点明文返回一次,供粘贴进 MCP 客户端
  fastify.post('/mcp/reveal-token', async () => revealMcpToken());
}
