import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(__dirname, '../src/services/tools');
const AGENT_TOOLS = path.join(__dirname, '../src/services/agent-tools.js');
const tempDir = mkdtempSync(path.join(tmpdir(), 'composeops-agent-registry-'));
process.env.DB_PATH = path.join(tempDir, 'registry.db');
const { OperationsAgent } = await import('../src/services/agent/engine.js');
const { RISK_LEVELS, assessRisk } = await import('../src/services/agent-tools.js');
test.after(() => rmSync(tempDir, { recursive: true, force: true }));

// 工具名来自 agent-tool-categories / 编排定义:agent.js 里 macro/角色/验证器按名引用,
// 若注册少了某工具,运行期会静默变“未注册”。此清单把这些必须存在的名字固化。
const REQUIRED_TOOLS = [
  'compose.ps', 'compose.logs', 'metrics.query', 'network.inspect',
  'config.validate', 'config.preview', 'compose.restart', 'compose.up', 'compose.stop',
  'alert.create', 'diagnostic.probe', 'diagnostic.analyze',
  'compose.pull', 'config.edit', 'maintenance.clean', 'maintenance.update',
  'compose.exec', 'compose.scale', 'config.rollback', 'config.diff',
  'config.inspect', 'project.list_managed', 'web.search', 'memory.search', 'memory.save', 'memory.delete',
  'environment.get', 'environment.set', 'volume.mount', 'security.audit', 'backup.trigger',
  'notification.test', 'cron.create', 'performance.baseline', 'alert.configure', 'alert.list',
  'alert.delete', 'server.inspect', 'server.command', 'app.list', 'app.deploy', 'cron.list',
  'skill.list', 'skill.use',
];

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
  assert.ok(!source.includes("registerTool('"), 'agent-tools.js 不应再有内联注册');
  for (const fn of ['registerComposeTools', 'registerConfigTools', 'registerMaintenanceTools']) {
    assert.ok(source.includes(fn), `组装文件应调用 ${fn}`);
  }
});

test('tools/ 域文件使用统一只读执行边界并导出注册函数', () => {
  const source = allSources();
  assert.ok(!source.includes('READONLY_EXEC'), '不应出现第二份 READONLY_EXEC');
  assert.ok(!source.includes('curl http'), '不应出现 curl 探测');
  const fns = readdirSync(TOOLS_DIR).filter((n) => n.endsWith('.js'))
    .map((n) => readFileSync(path.join(TOOLS_DIR, n), 'utf8')).join('\n');
  for (const fn of ['registerComposeTools', 'registerConfigTools', 'registerMaintenanceTools']) {
    assert.ok(fns.includes(`export function ${fn}`), `${fn} 应具名导出`);
  }
});

test('所有注册工具都有集中风险等级与完整门控元数据', () => {
  const agent = new OperationsAgent();
  const tools = agent.listTools();
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.ok(['low', 'medium', 'high', 'critical'].includes(tool.risk), `${tool.name} 风险等级无效`);
    assert.ok(['readonly', 'editable', 'managed', 'admin'].includes(tool.requiredPermission), `${tool.name} 权限元数据无效`);
    assert.equal(typeof tool.confirmationRequired, 'boolean', `${tool.name} 必须显式声明确认要求`);
    if (!tool.isMacro) {
      assert.ok(Object.hasOwn(RISK_LEVELS, tool.name), `${tool.name} 未进入集中风险表`);
      assert.equal(tool.risk, RISK_LEVELS[tool.name], `${tool.name} 注册风险与集中风险表不一致`);
    }
  }
});

test('风险评估对生产环境升权，对未登记工具 fail-closed', () => {
  assert.equal(assessRisk('compose.up', {}, {}), 'high');
  assert.equal(assessRisk('compose.up', {}, { project: { projectName: 'production-api' } }), 'critical');
  assert.equal(assessRisk('alert.delete', {}, { project: { projectName: 'production-api' } }), 'high');
  assert.equal(assessRisk('macro.full_cleanup', {}, {}), 'critical');
  assert.equal(assessRisk('unknown.new-tool', {}, {}), 'critical');
});

test('外发测试通知默认不进入 MCP 只读工具集并声明需要确认', () => {
  const agent = new OperationsAgent();
  const notification = agent.getTool('notification.test');
  assert.equal(notification.risk, 'medium');
  assert.equal(notification.confirmationRequired, true);
});

test('注册工具缺少权限/确认元数据时拒绝注册，配置不能覆盖集中风险等级', () => {
  const agent = new OperationsAgent();
  const execute = async () => ({ ok: true });
  assert.throws(
    () => agent.registerTool('test.noop', { execute, confirmationRequired: false }),
    /requiredPermission/,
  );
  assert.throws(
    () => agent.registerTool('test.noop', { execute, requiredPermission: 'readonly' }),
    /confirmationRequired/,
  );
  agent.registerTool('test.noop', {
    execute,
    requiredPermission: 'readonly',
    confirmationRequired: false,
    risk: 'critical',
  });
  assert.equal(agent.getTool('test.noop').risk, 'low', '工具配置不能覆盖集中风险表');
});
