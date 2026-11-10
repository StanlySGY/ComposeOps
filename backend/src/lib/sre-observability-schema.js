export function installSreObservabilitySchema(database) {
  database.exec(`
    ALTER TABLE sre_changes ADD COLUMN started_at INTEGER;
    CREATE TABLE sre_worker_heartbeats (
      name TEXT PRIMARY KEY, instance_id TEXT NOT NULL, state TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL, work_started_at INTEGER, progress_at INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE sre_platform_samples (sampled_at INTEGER PRIMARY KEY, data_json TEXT NOT NULL);
    CREATE TABLE sre_alert_rules (
      profile_id TEXT PRIMARY KEY, version INTEGER NOT NULL, profile_version INTEGER NOT NULL,
      config_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
    );
    CREATE TABLE sre_alert_states (
      key TEXT PRIMARY KEY, scope TEXT NOT NULL, revision TEXT NOT NULL, title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'normal', condition TEXT NOT NULL DEFAULT 'unknown',
      episode INTEGER NOT NULL DEFAULT 0, bad_count INTEGER NOT NULL DEFAULT 0,
      good_count INTEGER NOT NULL DEFAULT 0, good_since INTEGER, observed_at INTEGER NOT NULL,
      changed_at INTEGER NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', suppressed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_sre_alert_scope ON sre_alert_states(scope, state);
    CREATE TABLE sre_alert_deliveries (
      id TEXT PRIMARY KEY, alert_key TEXT NOT NULL, episode INTEGER NOT NULL, transition TEXT NOT NULL,
      channel TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      error TEXT NOT NULL DEFAULT '', UNIQUE(alert_key, episode, transition, channel)
    );
    CREATE INDEX idx_sre_alert_delivery_queue ON sre_alert_deliveries(status, next_at);
  `);
}
