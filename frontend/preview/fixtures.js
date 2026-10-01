// Fictional data only. Never export or import a real installation's database here.
export const at = '2026-10-01T09:42:00.000Z';
const GB = 1024 ** 3;
function container(name, image, state = 'running') {
  return { id: 'demo-' + name, name, service: name, image, state, status: state === 'running' ? 'Up 2 days (healthy)' : 'Exited (1)', health: state === 'running' ? 'healthy' : 'unhealthy', ports: [], labels: {}, mounts: [], restartCount: state === 'running' ? 0 : 3, created: 1790841600 };
}
function project(id, containers, managed = true) {
  return { id, projectName: id, owner: 'Homelab', managed, editable: managed, mountEnabled: managed, mountState: 'mounted', composeMode: 'direct', workingDir: '/srv/compose/' + id, composeFiles: ['/srv/compose/' + id + '/compose.yml'], containers, status: containers.some(c => c.state !== 'running') ? 'partial' : 'running', favorite: id === 'knowledge-base', tags: [], note: '虚构演示项目', envKeys: [], serviceCount: containers.length };
}
export const projects = [
  project('knowledge-base', [container('wiki-api', 'example/wiki-api:2.3', 'exited'), container('postgres', 'postgres:17-alpine')]),
  project('homepage', [container('homepage', 'nginx:1.28-alpine')]),
  project('cache', [container('redis', 'redis:7.4-alpine')]),
  project('sandbox', [container('worker', 'example/worker:1.0')], false),
];
export const metrics = {
  host: { hostname: 'homelab-demo', platform: 'linux', arch: 'x64', cpu: { percent: 18, cores: 4, loadavg: [0.6, 0.7, 0.5] }, memory: { total: 8 * GB, used: 3.4 * GB, free: 4.6 * GB, percent: 42.5 }, uptime: 172800 },
  containers: projects.flatMap(p => p.containers.map((c, i) => ({ id: c.id, name: c.name, projectId: p.id, projectName: p.projectName, state: c.state, cpuPercent: i ? 7 : 2, memoryUsage: 180 * 1024 ** 2, memoryLimit: GB, memoryPercent: 18, networkRx: 1048576, networkTx: 524288, netIO: { rx: 1048576, tx: 524288 }, blockIO: { read: 0, write: 0 } }))),
  network: { rx: 1048576, tx: 524288 }, disk: [{ mount: '/', total: 128 * GB, used: 40 * GB, free: 88 * GB, percent: 31.25 }],
};
export const inspection = { latest: { id: 1, score: 82, grade: 'warning', summary: 'wiki-api 异常退出，建议检查数据库连接配置（示例）', createdAt: at, issues: [{ id: 'demo', level: 'warning', title: 'wiki-api 连接失败', message: '数据库主机名 db-old 无法解析' }], checks: [], stats: { warning: 1, critical: 0, passed: 8 } }, reports: [], schedule: { enabled: false }, trend: [] };
export const operations = [{ id: 1, action: 'compose.save', status: 'success', projectName: 'homepage', createdAt: at, detail: '示例配置保存' }];
export const alerts = [{ id: 1, title: 'wiki-api 异常退出', detail: 'getaddrinfo ENOTFOUND db-old（预设日志）', target: 'knowledge-base', priority: 'warning', created_at: at, read: false, muted: false, type: 'exit', status: 'open' }];
export const storage = { images: { count: 5, total: 2 * GB, reclaimable: 200 * 1024 ** 2 }, containers: { count: 5, total: 100 * 1024 ** 2, reclaimable: 0 }, volumes: { count: 2, total: 800 * 1024 ** 2, reclaimable: 0, orphans: 0 }, buildCache: { count: 0, total: 0, reclaimable: 0 }, total: 2.9 * GB, reclaimable: 200 * 1024 ** 2, disk: { free: 88 * GB, total: 128 * GB } };
export const channels = [
  { id: 'primary-demo', name: '主渠道（示例）', baseUrl: 'https://primary.example.invalid/v1', model: 'demo-tool-model', enabled: true, supportsTools: true, streamToolCalls: true, hasApiKey: true, apiKey: '••••demo', timeoutMs: 60000, priority: 0, revision: 'demo-1', runtime: { failures: 0, coolingDown: false } },
  { id: 'backup-demo', name: '备用渠道（示例）', baseUrl: 'https://backup.example.invalid/v1', model: 'demo-backup-model', enabled: true, supportsTools: true, streamToolCalls: false, hasApiKey: true, apiKey: '••••demo', timeoutMs: 60000, priority: 1, revision: 'demo-2', runtime: { failures: 0, coolingDown: false } },
];
export const preferences = { defaultOwner: 'Homelab', defaultTail: 200, logTail: 200, autoRefreshSeconds: 10 };
export const backups = [{ id: 'demo-backup', projectId: 'cache', projectName: 'cache', host: 'local', bytes: 1048576, volume: 'cache_data', volumeName: 'cache_data', file: 'cache-data-demo.tar.gz', createdAt: at.slice(0, -1), size: 1048576, sizeBytes: 1048576, verifiedAt: null, status: 'completed' }];
export const logs = '2026-10-01T09:42:01Z [INFO] Starting wiki-api (示例日志)\n2026-10-01T09:42:02Z [ERROR] getaddrinfo ENOTFOUND db-old\n2026-10-01T09:42:03Z [ERROR] Database connection failed\n';
export const compose = new Map(projects.map(p => [p.id, p.id === 'knowledge-base'
  ? 'services:\n  wiki-api:\n    image: example/wiki-api:2.3\n    environment:\n      DB_HOST: db-old\n    depends_on:\n      - postgres\n  postgres:\n    image: postgres:17-alpine\n    volumes:\n      - data:/var/lib/postgresql/data\nvolumes:\n  data:\n'
  : 'services:\n  ' + p.containers[0].service + ':\n    image: ' + p.containers[0].image + '\n    restart: unless-stopped\n']));
