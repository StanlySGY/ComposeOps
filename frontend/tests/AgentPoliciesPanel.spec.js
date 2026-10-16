import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AgentPoliciesPanel from '../src/components/settings/AgentPoliciesPanel.vue';

const apiMocks = vi.hoisted(() => ({
  getAgentPolicyGroups: vi.fn(),
  createAgentPolicyGroup: vi.fn(),
  updateAgentPolicyGroup: vi.fn(),
  deleteAgentPolicyGroup: vi.fn(),
  getAgentPolicyRules: vi.fn(),
  createAgentPolicyRule: vi.fn(),
  updateAgentPolicyRule: vi.fn(),
  deleteAgentPolicyRule: vi.fn(),
  getAgentAuditEvents: vi.fn(),
}));

vi.mock('../src/api/client.js', () => ({ api: apiMocks }));

const group = { id: 'group-prod', name: 'Production guards', description: 'No destructive changes', enabled: true, ruleCount: 1 };
const rule = {
  id: 'rule-deny-delete', groupId: group.id, groupName: group.name, name: 'Deny production volume deletion',
  effect: 'deny', priority: 10, enabled: true, toolName: 'volume.delete', projectId: 'prod',
  parameters: { action: 'delete' }, reason: 'Production volumes are protected',
};
const audit = {
  id: 'audit-1', planId: 'plan-1', executionId: 'exec-1', eventType: 'policy_decision',
  actor: 'policy-engine', toolName: 'volume.delete', decision: 'deny',
  ruleName: rule.name, reason: rule.reason, parametersHash: 'f'.repeat(64), createdAt: '2026-10-16 04:00:00',
};

let wrapper;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.getAgentPolicyGroups.mockResolvedValue({ groups: [group] });
  apiMocks.getAgentPolicyRules.mockResolvedValue({ rules: [rule] });
  apiMocks.getAgentAuditEvents.mockResolvedValue({ events: [audit] });
  apiMocks.createAgentPolicyGroup.mockResolvedValue({ group: { ...group, id: 'group-new', name: 'New group', ruleCount: 0 } });
  apiMocks.createAgentPolicyRule.mockResolvedValue({ rule });
  apiMocks.updateAgentPolicyGroup.mockResolvedValue({ group });
  apiMocks.updateAgentPolicyRule.mockResolvedValue({ rule });
  apiMocks.deleteAgentPolicyGroup.mockResolvedValue({ ok: true });
  apiMocks.deleteAgentPolicyRule.mockResolvedValue({ ok: true });
});

describe('AgentPoliciesPanel', () => {
  it('shows the selected policy group, deny-first rule and linked audit event', async () => {
    wrapper = mount(AgentPoliciesPanel);
    await flushPromises();

    expect(wrapper.text()).toContain('Production guards');
    expect(wrapper.text()).toContain('Deny 优先');
    expect(wrapper.text()).toContain('Deny production volume deletion');
    expect(wrapper.text()).toContain('Production volumes are protected');
    expect(wrapper.text()).toContain('SHA256 ffffffffffff…');
    expect(wrapper.text()).toContain('exec-1');
    expect(apiMocks.getAgentPolicyGroups).toHaveBeenCalledOnce();
    expect(apiMocks.getAgentAuditEvents).toHaveBeenCalledWith(100);
  });

  it('creates a group and a deny rule from validated form values', async () => {
    wrapper = mount(AgentPoliciesPanel);
    await flushPromises();

    const groupForm = wrapper.findAll('form')[0];
    await groupForm.get('input[placeholder="例如：生产环境保护"]').setValue('Staging guard');
    await groupForm.get('input[placeholder="适用范围或运维约定"]').setValue('Protect preview resources');
    apiMocks.getAgentPolicyGroups.mockResolvedValue({ groups: [group, { ...group, id: 'group-new', name: 'New group', description: 'Protect preview resources', ruleCount: 0 }] });
    await groupForm.trigger('submit');
    await flushPromises();

    expect(apiMocks.createAgentPolicyGroup).toHaveBeenCalledWith({
      name: 'Staging guard', description: 'Protect preview resources',
    });

    const ruleForm = wrapper.findAll('form')[1];
    await ruleForm.get('input[placeholder="例如：禁止删除生产卷"]').setValue('Deny staging deletion');
    await ruleForm.get('input[placeholder="compose.ps 或 *"]').setValue('volume.delete');
    await ruleForm.get('input[placeholder="project-id 或 *"]').setValue('staging');
    await ruleForm.get('textarea[aria-label="参数匹配 JSON"]').setValue('{"action":"delete"}');
    await ruleForm.get('input[placeholder="例如：生产环境禁止执行破坏性操作"]').setValue('Keep data');
    await ruleForm.trigger('submit');
    await flushPromises();

    expect(apiMocks.createAgentPolicyRule).toHaveBeenCalledWith({
      groupId: 'group-new', name: 'Deny staging deletion', effect: 'deny',
      priority: 100, enabled: true, toolName: 'volume.delete', projectId: 'staging',
      parameters: { action: 'delete' }, reason: 'Keep data',
    });
  });

  it('reports malformed parameter JSON without calling the policy API', async () => {
    wrapper = mount(AgentPoliciesPanel);
    await flushPromises();
    const ruleForm = wrapper.findAll('form')[1];
    await ruleForm.get('input[placeholder="例如：禁止删除生产卷"]').setValue('Bad JSON rule');
    await ruleForm.get('textarea[aria-label="参数匹配 JSON"]').setValue('{');
    await ruleForm.trigger('submit');
    await flushPromises();

    expect(apiMocks.createAgentPolicyRule).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('参数匹配 JSON 格式错误');
  });
});
