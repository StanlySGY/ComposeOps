/**
 * 配置 / 诊断 / 环境域工具注册(config.* environment.* diagnostic.* volume.mount security.audit)。
 * 由 agent-tools.js 拆分 —— 工具注册链与 helper 逐字节搬运。
 */
import { getComposeBackup, listComposeBackups } from '../../lib/db.js';
import { execReadonly, readContainerLogs } from '../../lib/docker-exec.js';
import { assertCommandAllowed } from '../../lib/command-guard.js';
import { callOpenAI, getAiConfig } from '../ai.js';
import { readCompose, saveCompose } from '../compose-runner.js';
import { previewComposeChange, validateComposeSemantics } from '../compose-validator.js';
import { getActiveHost, getActiveHostType, getActivityDocker } from '../docker-hosts.js';
import { sshExec } from '../remote-shell.js';
import { realpath } from 'node:fs/promises';
import { applyProjectEnv, assertEnvAccess, readProjectEnv, saveProjectEnv } from '../project-env.js';
import { scanProjects } from '../scanner.js';
import { attachPrivateRollback, redactText } from '../../lib/redaction.js';
import * as YAML from 'yaml';
import path from 'node:path';

function collectOutput() {
  let text = '';
  return {
    push: (stream, chunk) => { text += chunk; },
    text: () => text.slice(-20000),
  };
}
function coerceValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return value;
}

const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|\bPASS\b|(?:API|PRIVATE|ACCESS|SECRET|AUTH|SIGNING)[_-]?KEY)/i;

function diffTexts(before, after) {
  const beforeLines = String(before || '').split('\n');
  const afterLines = String(after || '').split('\n');
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const added = afterLines.filter((line) => !beforeSet.has(line));
  const removed = beforeLines.filter((line) => !afterSet.has(line));
  return { added, removed, unified: null, addedCount: added.length, removedCount: removed.length };
}

function applyYamlChange(content, params) {
  const doc = YAML.parseDocument(content);
  const keys = String(params.path || '').split('.').map((key) => key.trim()).filter(Boolean);
  if (!keys.length) throw Object.assign(new Error('path 不能为空'), { statusCode: 400 });
  if (params.action === 'unset') {
    doc.deleteIn(keys);
  } else if (params.action === 'append') {
    const existing = doc.getIn(keys);
    const next = existing == null
      ? [coerceValue(params.value)]
      : Array.isArray(existing)
        ? [...existing, coerceValue(params.value)]
        : [existing, coerceValue(params.value)];
    doc.setIn(keys, next);
  } else {
    doc.setIn(keys, coerceValue(params.value));
  }
  return doc.toString();
}

/** 读取指定 Compose 文件当前内容(兼容 mounted / workspace)。 */
async function currentComposeContent(project, fileIndex = 0) {
  const index = Number(fileIndex) || 0;
  if (project.mounted) return (await readCompose(project, index)).content;
  const { readWorkspaceCompose } = await import('../compose-workspace.js');
  return (await readWorkspaceCompose(project, index)).content;
}

/** 保存 Compose 内容(兼容 mounted / workspace)。 */
async function saveProjectCompose(project, fileIndex, content, reason) {
  const index = Number(fileIndex) || 0;
  if (project.mounted) return saveCompose(project, index, content, reason);
  const { saveWorkspaceCompose } = await import('../compose-workspace.js');
  return saveWorkspaceCompose(project, index, content, reason);
}

export function registerConfigTools(agent) {
  agent
    .registerTool('config.inspect', {
      description: '读取当前纳管项目的 Compose 配置摘要,用于与官方文档或联网资料逐项比对(敏感值脱敏)',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          fileIndex: { type: 'number', description: 'Compose 文件索引(默认 0)' },
        },
        required: ['projectId'],
      },
      execute: async (params, context) => {
        const fileIndex = Number(params.fileIndex) || 0;
        const content = await currentComposeContent(context.project, fileIndex);
        const safeContent = redactText(content);
        const doc = YAML.parseDocument(content);
        const root = doc.toJSON() || {};
        const services = Object.entries(root.services || {}).map(([name, service]) => ({
          name,
          image: service?.image || null,
          build: service?.build ? true : false,
          ports: Array.isArray(service?.ports) ? service.ports : [],
          dependsOn: service?.depends_on ? Object.keys(service.depends_on) : [],
        }));
        return {
          projectId: context.project.id,
          fileIndex,
          filePath: context.project.composeFiles?.[fileIndex] || null,
          content: safeContent.slice(0, 120000),
          services,
          note: '这是当前本地纳管配置的脱敏快照,联网资料只能作为参考,两者一致性需按字段逐项判断',
        };
      },
    })
    .registerTool('config.preview', {
      description: '预览 Compose 配置变更对运行容器的影响(diff/重启范围)',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          content: { type: 'string', description: '新的 Compose 内容(可选,缺省读取当前文件)' },
          fileIndex: { type: 'number', description: 'Compose 文件索引(默认 0)' },
        },
        required: ['projectId'],
      },
      execute: async (params, context) => {
        const content = typeof params.content === 'string' && params.content
          ? params.content
          : await currentComposeContent(context.project, Number(params.fileIndex) || 0);
        const preview = previewComposeChange(content, context.project);
        return { preview, contentLength: content.length };
      },
    })
    .registerTool('config.validate', {
      description: '校验 Compose 配置语法与语义(依赖/端口/镜像)',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          content: { type: 'string', description: 'Compose 内容(可选,缺省读取当前文件)' },
          fileIndex: { type: 'number', description: 'Compose 文件索引(默认 0)' },
        },
        required: ['projectId'],
      },
      execute: async (params, context) => {
        const content = typeof params.content === 'string' && params.content
          ? params.content
          : await currentComposeContent(context.project, Number(params.fileIndex) || 0);
        const issues = validateComposeSemantics(content);
        return { issues, errorCount: issues.filter((issue) => issue.level === 'error').length };
      },
    })
    .registerTool('config.propose', {
      description: '预览对 Compose 配置的结构化修改,不写入文件',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          fileIndex: { type: 'number', description: 'Compose 文件索引(默认 0)' },
          path: { type: 'string', maxLength: 500, description: 'YAML 点路径' },
          value: { type: 'string', maxLength: 20000, description: '新值' },
          action: { type: 'string', enum: ['set', 'unset', 'append'], description: '操作类型' },
        },
        required: ['projectId', 'path', 'action'],
      },
      execute: async (params, context) => {
        const fileIndex = Number(params.fileIndex) || 0;
        const before = await currentComposeContent(context.project, fileIndex);
        const after = applyYamlChange(before, params);
        const issues = validateComposeSemantics(after);
        return {
          ok: issues.every((issue) => issue.level !== 'error'),
          projectId: context.project.id,
          fileIndex,
          path: params.path,
          action: params.action,
          diff: diffTexts(before, after),
          preview: previewComposeChange(after, context.project),
          issues,
          requiresRestart: true,
        };
      },
    })
    .registerTool('config.edit', {
      description: '按 YAML 点路径编辑 Compose 配置(set/unset/append)',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          fileIndex: { type: 'number', description: 'Compose 文件索引(默认 0)' },
          path: { type: 'string', description: 'YAML 点路径,如 services.web.environment.DEBUG' },
          value: { type: 'string', description: '新值' },
          action: { type: 'string', enum: ['set', 'unset', 'append'], description: '操作类型' },
        },
        required: ['projectId', 'path', 'action'],
      },
      execute: async (params, context) => {
        const fileIndex = Number(params.fileIndex) || 0;
        const current = { content: await currentComposeContent(context.project, fileIndex) };
        const next = applyYamlChange(current.content, params);
        await saveProjectCompose(context.project, fileIndex, next, `agent:config.edit:${params.path}`);
        return attachPrivateRollback({ ok: true, path: params.path, action: params.action, fileIndex }, 'previous', current.content);
      },
      undo: async (params, _result, context) => {
        if (!_result?.previous) throw new Error('缺少回滚内容');
        await saveProjectCompose(context.project, Number(params.fileIndex) || 0, _result.previous, 'agent:config.edit:undo');
        return { ok: true, rolledBack: params.path };
      },
    })
    .registerTool('config.rollback', {
      description: '把 Compose 配置回滚到历史备份版本',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          backupId: { type: 'number', description: '备份 ID(可选,缺省回滚到最近一份)' },
        },
        required: ['projectId'],
      },
      execute: async (params, context) => {
        const backups = listComposeBackups(context.project.id);
        if (!backups.length) throw new Error('该项目没有可用备份');
        const backupId = params.backupId ? Number(params.backupId) : backups[0].id;
        const backup = getComposeBackup(context.project.id, backupId);
        if (!backup) throw Object.assign(new Error('备份不存在'), { statusCode: 404 });
        const fileIndex = context.project.composeFiles.indexOf(backup.filePath);
        if (fileIndex < 0) throw new Error('备份对应的 Compose 文件已变更');
        await saveProjectCompose(context.project, fileIndex, backup.content, `agent:config.rollback:${backupId}`);
        return { ok: true, backupId, filePath: backup.filePath, createdAt: backup.createdAt };
      },
    })
    .registerTool('config.diff', {
      description: '对比当前 Compose 配置与某个备份版本的差异',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          backupId: { type: 'number', description: '备份 ID' },
          fileIndex: { type: 'number', description: 'Compose 文件索引(默认 0)' },
        },
        required: ['projectId', 'backupId'],
      },
      execute: async (params, context) => {
        const backup = getComposeBackup(context.project.id, Number(params.backupId));
        if (!backup) throw Object.assign(new Error('备份不存在'), { statusCode: 404 });
        const fileIndex = context.project.composeFiles.indexOf(backup.filePath);
        const current = await currentComposeContent(context.project, fileIndex >= 0 ? fileIndex : Number(params.fileIndex) || 0);
        return { backupId: backup.id, createdAt: backup.createdAt, ...diffTexts(current, backup.content) };
      },
    })
    .registerTool('environment.get', {
      description: '读取项目 .env(敏感值自动脱敏)',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: '项目 ID' } },
        required: ['projectId'],
      },
      execute: async (_params, context) => {
        assertEnvAccess(context.project);
        const payload = await readProjectEnv(context.project);
        const entries = (payload.entries || []).map((entry) => ({
          key: entry.key,
          value: SECRET_KEY.test(entry.key || '') ? '••••••' : entry.value,
          secret: SECRET_KEY.test(entry.key || ''),
        }));
        return { path: payload.path, exists: payload.exists, entries };
      },
    })
    .registerTool('environment.set', {
      description: '写入单个环境变量并可选重启项目生效',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          key: { type: 'string', description: '变量名' },
          value: { type: 'string', description: '变量值' },
          restart: { type: 'boolean', description: '是否保存后重启项目(默认 true)' },
        },
        required: ['projectId', 'key', 'value'],
      },
      execute: async (params, context) => {
        assertEnvAccess(context.project);
        const key = String(params.key || '').trim();
        if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('环境变量名不合法');
        const payload = await readProjectEnv(context.project);
        const entries = (payload.entries || []).filter((entry) => entry.key !== key);
        entries.push({ key, value: String(params.value) });
        const saved = await saveProjectEnv(context.project, { entries });
        let applied = null;
        if (params.restart !== false) {
          const output = collectOutput();
          const code = await applyProjectEnv(context.project, {
            onOutput: (stream, chunk) => output.push(stream, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))),
          });
          applied = { exitCode: code, output: output.text() };
        }
        return attachPrivateRollback({ ok: true, key, backup: saved.backup, applied: applied ? { ...applied, output: redactText(applied.output) } : null }, 'previousRaw', payload.raw);
      },
      undo: async (_params, result, context) => {
        if (result?.previousRaw == null) throw new Error('缺少回滚内容');
        await saveProjectEnv(context.project, { raw: result.previousRaw });
        return { ok: true, restored: true };
      },
    })
    .registerTool('volume.mount', {
      description: '给服务追加卷挂载(宿主目录/命名卷 → 容器路径)',
      category: 'config',
      requiredPermission: 'editable',
      confirmationRequired: true,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          fileIndex: { type: 'number', description: 'Compose 文件索引(默认 0)' },
          service: { type: 'string', description: '服务名' },
          source: { type: 'string', description: '宿主目录或命名卷' },
          target: { type: 'string', description: '容器内路径' },
        },
        required: ['projectId', 'service', 'source', 'target'],
      },
      execute: async (params, context) => {
        const fileIndex = Number(params.fileIndex) || 0;
        const current = await currentComposeContent(context.project, fileIndex);
        const doc = YAML.parseDocument(current);
        const service = String(params.service || '').trim();
        const source = String(params.source || '').trim();
        const target = String(params.target || '').trim();
        if (!service || !source || !target) throw new Error('service/source/target 不能为空');
        if (!doc.hasIn(['services', service])) throw Object.assign(new Error(`服务 ${service} 不存在`), { statusCode: 404 });

        // 校验 source 路径安全性:必须位于项目目录内或已明确挂载的受控路径
        const { safeProjectMountPath, isWithinProjectPath } = await import('../mount-plan.js');
        const projectMount = safeProjectMountPath(context.project.workingDir);
        if (!projectMount) {
          throw Object.assign(
            new Error('项目工作目录不在安全挂载范围内'),
            { statusCode: 403 }
          );
        }
        // 先规范化再做路径边界判断，不能仅用 startsWith；否则 /project/../../etc 会逃逸到宿主机目录。
        if (!path.posix.isAbsolute(source)) {
          throw Object.assign(new Error('source 必须是绝对路径'), { statusCode: 400 });
        }
        const normalizedSource = path.posix.normalize(source);
        if (!isWithinProjectPath(projectMount, normalizedSource)) {
          throw Object.assign(new Error(`source 必须是项目目录 ${projectMount} 内的子路径，且不能通过 .. 逃逸`), { statusCode: 403 });
        }
        // 路径字符串通过不代表真实路径安全；本地/SSH 节点都解析实际文件系统路径。
        const hostType = getActiveHostType();
        let actualRoot;
        let actualSource;
        if (hostType === 'ssh') {
          const host = getActiveHost();
          const resolveRemote = async (remotePath) => {
            const result = await sshExec(host, ['realpath', '-e', '--', remotePath], { timeoutMs: 15000 });
            if (result.code !== 0) throw new Error(result.stderr?.trim() || `realpath 无法解析 ${remotePath}`);
            return result.stdout.trim();
          };
          [actualRoot, actualSource] = await Promise.all([resolveRemote(projectMount), resolveRemote(normalizedSource)]);
        } else if (hostType === 'local') {
          [actualRoot, actualSource] = await Promise.all([realpath(projectMount), realpath(normalizedSource)]);
        } else {
          throw Object.assign(new Error('当前 Docker 节点无法验证宿主机真实路径，已拒绝挂载修改'), { statusCode: 403 });
        }
        if (actualSource === actualRoot || !actualSource.startsWith(`${actualRoot.replace(/\/$/, '')}/`)) {
          throw Object.assign(new Error('source 的真实路径不在项目目录内，可能存在符号链接逃逸'), { statusCode: 403 });
        }

        const mount = `${actualSource}:${target}`;
        const existing = doc.getIn(['services', service, 'volumes']);
        const list = existing == null ? [] : Array.isArray(existing) ? [...existing] : [existing];
        const normalized = list
          .map((item) => (typeof item === 'string' ? item : String(item)))
          .filter((item) => {
            const [, existingTarget] = item.split(':').length >= 2 ? [null, item.split(':').slice(-1)[0]] : [null, null];
            return existingTarget !== target;
          });
        normalized.push(mount);
        doc.setIn(['services', service, 'volumes'], normalized);
        await saveProjectCompose(context.project, fileIndex, doc.toString(), `agent:volume.mount:${service}`);
        return attachPrivateRollback({ ok: true, service, mount }, 'previous', current);
      },
      undo: async (params, result, context) => {
        if (result?.previous == null) throw new Error('缺少回滚内容');
        await saveProjectCompose(context.project, Number(params.fileIndex) || 0, result.previous, 'agent:volume.mount:undo');
        return { ok: true, rolledBack: true };
      },
    })
    .registerTool('diagnostic.probe', {
      description: '在容器内执行只读探测命令(env/ps/netstat/curl/cat/tail 等)',
      category: 'diagnostic',
      requiredPermission: 'managed',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          containerId: { type: 'string', description: '容器 ID' },
          command: { type: 'string', description: '只读命令' },
        },
        required: ['projectId', 'containerId', 'command'],
      },
      execute: async (params, context) => {
        if (!context.container) throw new Error('容器不属于当前项目');
        // 输出侧护栏:LLM 生成的探测命令也过灾难模式静态检查(白名单之外的纵深防御)
        assertCommandAllowed(params.command);
        const container = getActivityDocker().getContainer(context.container.id);
        return execReadonly(container, params.command);
      },
    })
    .registerTool('diagnostic.analyze', {
      description: '结合容器日志调用 LLM 分析故障根因并给出修复建议',
      category: 'diagnostic',
      requiredPermission: 'managed',
      confirmationRequired: false,
      requiresProject: true,
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: '项目 ID' },
          containerId: { type: 'string', description: '容器 ID(可选)' },
          logs: { type: 'string', description: '日志内容(可选,缺省自动读取)' },
        },
        required: ['projectId'],
      },
      execute: async (params, context) => {
        const cfg = getAiConfig();
        if (!cfg.apiKey) throw new Error('未配置 AI API Key,无法执行诊断分析');
        let logs = params.logs ? String(params.logs) : '';
        if (!logs && context.container) {
          logs = await readContainerLogs(getActivityDocker().getContainer(context.container.id), 200);
        }
        const { fenceUntrusted, UNTRUSTED_GUARD } = await import('../ai.js');
        const prompt = `${UNTRUSTED_GUARD}\n请分析以下容器日志,给出问题根因、证据与可执行修复步骤。\n\n${fenceUntrusted('CONTAINER_LOGS', logs.slice(-12000))}`;
        const analysis = await callOpenAI({
          ...cfg,
          messages: [
            { role: 'system', content: '你是 Docker 容器排障专家,回答中文、结构化,先结论后步骤。' },
            { role: 'user', content: prompt },
          ],
          stream: false,
        });
        return { analysis, logLength: logs.length, suggestions: [] };
      },
    })
    .registerTool('network.inspect', {
      description: '查看 Docker 网络列表或指定网络详情(只读)',
      category: 'diagnostic',
      requiredPermission: 'managed',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: {
          network: { type: 'string', description: '网络名称或 ID(可选,缺省返回列表)' },
        },
      },
      execute: async (params) => {
        const docker = getActivityDocker();
        if (params.network) {
          const inspect = await docker.getNetwork(String(params.network)).inspect();
          const containers = Object.entries(inspect.Containers || {}).map(([id, value]) => ({ id, name: value.Name, ipv4: value.IPv4Address, ipv6: value.IPv6Address }));
          return { id: inspect.Id, name: inspect.Name, driver: inspect.Driver, scope: inspect.Scope, containers };
        }
        const networks = await docker.listNetworks();
        return { networks: networks.map((n) => ({ id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope })) };
      },
    })
    .registerTool('security.audit', {
      description: '审计容器安全风险(特权模式/root 运行/端口暴露/重启/OOM/健康)',
      category: 'diagnostic',
      requiredPermission: 'managed',
      confirmationRequired: false,
      requiresProject: false,
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: '项目 ID(可选,缺省审计全部纳管项目)' } },
      },
      execute: async (params) => {
        const docker = getActivityDocker();
        const projects = (await scanProjects()).filter((project) => project.managed);
        const scoped = params.projectId ? projects.filter((project) => project.id === params.projectId) : projects;
        const findings = [];
        for (const project of scoped) {
          for (const item of project.containers) {
            if (item.state !== 'running') continue;
            try {
              const inspect = await docker.getContainer(item.id).inspect();
              const hostCfg = inspect.HostConfig || {};
              const cfg = inspect.Config || {};
              findings.push({
                project: project.projectName,
                container: item.name,
                privileged: !!hostCfg.Privileged,
                runningAsRoot: !cfg.User || cfg.User === 'root' || cfg.User === '0',
                exposedPorts: (item.ports || []).map((port) => `${port.public}:${port.private}/${port.type}`),
                restartCount: Number(inspect.RestartCount) || 0,
                oomKilled: !!(inspect.State && inspect.State.OOMKilled),
                health: item.health,
              });
            } catch {
              findings.push({ project: project.projectName, container: item.name, error: '无法审计' });
            }
          }
        }
        const risky = findings.filter((finding) => finding.privileged || finding.runningAsRoot || finding.oomKilled || finding.restartCount > 5);
        return { findings, riskyCount: risky.length, total: findings.length };
      },
    });
  return agent;
}
