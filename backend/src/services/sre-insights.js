import db from '../lib/db.js';

export function sreInsights({ days = 30, now = Date.now() } = {}) {
  const from = new Date(now - days * 86400000).toISOString();
  const incidents = db.prepare('SELECT * FROM ops_incidents WHERE opened_at>=? ORDER BY opened_at').all(from);
  const effects = db.prepare(`SELECT e.status,e.approved_by,e.started_at FROM ops_effects e JOIN ops_incidents i ON i.id=e.ticket_id
    WHERE i.opened_at>=? AND i.effect_id=e.id`).all(from);
  const restored = incidents.filter(row => row.resolved_at);
  const durations = restored.map(row => Date.parse(row.resolved_at) - Date.parse(row.opened_at)).filter(ms => ms >= 0).sort((a, b) => a - b);
  const percentile = p => durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)] : null;
  const outcomes = {};
  for (const effect of effects) outcomes[effect.status] = (outcomes[effect.status] || 0) + 1;
  const correlations = new Map();
  for (const row of incidents) correlations.set(row.correlation_key, (correlations.get(row.correlation_key) || 0) + 1);
  const scopes = {};
  for (const row of restored) {
    const scope = JSON.parse(row.verification_json || '{}').scope || 'unknown';
    scopes[scope] = (scopes[scope] || 0) + 1;
  }
  return { days, from, to: new Date(now).toISOString(), incidents: incidents.length, resolved: restored.length,
    unresolved: incidents.length - restored.length, verifiedRecoveryRate: incidents.length ? restored.length / incidents.length * 100 : null,
    medianRecoveryMs: percentile(0.5), p95RecoveryMs: percentile(0.95), recoverySamples: durations.length,
    recurringTargets: [...correlations.values()].filter(count => count > 1).length, effectOutcomes: outcomes,
    automaticDispatches: effects.filter(effect => effect.started_at && effect.approved_by?.startsWith('sre-policy:')).length,
    manualDispatches: effects.filter(effect => effect.started_at && !effect.approved_by?.startsWith('sre-policy:')).length,
    verificationScopes: scopes };
}
