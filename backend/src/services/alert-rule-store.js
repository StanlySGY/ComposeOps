import { getSetting, setSetting } from '../lib/db.js';

export function readAlertRules() {
  try {
    const rules = JSON.parse(getSetting('agent.alert_rules', '[]'));
    return Array.isArray(rules) ? rules : [];
  } catch { return []; }
}
export function writeAlertRules(rules) { setSetting('agent.alert_rules', JSON.stringify(rules)); }

/** A container ID is an immutable target. Never fall back to a name after it disappears. */
export function alertMatchesContainer(rule, container) {
  if (rule.containerIds?.length) return rule.containerIds.includes(container.id);
  if (rule.containerId) return rule.containerId === container.id;
  return !!rule.service && (container.service === rule.service || container.name === rule.service);
}
