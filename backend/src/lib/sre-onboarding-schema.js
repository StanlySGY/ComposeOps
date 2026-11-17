export function installSreOnboardingSchema(database) {
  database.exec(`CREATE TABLE sre_onboarding (
    id TEXT PRIMARY KEY, host_id TEXT NOT NULL, project_id TEXT NOT NULL, project_name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', config_json TEXT NOT NULL,
    progress_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
  ); CREATE INDEX idx_sre_onboarding_scope ON sre_onboarding(host_id,project_id,updated_at);`);
}
