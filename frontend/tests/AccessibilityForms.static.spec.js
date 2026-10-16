import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseTemplate } from '@vue/compiler-dom';

function templateNodes(relativePath) {
  const filename = new URL(relativePath, import.meta.url);
  const source = readFileSync(filename, 'utf8');
  const { descriptor, errors } = parseSfc(source, { filename: filename.pathname });
  expect(errors).toEqual([]);
  expect(descriptor.template).not.toBeNull();
  const nodes = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 1) {
      nodes.push(node);
      for (const child of node.children || []) walk(child);
    } else {
      for (const child of node.children || []) walk(child);
    }
  }
  walk(parseTemplate(descriptor.template.content));
  return nodes;
}
function hasAttr(node, name, expectedValue) {
  return (node.props || []).some((prop) => {
    const attrName = prop.type === 6 ? prop.name : prop.type === 7 && prop.name === 'bind' ? prop.arg?.content : null;
    if (attrName !== name) return false;
    if (expectedValue === undefined) return true;
    if (prop.type === 6) return prop.value?.content === expectedValue;
    return false;
  });
}
function findNamedControls(relativePath, name) {
  return templateNodes(relativePath).filter((node) => ['input', 'select', 'textarea'].includes(node.tag) && hasAttr(node, 'aria-label', name));
}
function findNode(relativePath, tag, name, value) {
  return templateNodes(relativePath).find((node) => node.tag === tag && hasAttr(node, name, value));
}

function hasClassToken(node, token) {
  const value = (node.props || []).find((prop) => prop.type === 6 && prop.name === 'class')?.value?.content || '';
  return value.split(/\s+/).includes(token);
}

describe('跨页面表单可访问性契约', () => {
  it('Compose 编辑器的项目、配置文件和模板选择器有名称', () => {
    const file = '../src/views/ComposeView.vue';
    for (const label of ['选择 Compose 项目', '清除当前 Compose 项目', '选择 Compose 配置文件', '插入常用服务模板']) {
      expect(findNamedControls(file, label).length + templateNodes(file).filter(n => n.tag === 'button' && hasAttr(n, 'aria-label', label)).length).toBeGreaterThan(0);
    }
  });

  it('容器终端的项目、容器和 Shell 选择器有明确名称', () => {
    const file = '../src/views/ShellView.vue';
    for (const label of ['选择终端项目', '选择终端容器', '选择终端 Shell']) expect(findNamedControls(file, label)).toHaveLength(1);
    expect(findNode(file, 'p', 'role', 'alert')).not.toBeUndefined();
  });

  it('历史资源监控将可见标签关联到项目和容器选择器，并声明加载/错误状态', () => {
    const file = '../src/views/ResourceMonitorView.vue';
    expect(findNode(file, 'select', 'id', 'resource-monitor-project')).toBeDefined();
    expect(findNode(file, 'select', 'id', 'resource-monitor-container')).toBeDefined();
    const nodes = templateNodes(file);
    expect(nodes.some(n => n.tag === 'label' && hasAttr(n, 'for', 'resource-monitor-project'))).toBe(true);
    expect(nodes.some(n => n.tag === 'label' && hasAttr(n, 'for', 'resource-monitor-container'))).toBe(true);
    expect(nodes.some(n => hasAttr(n, 'role', 'status') && hasAttr(n, 'aria-live', 'polite'))).toBe(true);
    expect(nodes.some(n => hasAttr(n, 'role', 'alert'))).toBe(true);
  });

  it('自动巡检间隔选择器具有稳定的无障碍名称', () => {
    const file = '../src/views/InspectionView.vue';
    expect(findNamedControls(file, '自动巡检间隔')).toHaveLength(1);
  });

  it('节点组选择器对每个节点提供动态可访问名称', () => {
    const file = '../src/views/NodeGroupView.vue';
    expect(templateNodes(file).some(n => n.tag === 'select' && hasAttr(n, 'aria-label'))).toBe(true);
  });

  it('操作中心按类型区分操作记录和后台任务筛选器', () => {
    const file = '../src/views/OperationsView.vue';
    expect(findNamedControls(file, '筛选操作记录结果')).toHaveLength(1);
    expect(findNamedControls(file, '筛选后台任务状态')).toHaveLength(1);
  });

  it('存储清理的搜索、状态筛选和批量删除反馈可被识别', () => {
    const file = '../src/views/ResourcesView.vue';
    expect(findNamedControls(file, '搜索存储资源')).toHaveLength(1);
    expect(findNamedControls(file, '按资源状态筛选')).toHaveLength(1);
    const nodes = templateNodes(file);
    expect(nodes.some(n => hasAttr(n, 'role', 'alert'))).toBe(true);
    expect(nodes.some(n => hasAttr(n, 'role', 'status') && hasAttr(n, 'aria-live', 'polite'))).toBe(true);
  });

  it('工作流编辑器的基础字段有标签关联，节点 ID 和类型有名称', () => {
    const file = '../src/views/WorkflowCenterView.vue';
    const nodes = templateNodes(file);
    for (const [id, label] of [['workflow-name', '名称'], ['workflow-description', '描述'], ['workflow-trigger-type', '触发方式']]) {
      expect(nodes.some(n => n.tag === 'label' && hasAttr(n, 'for', id) && n.children.some(c => c.type === 2 && c.content === label))).toBe(true);
      expect(nodes.some(n => ['input', 'select'].includes(n.tag) && hasAttr(n, 'id', id))).toBe(true);
    }
    expect(nodes.some(n => n.tag === 'input' && hasAttr(n, 'aria-label'))).toBe(true);
    expect(nodes.some(n => n.tag === 'select' && hasAttr(n, 'aria-label'))).toBe(true);
  });

  it('预览生成期间通过独立 polite status 播报进度', () => {
    for (const [file, label] of [
      ['../src/components/services/ProjectEnvModal.vue', '正在生成环境变量变更预览'],
      ['../src/components/services/ProjectUpgradeModal.vue', '正在生成升级变更预览'],
    ]) {
      const nodes = templateNodes(file);
      expect(nodes.some(node => node.tag === 'p'
        && hasClassToken(node, 'sr-only')
        && hasAttr(node, 'role', 'status')
        && hasAttr(node, 'aria-live', 'polite')
        && hasAttr(node, 'aria-atomic', 'true')
        && (node.children || []).some(child => child.type === 2 && child.content === label)), file).toBe(true);
    }
  });

  it('标准标签页具有面板关联、单一 Tab 停靠点和键盘处理', () => {
    const files = [
      '../src/views/OperationsView.vue',
      '../src/views/ReleaseView.vue',
      '../src/views/EventCenterView.vue',
      '../src/views/CMDBView.vue',
      '../src/views/MonitorView.vue',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const nodes = templateNodes(file);
      const tablists = nodes.filter(node => hasAttr(node, 'role', 'tablist'));
      const tabs = nodes.filter(node => hasAttr(node, 'role', 'tab'));
      const panels = nodes.filter(node => hasAttr(node, 'role', 'tabpanel'));
      expect(tablists.length, file).toBe(1);
      expect(tabs.length, file).toBeGreaterThanOrEqual(2);
      expect(panels.length, file).toBeGreaterThanOrEqual(1);
      expect(tablists.some(node => (node.props || []).some(prop => prop.type === 7 && prop.name === 'on' && prop.arg?.content === 'keydown')), file).toBe(true);
      for (const tab of tabs) {
        expect(hasAttr(tab, 'id'), file).toBe(true);
        expect(hasAttr(tab, 'data-tab'), file).toBe(true);
        expect(hasAttr(tab, 'aria-controls'), file).toBe(true);
        expect(hasAttr(tab, 'aria-selected'), file).toBe(true);
        expect(hasAttr(tab, 'tabindex'), file).toBe(true);
      }
      for (const panel of panels) {
        expect(hasAttr(panel, 'id'), file).toBe(true);
        expect(hasAttr(panel, 'aria-labelledby'), file).toBe(true);
      }
      expect(source.includes('handleTablistKeydown'), file).toBe(true);
    }
  });

  it('图谱呈现和布局模式使用带 pressed 状态的按钮组，而非不完整的标签页', () => {
    for (const file of ['../src/components/ForceGraph.vue', '../src/views/KnowledgeGraphView.vue']) {
      const nodes = templateNodes(file);
      expect(nodes.some(node => hasAttr(node, 'role', 'group') && hasAttr(node, 'aria-label')), file).toBe(true);
      expect(nodes.some(node => hasAttr(node, 'role', 'tablist')), file).toBe(false);
      expect(nodes.filter(node => node.tag === 'button' && hasAttr(node, 'aria-pressed')).length, file).toBeGreaterThanOrEqual(2);
    }
  });

  it('页面级错误反馈通过 alert 播报，成功消息通过 polite status 播报', () => {
    const pageAlertFiles = [
      '../src/views/MonitorView.vue',
      '../src/views/TopologyView.vue',
      '../src/views/ComposeView.vue',
      '../src/views/ServicesView.vue',
      '../src/views/CronTasksView.vue',
      '../src/views/CMDBView.vue',
      '../src/views/DashboardView.vue',
      '../src/views/KnowledgeGraphView.vue',
      '../src/views/EventCenterView.vue',
      '../src/components/services/ProjectUpgradeModal.vue',
    ];
    for (const file of pageAlertFiles) {
      expect(templateNodes(file).some((node) => hasClassToken(node, 'alert-error') && hasAttr(node, 'role', 'alert')), file).toBe(true);
    }

    const historyNodes = templateNodes('../src/views/AgentExecutionHistoryView.vue');
    expect(historyNodes.some((node) => node.tag === 'div' && hasClassToken(node, 'card') && hasAttr(node, 'role', 'alert'))).toBe(true);
    const costNodes = templateNodes('../src/views/CostAnalysisView.vue');
    expect(costNodes.some((node) => hasClassToken(node, 'error-state') && hasAttr(node, 'role', 'alert'))).toBe(true);

    const upgradeNodes = templateNodes('../src/components/services/ProjectUpgradeModal.vue');
    expect(upgradeNodes.some((node) => hasAttr(node, 'role', 'status') && hasAttr(node, 'aria-live', 'polite'))).toBe(true);

    for (const file of ['../src/views/ComposeView.vue', '../src/views/CronTasksView.vue']) {
      expect(templateNodes(file).some((node) => hasAttr(node, 'role', 'status') && hasAttr(node, 'aria-live', 'polite')), file).toBe(true);
    }
  });

  it('Agent 工作台的项目、审批策略、重命名和消息输入控件有名称', () => {
    const file = '../src/views/AgentWorkflowView.vue';
    for (const label of ['选择 Agent 当前项目上下文', '选择本会话操作审批策略', '向 Agent 发送消息', '确认执行参数 JSON']) expect(findNamedControls(file, label)).toHaveLength(1);
    expect(templateNodes(file).some(n => n.tag === 'input' && hasAttr(n, 'aria-label'))).toBe(true);
    expect(templateNodes(file).some(n => n.tag === 'div' && hasAttr(n, 'role', 'log') && hasAttr(n, 'aria-live', 'polite'))).toBe(true);
  });
});
