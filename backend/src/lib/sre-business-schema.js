export function installSreBusinessSchema(database) {
  database.exec(`
    CREATE TABLE sre_business_plans (
      id TEXT PRIMARY KEY, host_id TEXT NOT NULL, project_id TEXT NOT NULL, project_name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL, identity_json TEXT NOT NULL, next_run_at INTEGER,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
    );
    CREATE TABLE sre_business_backups (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER, requested_by TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE sre_business_runs (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER, requested_by TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_sre_business_backups_plan ON sre_business_backups(plan_id,created_at);
    CREATE INDEX idx_sre_business_runs_plan ON sre_business_runs(plan_id,created_at);
  `);
}
