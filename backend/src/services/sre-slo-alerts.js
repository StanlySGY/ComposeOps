import db from '../lib/db.js';
import { getSreProfile, listSreProfiles } from './sre-profiles.js';
import { observeSreAlert, closeSreAlerts } from './sre-alerts.js';
import { recordAgentAuditEvent } from './agent/policy-store.js';

export const SLO_ALERT_DEFAULTS = Object.freeze({ enabled: false, minimumCoverage: 0.9, maintenanceUntil: 0,
  fast: { shortMinutes: 5, longMinutes: 60, burnRate: 14.4 }, slow: { shortMinutes: 30, longMinutes: 360, burnRate: 6 }, recoverMinutes: 5 });
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
function number(value, min, max, name) { if (!Number.isFinite(value) || value < min || value > max) fail(`${name}超出范围`); return value; }
export function validateSloAlertConfig(input, now = Date.now()) {
  if (typeof input?.enabled !== 'boolean') fail('请选择是否启用告警');
  const config = { enabled: input.enabled, minimumCoverage: number(input.minimumCoverage, 0.5, 1, '覆盖率'),
    maintenanceUntil: number(input.maintenanceUntil || 0, 0, now + 30 * 86400000, '维护截止时间'),
    recoverMinutes: number(input.recoverMinutes, 1, 60, '恢复滞回') };
  for (const key of ['fast', 'slow']) {
    const window = input[key] || {};
    config[key] = { shortMinutes: number(window.shortMinutes, 1, 120, '短窗口'), longMinutes: number(window.longMinutes, 5, 1440, '长窗口'), burnRate: number(window.burnRate, 1, 1000, '消耗率') };
    if (config[key].shortMinutes >= config[key].longMinutes) fail('短窗口必须小于长窗口');
  }
  return config;
}
export function getSloAlertRule(profileId) {
  const row = db.prepare('SELECT * FROM sre_alert_rules WHERE profile_id=?').get(profileId);
  return row ? { profileId, version: row.version, profileVersion: row.profile_version, config: JSON.parse(row.config_json), updatedAt: row.updated_at, updatedBy: row.updated_by }
    : { profileId, version: 0, profileVersion: null, config: structuredClone(SLO_ALERT_DEFAULTS) };
}
export function saveSloAlertRule(profileId, input, actor = 'admin') {
  const config = validateSloAlertConfig(input.config), profile = getSreProfile(profileId);
  return db.transaction(() => {
    const current = getSloAlertRule(profileId);
    if (input.version !== current.version) throw Object.assign(new Error('告警配置已变化，请刷新'), { statusCode: 409 });
    const version = current.version + 1;
    db.prepare(`INSERT INTO sre_alert_rules(profile_id,version,profile_version,config_json,updated_at,updated_by) VALUES(?,?,?,?,?,?)
      ON CONFLICT(profile_id) DO UPDATE SET version=excluded.version,profile_version=excluded.profile_version,config_json=excluded.config_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(profileId, version, profile.version, JSON.stringify(config), Date.now(), actor);
    closeSreAlerts(`profile:${profileId}`, `${profile.version}:${version}`, '告警规则或目标改版；历史关闭不代表恢复', Date.now(), { withinTransaction: true });
    recordAgentAuditEvent({ eventType: 'sre_alert_rule', actor, toolName: 'sre.alerts', decision: config.enabled ? 'enabled' : 'disabled', details: { profileId, version, config } });
    return getSloAlertRule(profileId);
  })();
}

/** Piecewise time coverage: a sample certifies no more than one 30-second probe interval. */
export function burnWindow(samples, { now, windowMs, targetPercent, intervalMs = 30000 }) {
  const start = now - windowMs;
  let goodMs = 0, badMs = 0;
  const sorted = [...samples].filter(row => row.sampled_at <= now).sort((a, b) => a.sampled_at - b.sampled_at);
  for (let index = 0; index < sorted.length; index++) {
    const sample = sorted[index], end = Math.min(now, sample.sampled_at + intervalMs, sorted[index + 1]?.sampled_at ?? now);
    const duration = Math.max(0, end - Math.max(start, sample.sampled_at));
    if (sample.outcome === 'good') goodMs += duration;
    if (sample.outcome === 'bad') badMs += duration;
  }
  const observedMs = goodMs + badMs, budget = 1 - targetPercent / 100;
  return { windowMs, goodMs, badMs, unknownMs: Math.max(0, windowMs - observedMs), coverage: observedMs / windowMs,
    burnRate: observedMs && budget > 0 ? badMs / observedMs / budget : null, zeroBudget: budget <= 0 };
}
export function sloAlertEvidence(profile, rule = getSloAlertRule(profile.id), now = Date.now()) {
  const maximum = Math.max(rule.config.fast.longMinutes, rule.config.slow.longMinutes) * 60000;
  const samples = db.prepare('SELECT sampled_at,outcome FROM sre_probe_samples WHERE profile_id=? AND version=? AND sampled_at>=? AND sampled_at<=? ORDER BY sampled_at')
    .all(profile.id, profile.version, now - maximum - 30000, now);
  const evidence = {};
  for (const name of ['fast', 'slow']) {
    const pair = rule.config[name];
    const short = burnWindow(samples, { now, windowMs: pair.shortMinutes * 60000, targetPercent: profile.config.targetPercent });
    const long = burnWindow(samples, { now, windowMs: pair.longMinutes * 60000, targetPercent: profile.config.targetPercent });
    const enough = short.coverage >= rule.config.minimumCoverage && long.coverage >= rule.config.minimumCoverage;
    const over = value => value.zeroBudget ? value.badMs > 0 : value.burnRate >= pair.burnRate;
    evidence[name] = { short, long, threshold: pair.burnRate, condition: !enough ? 'unknown' : over(short) && over(long) ? 'bad' : 'good' };
  }
  return evidence;
}
export function evaluateSloAlerts(now = Date.now(), dependencies = {}) {
  const profiles = listSreProfiles(), retained = new Set();
  for (const profile of profiles) {
    const rule = getSloAlertRule(profile.id), scope = `profile:${profile.id}`, revision = `${profile.version}:${rule.version}`;
    retained.add(scope);
    const enabled = profile.enabled && rule.config.enabled && rule.profileVersion === profile.version;
    closeSreAlerts(scope, enabled ? revision : 'disabled', enabled ? '目标或规则改版' : '目标暂停、归档或告警规则需要重新审阅', now);
    if (!enabled) continue;
    const evidence = sloAlertEvidence(profile, rule, now), suppressed = rule.config.maintenanceUntil > now;
    for (const name of ['fast', 'slow']) observeSreAlert({ key: `${scope}:${revision}:${name}`, scope, revision,
      title: `${profile.projectName}/${profile.serviceName} ${name === 'fast' ? '快速' : '持续'}错误预算消耗`,
      condition: evidence[name].condition, detail: evidence[name], at: now, suppressed, recoverMs: rule.config.recoverMinutes * 60000 }, dependencies);
    observeSreAlert({ key: `${scope}:${revision}:coverage`, scope, revision, title: `${profile.projectName}/${profile.serviceName} 探针覆盖不足`,
      condition: Object.values(evidence).some(value => value.condition === 'unknown') ? 'bad' : 'good', detail: evidence, at: now, suppressed }, dependencies);
  }
  for (const row of db.prepare("SELECT DISTINCT scope FROM sre_alert_states WHERE scope LIKE 'profile:%' AND state<>'closed'").all()) {
    if (!retained.has(row.scope)) closeSreAlerts(row.scope, 'archived', '应用目标已归档', now);
  }
}
