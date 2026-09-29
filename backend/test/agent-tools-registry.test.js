import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(__dirname, '../src/services/tools');
const AGENT_TOOLS = path.join(__dirname, '../src/services/agent-tools.js');

// 工具名来自 agent-tool-categories / 编排定义:agent.js 里 macro/角色/验证器按名引用,
// 若注册少了某工具,运行期会静默变“未注册”。此清单把这些**必须存在**的名字固化。
const REQUIRED_TOOLS = [
  // 角色白名单直接依赖(validator/incident_responder allowedTools)
  'compose.ps', 'compose.logs', 'metrics.query', 'network.inspect',
  'config.validate', 'config.preview',
  'compose.restart', 'compose.up', 'compose.stop',
  'alert.create', 'diagnostic.probe', 'diagnostic.analyze',
  // 确定性回退规划(defaultPlan)依赖
  'compose.pull', 'config.edit', 'maintenance.clean', 'maintenance.update',
  // 其它全部已注册工具(防删漏)
  'compose.exec', 'compose.scale', 'config.rollback', 'config.diff',
  'config.inspect', 'project.list_managed', 'web.search', 'memory.search', 'memory.save', 'memory.delete',
  'environment.get', 'environment.set', 'volume.mount',
  'security.audit', 'backup.trigger', 'notification.test', 'cron.create',
  'performance.baseline', 'alert.configure', 'alert.list', 'alert.delete',
  'server.inspect', 'server.command', 'app.list', 'app.deploy', 'cron.list',
  'skill.list', 'skill.use',
];

/** agent-tools.js + tools/*.js 全部源码拼起来扫(注册已拆到 tools/)。 */
function allSources() {
  const files = [AGENT_TOOLS, ...readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(TOOLS_DIR, name))];
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}

test('Agent 工具注册总表覆盖全部必需工具(含拆分到 tools/ 的文件)', () => {
  const source = allSources();
  for (const name of REQUIRED_TOOLS) {
    assert.ok(source.includes(`registerTool('${name}'`), `缺少工具注册:${name}`);
  }
});

test('agent-tools.js 仅保留组装,不再内含工具注册链', () => {
  const source = readFileSync(AGENT_TOOLS, 'utf8');
  // 组装文件只 import 三个域函数并依次调用;出现任何内联 registerTool 说明又滚回 god-file。
  assert.ok(!source.includes("registerTool('"), 'agent-tools.js 不应再有内联注册');
  for (const fn of ['registerComposeTools', 'registerConfigTools', 'registerMaintenanceTools']) {
    assert.ok(source.includes(fn), `组装文件应调用 ${fn}`);
  }
});

test('tools/ 下三个域文件都导出纯注册函数且无第二份只读 exec 白名单', () => {
  const source = allSources();
  // 注册表本身不做 exec,只读执行统一走 docker-exec —— 不允许出现第二份白名单/exec 实现
  assert.ok(!source.includes('READONLY_EXEC'), '不应出现第二份 READONLY_EXEC');
  assert.ok(!source.includes('curl http'), '不应出现 curl 探测');
  const fns = readdirSync(TOOLS_DIR).filter((n) => n.endsWith('.js'))
    .map((n) => readFileSync(path.join(TOOLS_DIR, n), 'utf8')).join('\n');
  for (const fn of ['registerComposeTools', 'registerConfigTools', 'registerMaintenanceTools']) {
    assert.ok(fns.includes(`export function ${fn}`), `${fn} 应具名导出`);
  }
});
