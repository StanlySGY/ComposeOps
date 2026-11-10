export function installSreAnalysisSchema(database) {
  database.exec(`
    ALTER TABLE ops_incidents ADD COLUMN diagnosis_json TEXT NOT NULL DEFAULT '{}';
    CREATE TABLE sre_diagnosis_evaluations (
      id TEXT PRIMARY KEY, suite_version TEXT NOT NULL, protocol_version INTEGER NOT NULL,
      suite_hash TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
      config_json TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE sre_telemetry_credentials (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      host_id TEXT NOT NULL, project_id TEXT NOT NULL, services_json TEXT NOT NULL,
      host_revision TEXT NOT NULL, engine_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, created_by TEXT NOT NULL
    );
    CREATE TABLE sre_telemetry_quotas (
      credential_id TEXT PRIMARY KEY, window_at INTEGER NOT NULL, records INTEGER NOT NULL, bytes INTEGER NOT NULL
    );
    CREATE TABLE sre_telemetry (
      id TEXT PRIMARY KEY, host_id TEXT NOT NULL, project_id TEXT NOT NULL, service_name TEXT NOT NULL,
      signal TEXT NOT NULL, trace_id TEXT NOT NULL DEFAULT '', span_id TEXT NOT NULL DEFAULT '',
      parent_span_id TEXT NOT NULL DEFAULT '', observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      severity INTEGER NOT NULL, data_json TEXT NOT NULL, credential_id TEXT NOT NULL
    );
    CREATE INDEX idx_sre_telemetry_scope ON sre_telemetry(host_id,project_id,observed_at);
    CREATE INDEX idx_sre_telemetry_trace ON sre_telemetry(host_id,project_id,trace_id,observed_at);
    CREATE INDEX idx_sre_telemetry_retention ON sre_telemetry(received_at);
    CREATE INDEX idx_sre_telemetry_scope_retention ON sre_telemetry(host_id,project_id,received_at);
  `);
}
