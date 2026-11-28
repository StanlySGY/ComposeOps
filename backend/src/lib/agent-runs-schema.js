export function installAgentRunsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY, session_id INTEGER NOT NULL, owner_id TEXT NOT NULL,
    goal TEXT NOT NULL, context_json TEXT NOT NULL, status TEXT NOT NULL,
    plan_ids_json TEXT NOT NULL DEFAULT '[]', checkpoint_json TEXT NOT NULL DEFAULT '{}',
    approval_json TEXT, result_json TEXT, error TEXT, revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_active_session ON agent_runs(session_id)
    WHERE status IN ('running','waiting_approval','stopping');
  CREATE TABLE IF NOT EXISTS agent_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    event_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id,id);
  CREATE TABLE IF NOT EXISTS agent_run_effects (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL, fingerprint TEXT NOT NULL, params_json TEXT NOT NULL,
    status TEXT NOT NULL, result_json TEXT, evidence_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(run_id,tool_name,fingerprint)
  );`);
}
