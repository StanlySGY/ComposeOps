export function installAccountsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),
    enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_grants (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    host_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(account_id,host_id,project_id)
  );
  CREATE TABLE IF NOT EXISTS account_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL)`);
  if (!db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'account_id')) db.exec('ALTER TABLE sessions ADD COLUMN account_id TEXT REFERENCES accounts(id)');
}
