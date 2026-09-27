import Database from 'better-sqlite3';
import { chmodSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { createHash } from 'node:crypto';
import { redactValue } from './redaction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/opsdash.db');

const db = new Database(DB_PATH);
chmodSync(DB_PATH, 0o600);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 建表：平台配置（KV）与 AI 对话历史
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    role       TEXT NOT NULL,          -- user | assistant | system
    content    TEXT NOT NULL,
    context    TEXT,                    -- JSON: 关联的日志/compose 文件等上下文标记
    session_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_sessions (
    session_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_key TEXT NOT NULL UNIQUE,
    value      TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'conversation',
    confidence TEXT NOT NULL DEFAULT 'medium',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_memories_updated ON ai_memories(updated_at);

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_preferences (
    project_id TEXT PRIMARY KEY,
    managed INTEGER NOT NULL DEFAULT 0,
    mount_enabled INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS compose_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'save',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS operation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    project_name TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS alert_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL DEFAULT '',
    title      TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    priority   TEXT NOT NULL DEFAULT 'warning',
    target     TEXT,
    read       INTEGER NOT NULL DEFAULT 0,
    muted      INTEGER NOT NULL DEFAULT 0,
    logs       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_alert_events_created ON alert_events(created_at);

  CREATE TABLE IF NOT EXISTS background_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS background_job_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    status TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    exit_code INTEGER,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_background_job_items_job ON background_job_items(job_id, id);

  CREATE TABLE IF NOT EXISTS agent_plans (
    id TEXT PRIMARY KEY,
    session_id INTEGER NOT NULL DEFAULT 0,
    user_message TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    executed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_executions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES agent_plans(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    parameters TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    duration_ms INTEGER,
    parameters_hash TEXT,
    confirmation_status TEXT NOT NULL DEFAULT 'not_required',
    confirmed_by TEXT,
    confirmed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS performance_baselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL DEFAULT '',
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agent_plans_session ON agent_plans(session_id);
  CREATE INDEX IF NOT EXISTS idx_agent_executions_plan ON agent_executions(plan_id);
`);

/**
 * 迁移清单。序号即目标 user_version,必须单调递增且只追加,不要修改已发布的条目。
 *
 * 历史库在引入版本号之前就已经通过 PRAGMA table_info 探测补齐了这些列,
 * 且它们的 user_version 仍是 0,因此每条迁移都必须保持幂等:
 * 加列前先探测,已存在就跳过,重放时不会因重复列而失败。
 */
const MIGRATIONS = [
  {
    version: 1,
    name: '项目纳管白名单与会话/告警/Agent 反馈列',
    up(database) {
      addColumn(database, 'project_preferences', 'managed', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(database, 'project_preferences', 'mount_enabled', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(database, 'ai_history', 'session_id', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(database, 'alert_events', 'logs', "TEXT NOT NULL DEFAULT ''");
      addColumn(database, 'agent_plans', 'rating', 'INTEGER');
      addColumn(database, 'agent_plans', 'feedback_text', "TEXT NOT NULL DEFAULT ''");
      addColumn(database, 'agent_plans', 'feedback_at', 'TEXT');
    },
  },
  {
    version: 2,
    name: 'Agent 执行状态追踪列',
    up(database) {
      addColumn(database, 'agent_plans', 'progress_stage', 'TEXT');
      addColumn(database, 'agent_plans', 'progress_percent', 'INTEGER DEFAULT 0');
      addColumn(database, 'agent_plans', 'current_step_index', 'INTEGER DEFAULT 0');
      addColumn(database, 'agent_plans', 'updated_at', 'TEXT');
    },
  },
  {
    version: 3,
    name: 'Agent 上下文持久化(projectId/containerId)',
    up(database) {
      addColumn(database, 'agent_plans', 'project_id', 'TEXT');
      addColumn(database, 'agent_plans', 'container_id', 'TEXT');
    },
  },
  {
    version: 4,
    name: '容器资源指标历史记录',
    up(database) {
      // Agent 审计列与指标表同批迁移,兼容测试/历史库中缺失执行表的情况。
      const hasExecutionTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_executions'").get();
      if (hasExecutionTable) {
        addColumn(database, 'agent_executions', 'parameters_hash', 'TEXT');
        addColumn(database, 'agent_executions', 'confirmation_status', "TEXT NOT NULL DEFAULT 'not_required'");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS container_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          container_id TEXT NOT NULL,
          metric_type TEXT NOT NULL,
          value REAL NOT NULL,
          value_json TEXT,
          unit TEXT,
          timestamp INTEGER NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_container_time ON container_metrics(container_id, timestamp DESC)`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_type_time ON container_metrics(metric_type, timestamp DESC)`);
    },
  },
  {
    version: 5,
    name: '数据卷备份记录',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS volume_backups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          project_name TEXT NOT NULL,
          volume TEXT NOT NULL,
          file TEXT NOT NULL,
          bytes INTEGER DEFAULT 0,
          host TEXT NOT NULL DEFAULT 'local',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_volume_backups_project ON volume_backups(project_id, created_at DESC)`);
    },
  },
  {
    version: 6,
    name: '巡检报告与容量预测样本',
    up(database) {
      // 每条巡检都落一行:既是报告历史,也是容量预测的采样点(disk_used/disk_total)。
      database.exec(`
        CREATE TABLE IF NOT EXISTS inspections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL DEFAULT 'manual',
          score INTEGER NOT NULL DEFAULT 100,
          grade TEXT NOT NULL DEFAULT 'healthy',
          findings_json TEXT NOT NULL DEFAULT '[]',
          predictions_json TEXT NOT NULL DEFAULT '[]',
          summary TEXT NOT NULL DEFAULT '',
          stats_json TEXT NOT NULL DEFAULT '{}',
          disk_used INTEGER,
          disk_total INTEGER,
          duration_ms INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_inspections_created ON inspections(created_at DESC)`);
    },
  },
  {
    version: 7,
    name: '统一资产模型(CMDB)',
    up(database) {
      // 统一资产:Host/Project/Container/Volume/Network 等全部收敛为 asset 实体。
      database.exec(`
        CREATE TABLE IF NOT EXISTS assets (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,               -- host | project | container | volume | network | service
          name TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          host_id TEXT NOT NULL DEFAULT 'local',
          status TEXT NOT NULL DEFAULT 'unknown', -- online | offline | running | stopped | unknown
          properties TEXT NOT NULL DEFAULT '{}',
          tags TEXT NOT NULL DEFAULT '[]',
          owner TEXT NOT NULL DEFAULT '',
          environment TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'manual', -- manual | scanner | docker
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets(kind);
        CREATE INDEX IF NOT EXISTS idx_assets_host ON assets(host_id);
        CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);

        CREATE TABLE IF NOT EXISTS asset_relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          relation TEXT NOT NULL,           -- depends_on | runs_on | owns | contains | connects_to
          properties TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_asset_relations_source ON asset_relations(source_id);
        CREATE INDEX IF NOT EXISTS idx_asset_relations_target ON asset_relations(target_id);
      `);
    },
  },
  {
    version: 8,
    name: '统一事件中心(event_records)',
    up(database) {
      // 统一事件流:告警/巡检/部署/回滚/Agent/GitOps 全部进入同一张表,作为时间线与事件中心的单一事实来源。
      database.exec(`
        CREATE TABLE IF NOT EXISTS event_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL DEFAULT 'alert', -- alert | inspection | deployment | rollback | agent | gitops | workflow | system
          source TEXT NOT NULL DEFAULT 'system',
          title TEXT NOT NULL DEFAULT '',
          detail TEXT NOT NULL DEFAULT '',
          severity TEXT NOT NULL DEFAULT 'info',     -- info | warning | danger
          status TEXT NOT NULL DEFAULT 'open',       -- open | acknowledged | resolved | closed
          asset_id TEXT,
          asset_name TEXT NOT NULL DEFAULT '',
          payload TEXT NOT NULL DEFAULT '{}',
          read INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_event_records_created ON event_records(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_event_records_type ON event_records(event_type);
        CREATE INDEX IF NOT EXISTS idx_event_records_asset ON event_records(asset_id);
      `);
    },
  },
  {
    version: 9,
    name: '工作流引擎(workflow_definitions/instances/steps)',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS workflow_definitions (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          trigger_type TEXT NOT NULL DEFAULT 'manual', -- manual | cron | event
          trigger_config TEXT NOT NULL DEFAULT '{}',
          nodes TEXT NOT NULL DEFAULT '[]',            -- JSON: 节点编排(trigger/condition/agent/approval/action/verify)
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS workflow_instances (
          id TEXT PRIMARY KEY,
          definition_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
          name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending', -- pending | running | waiting_approval | success | failed | cancelled
          current_node TEXT NOT NULL DEFAULT '',
          context TEXT NOT NULL DEFAULT '{}',
          result TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_instances_def ON workflow_instances(definition_id);
        CREATE INDEX IF NOT EXISTS idx_workflow_instances_status ON workflow_instances(status);

        CREATE TABLE IF NOT EXISTS workflow_steps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL DEFAULT '',
          node_type TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending', -- pending | running | waiting_approval | success | failed | skipped
          input TEXT NOT NULL DEFAULT '{}',
          output TEXT NOT NULL DEFAULT '{}',
          error TEXT NOT NULL DEFAULT '',
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_workflow_steps_instance ON workflow_steps(instance_id, id);
      `);
    },
  },
  {
    version: 10,
    name: 'Transcript 双视图:ai_sessions 记录压缩分界点',
    up(database) {
      addColumn(database, 'ai_sessions', 'compacted_before_id', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 11,
    name: 'OneSSH-style ops memory: scope banks, importance, veracity, recall_count, compact_summary',
    up(database) {
      // 1. 新表:带 scope/project/host 银行 + 重要度 + veracity + 召回计数
      database.exec(`
        CREATE TABLE IF NOT EXISTS ai_memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL DEFAULT 'global',
          scope_id TEXT NOT NULL DEFAULT '',
          memory_key TEXT NOT NULL,
          value TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'conversation',
          confidence TEXT NOT NULL DEFAULT 'medium',
          importance REAL NOT NULL DEFAULT 0.5,
          veracity TEXT NOT NULL DEFAULT 'stated',
          last_recalled_at TEXT,
          recall_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(scope, scope_id, memory_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_memories_scope ON ai_memories_new(scope, scope_id);
        CREATE INDEX IF NOT EXISTS idx_ai_memories_updated ON ai_memories_new(updated_at);
      `);

      // 2. 旧格式表存在时把数据迁移为 global/'' 银行;不存在(冷启动/空库)则直接跳过。
      const hasLegacy = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_memories'").get();
      if (hasLegacy) {
        database.exec(`
          INSERT INTO ai_memories_new (scope, scope_id, memory_key, value, source, confidence, importance, veracity, created_at, updated_at)
          SELECT 'global', '', memory_key, value, source, confidence, 0.5, 'stated', created_at, updated_at
          FROM ai_memories;
        `);
        // 3. 重命名表(幂等):旧表让位,新表上位
        database.exec(`ALTER TABLE ai_memories RENAME TO ai_memories_old;`);
        database.exec(`ALTER TABLE ai_memories_new RENAME TO ai_memories;`);
        database.exec(`DROP TABLE ai_memories_old;`);
      } else {
        // 空库/冷启动:ai_memories_new 直接转正。
        database.exec(`ALTER TABLE ai_memories_new RENAME TO ai_memories;`);
      }

      // 4. 添加 ai_sessions.compact_summary
      addColumn(database, 'ai_sessions', 'compact_summary', 'TEXT');

      // 5. 创建 ai_usage 表
      database.exec(`
        CREATE TABLE ai_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          model TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_ai_usage_session ON ai_usage(session_id);
      `);
    }
  },
  {
    version: 12,
    name: 'CMDB 关系幂等约束',
    up(database) {
      const hasRelations = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asset_relations'").get();
      if (!hasRelations) return;
      database.exec(`
        DELETE FROM asset_relations
        WHERE id NOT IN (
          SELECT MIN(id) FROM asset_relations GROUP BY source_id, target_id, relation
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_relations_edge
          ON asset_relations(source_id, target_id, relation);
      `);
    },
  },
  {
    version: 13,
    name: '热表索引(ai_history/operation_history/compose_backups)',
    up(database) {
      // 三张表都是热路径:AI 每条消息按 session_id 读写 ai_history,
      // 项目 activity 按 project_id 查 operation_history/compose_backups,此前全表扫描。
      // 按表+列存在性分别守卫:中间态数据库(迁移测试/极端历史库)可能缺表或缺列。
      const hasTable = (name) => !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
      const columnsOf = (name) => new Set(database.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name));
      if (hasTable('ai_history')) {
        const columns = columnsOf('ai_history');
        if (columns.has('session_id') && columns.has('id')) {
          database.exec(`CREATE INDEX IF NOT EXISTS idx_ai_history_session ON ai_history(session_id, id);`);
        }
        if (columns.has('created_at')) {
          database.exec(`CREATE INDEX IF NOT EXISTS idx_ai_history_created ON ai_history(created_at);`);
        }
      }
      if (hasTable('operation_history')) {
        const columns = columnsOf('operation_history');
        if (columns.has('project_id') && columns.has('created_at')) {
          database.exec(`CREATE INDEX IF NOT EXISTS idx_operation_history_project ON operation_history(project_id, created_at);`);
        }
      }
      if (hasTable('compose_backups')) {
        const columns = columnsOf('compose_backups');
        if (columns.has('project_id') && columns.has('id')) {
          database.exec(`CREATE INDEX IF NOT EXISTS idx_compose_backups_project ON compose_backups(project_id, id);`);
        }
      }
    },
  },
];

/** 幂等加列:列已存在时直接返回 false,不抛错。 */
export function addColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return false;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

function ensureAgentExecutionAuditColumns(database) {
  const hasExecutionTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_executions'").get();
  if (!hasExecutionTable) return;
  addColumn(database, 'agent_executions', 'parameters_hash', 'TEXT');
  addColumn(database, 'agent_executions', 'confirmation_status', "TEXT NOT NULL DEFAULT 'not_required'");
}

/**
 * 按 user_version 顺序执行未应用的迁移。每条迁移单独一个事务,
 * 版本号与数据变更一起提交,中途失败不会留下"半应用"的版本号。
 * @returns {number[]} 本次实际应用的版本号
 */
export function runMigrations(database = db, migrations = MIGRATIONS) {
  const current = database.pragma('user_version', { simple: true });
  const applied = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    const apply = database.transaction(() => {
      migration.up(database);
      database.pragma(`user_version = ${migration.version}`);
    });
    apply();
    applied.push(migration.version);
    console.log(`[db] 已应用迁移 v${migration.version}: ${migration.name}`);
  }
  // v4 已发布后仍可能存在未带审计列的数据库,启动时独立幂等补齐。
  ensureAgentExecutionAuditColumns(database);
  return applied;
}

runMigrations();

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function addAiMessage(role, content, context = null, sessionId = null) {
  db.prepare(
    'INSERT INTO ai_history(role, content, context, session_id) VALUES(?, ?, ?, ?)'
  ).run(role, content, context ? JSON.stringify(context) : null, sessionId == null ? 0 : sessionId);
  // 必须在下面那次 ai_sessions 写入之前取 rowid:会话行是新建时,后续的
  // last_insert_rowid() 会变成 ai_sessions 的 rowid,返回值就不再是消息 id
  // (调用方拿它做历史截断定位,错位会删到别的区间)。
  const messageId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  if (sessionId != null && Number(sessionId) !== 0) {
    db.prepare(`
      INSERT INTO ai_sessions(session_id, updated_at) VALUES(?, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET updated_at = datetime('now')
    `).run(Number(sessionId));
  }
  return messageId;
}

export function getAiHistory(limit = 50, sessionId = null, beforeId = null) {
  const hasBeforeId = Number.isSafeInteger(Number(beforeId)) && Number(beforeId) > 0;
  if (sessionId != null) {
    if (hasBeforeId) {
      return db.prepare(
        'SELECT id, role, content, context, session_id AS sessionId, created_at FROM ai_history WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?'
      ).all(sessionId, Number(beforeId), limit).reverse();
    }
    return db.prepare(
      'SELECT id, role, content, context, session_id AS sessionId, created_at FROM ai_history WHERE session_id = ? ORDER BY id DESC LIMIT ?'
    ).all(sessionId, limit).reverse();
  }
  if (hasBeforeId) {
    return db.prepare(
      'SELECT id, role, content, context, session_id AS sessionId, created_at FROM ai_history WHERE id < ? ORDER BY id DESC LIMIT ?'
    ).all(Number(beforeId), limit).reverse();
  }
  return db.prepare(
    'SELECT id, role, content, context, session_id AS sessionId, created_at FROM ai_history ORDER BY id DESC LIMIT ?'
  ).all(limit).reverse();
}

export function listAiSessions(limit = 30, kind = '') {
  const sessions = db.prepare(`
    SELECT h.session_id AS sessionId,
           COALESCE(s.title, '') AS sessionTitle,
           MAX(h.created_at) AS createdAt,
           (SELECT content FROM ai_history h2 WHERE h2.session_id = h.session_id AND h2.role = 'user' ORDER BY h2.id ASC LIMIT 1) AS firstUserMessage,
           COUNT(*) AS messageCount
    FROM ai_history h
    LEFT JOIN ai_sessions s ON s.session_id = h.session_id
    WHERE h.session_id <> 0
      AND (? = '' OR EXISTS (
        SELECT 1 FROM ai_history hk
        WHERE hk.session_id = h.session_id AND hk.context LIKE ?
      ))
    GROUP BY h.session_id
    ORDER BY MAX(id) DESC
    LIMIT ?
  `).all(
    String(kind || '') === 'agent' ? 'agent' : '',
    String(kind || '') === 'agent' ? '%"agent":true%' : '',
    Math.max(1, Math.min(Number(limit) || 30, 100)),
  );
  return sessions.map((session) => ({
    ...session,
    title: String(session.sessionTitle || session.firstUserMessage || '').replace(/\s+/g, ' ').slice(0, 80),
  }));
}

/** 创建一个新的聊天会话 ID。空会话不写入历史,首次发送消息后才会出现在列表。 */
/** 会话压缩分界:分界 id 之前的历史只用于渲染,不再发给模型。 */
export function getAiSessionCompaction(sessionId) {
  const row = db.prepare('SELECT compacted_before_id AS boundary FROM ai_sessions WHERE session_id = ?').get(Number(sessionId));
  return row ? Number(row.boundary || 0) : 0;
}

export function setAiSessionCompaction(sessionId, boundaryId) {
  db.prepare('UPDATE ai_sessions SET compacted_before_id = ? WHERE session_id = ?').run(Number(boundaryId) || 0, Number(sessionId));
}

/** 会话压缩摘要:分界前历史的交接文档,由引擎注入 system 供模型参考。 */
export function getAiSessionSummary(sessionId) {
  const row = db.prepare('SELECT compact_summary AS summary FROM ai_sessions WHERE session_id = ?').get(Number(sessionId));
  return row ? String(row.summary || '') : '';
}

export function setAiSessionSummary(sessionId, summary) {
  db.prepare('UPDATE ai_sessions SET compact_summary = ? WHERE session_id = ?').run(String(summary || '').slice(0, 20000), Number(sessionId));
}

/** 读取发给模型的活跃区历史(分界点之后);渲染层请继续用 getAiHistory 取全量。 */
export function getAiActiveHistory(limit = 50, sessionId = null) {
  const boundary = sessionId != null ? getAiSessionCompaction(sessionId) : 0;
  if (sessionId != null) {
    return db.prepare(
      'SELECT id, role, content, context, session_id AS sessionId, created_at FROM ai_history WHERE session_id = ? AND id > ? ORDER BY id DESC LIMIT ?'
    ).all(sessionId, boundary, limit).reverse();
  }
  return getAiHistory(limit);
}

export function createAiSession() {
  let sessionId = Date.now();
  while (db.prepare('SELECT 1 FROM ai_history WHERE session_id = ? LIMIT 1').get(sessionId)) sessionId += 1;
  db.prepare('INSERT INTO ai_sessions(session_id) VALUES(?)').run(sessionId);
  return sessionId;
}

export function renameAiSession(sessionId, title) {
  const id = Number(sessionId);
  const value = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('会话 ID 无效'), { statusCode: 400 });
  if (!value) throw Object.assign(new Error('会话名称不能为空'), { statusCode: 400 });
  const result = db.prepare(`
    INSERT INTO ai_sessions(session_id, title, updated_at) VALUES(?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = datetime('now')
  `).run(id, value);
  return result.changes > 0;
}

export function clearAiSession(sessionId) {
  db.prepare('DELETE FROM ai_history WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM ai_sessions WHERE session_id = ?').run(sessionId);
}

export function clearAiSessions(sessionIds = []) {
  const ids = [...new Set(sessionIds.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!ids.length) return 0;
  const remove = db.transaction((values) => {
    const deleteHistory = db.prepare('DELETE FROM ai_history WHERE session_id = ?');
    const deleteSession = db.prepare('DELETE FROM ai_sessions WHERE session_id = ?');
    let deleted = 0;
    for (const id of values) {
      const history = deleteHistory.run(id).changes;
      const session = deleteSession.run(id).changes;
      if (history || session) deleted += 1;
    }
    return deleted;
  });
  return remove(ids);
}

/** 删除某会话中 id >= fromMessageId 的全部消息 —— 用于"编辑并重发"时让持久化历史与前端保持一致。 */
export function truncateAiHistoryFrom(sessionId, fromMessageId) {
  const id = Number(sessionId);
  const fromId = Number(fromMessageId);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(fromId) || fromId <= 0) return 0;
  return db.prepare('DELETE FROM ai_history WHERE session_id = ? AND id >= ?').run(id, fromId).changes;
}

export function clearAiHistory() {
  db.prepare('DELETE FROM ai_history').run();
  db.prepare('DELETE FROM ai_sessions').run();
}

/**
 * 读取长期记忆(OneSSH 式加权召回):
 * 先按 updated_at 取 4 倍候选,再在 JS 里按
 *   score = importance × veracityWeight × (0.7 + 0.3 × recency)
 * 排序,recency 为 72h 半衰期(基于 updated_at,重存即续命);
 * veracity 权重 stated=1.0 > unknown=0.8 > inferred=0.7 > tool=0.5。
 * 老而重要的记忆不再被纯时间排序挤掉。
 */
const VERACITY_WEIGHT = { stated: 1.0, unknown: 0.8, inferred: 0.7, tool: 0.5 };
const RECALL_HALF_LIFE_HOURS = 72;

export function listAiMemories(limit = 100, query = '', database = db) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  const text = String(query || '').trim();
  const candidateLimit = Math.min(Math.max(safeLimit * 4, 50), 400);
  const where = text ? `WHERE memory_key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\'` : '';
  const like = text ? `%${text.replace(/[\\%_]/g, '\\$&')}%` : '';
  const rows = database.prepare(`
    SELECT id, scope, scope_id AS scopeId, memory_key AS memoryKey, value, source, confidence,
           importance, veracity, last_recalled_at AS lastRecalledAt, recall_count AS recallCount,
           created_at AS createdAt, updated_at AS updatedAt
    FROM ai_memories ${where}
    ORDER BY updated_at DESC, id DESC LIMIT ?
  `).all(...(text ? [like, like, candidateLimit] : [candidateLimit]));
  const now = Date.now();
  return rows
    .map((row) => {
      const stamp = Date.parse(row.updatedAt || row.createdAt || '') || now;
      const ageHours = Math.max(0, (now - stamp) / 3600000);
      const recency = Math.exp((-Math.LN2 * ageHours) / RECALL_HALF_LIFE_HOURS);
      const weight = VERACITY_WEIGHT[row.veracity] ?? 0.8;
      return { ...row, score: Number((Number(row.importance || 0.5) * weight * (0.7 + 0.3 * recency)).toFixed(4)) };
    })
    .sort((a, b) => b.score - a.score || b.recallCount - a.recallCount || (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0))
    .slice(0, safeLimit);
}

/** 召回即计数:recall_count+1、last_recalled_at=now,作为衰减与排序的输入。 */
export function recordAiMemoryRecall(ids = [], database = db) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!clean.length) return 0;
  const touch = database.transaction((list) => {
    const stmt = database.prepare(`UPDATE ai_memories SET recall_count = recall_count + 1, last_recalled_at = datetime('now') WHERE id = ?`);
    let touched = 0;
    for (const id of list) touched += stmt.run(id).changes;
    return touched;
  });
  return touch(clean);
}

/**
 * memory_sleep 记忆维护(借鉴 OneSSH engine.Sleep,纯确定性,无 LLM):
 *  1) 去重:同 value(同银行)保留重要度最高/最早一条,合并 recall_count;
 *  2) 衰减:COALESCE(last_recalled_at, updated_at) 早于 decayDays 的记忆 importance×0.9(地板 0.05);
 *  3) 清理:创建超 pruneDays、importance≤0.1 且从未被召回的记忆删除。
 */
export function sleepAiMemories({ decayDays = 30, pruneDays = 90, decayFactor = 0.9, importanceFloor = 0.05, database = db } = {}) {
  const report = { deduped: 0, decayed: 0, pruned: 0 };
  const sqliteDate = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const sleep = database.transaction(() => {
    const rows = database.prepare('SELECT id, scope, scope_id, value, importance, recall_count FROM ai_memories ORDER BY id ASC').all();
    const groups = new Map();
    for (const row of rows) {
      const groupKey = `${row.scope}\u0000${row.scopeId}\u0000${row.value}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(row);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const keeper = group.reduce((best, item) => (Number(item.importance) > Number(best.importance) ? item : best), group[0]);
      const totalRecalls = group.reduce((sum, item) => sum + Number(item.recall_count || 0), 0);
      const maxImportance = Math.max(...group.map((item) => Number(item.importance || 0)));
      database.prepare(`UPDATE ai_memories SET importance = ?, recall_count = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(maxImportance, totalRecalls, keeper.id);
      const drop = database.prepare('DELETE FROM ai_memories WHERE id = ?');
      for (const item of group) if (item.id !== keeper.id) report.deduped += drop.run(item.id).changes;
    }
    const decayCutoff = sqliteDate(Date.now() - (Number(decayDays) || 30) * 86400000);
    report.decayed = database.prepare(
      'UPDATE ai_memories SET importance = MAX(?, importance * ?) WHERE importance > ? AND COALESCE(last_recalled_at, updated_at) < ?'
    ).run(importanceFloor, decayFactor, importanceFloor, decayCutoff).changes;
    const pruneCutoff = sqliteDate(Date.now() - (Number(pruneDays) || 90) * 86400000);
    report.pruned = database.prepare(
      "DELETE FROM ai_memories WHERE importance <= 0.1 AND recall_count = 0 AND created_at < ?"
    ).run(pruneCutoff).changes;
  });
  sleep();
  return report;
}

const VERACITY_ENUM = ['stated', 'inferred', 'tool', 'unknown'];

export function upsertAiMemory(memoryKey, value, source = 'conversation', confidence = 'medium', { importance, veracity } = {}) {
  const key = String(memoryKey || '').trim().slice(0, 160);
  const content = String(value || '').trim().slice(0, 4000);
  if (!key || !content) throw Object.assign(new Error('记忆 key 和内容不能为空'), { statusCode: 400 });
  const importanceValue = Number.isFinite(Number(importance))
    ? Math.min(Math.max(Number(importance), 0), 1)
    : 0.5;
  const veracityValue = VERACITY_ENUM.includes(String(veracity || '')) ? String(veracity) : 'stated';
  db.prepare(`
    INSERT INTO ai_memories(scope, scope_id, memory_key, value, source, confidence, importance, veracity, updated_at)
    VALUES('global', '', ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(scope, scope_id, memory_key) DO UPDATE SET
      value = excluded.value, source = excluded.source, confidence = excluded.confidence,
      importance = MAX(ai_memories.importance, excluded.importance),
      veracity = excluded.veracity, updated_at = datetime('now')
  `).run(
    key,
    content,
    String(source || 'conversation').slice(0, 64),
    String(confidence || 'medium').slice(0, 32),
    importanceValue,
    veracityValue,
  );
  return listAiMemories(1, key)[0] || null;
}

export function deleteAiMemory(memoryKey) {
  return db.prepare('DELETE FROM ai_memories WHERE memory_key = ?').run(String(memoryKey || '').trim()).changes > 0;
}

/** 创建 Agent 执行计划,返回 planId。 */
export function createAgentPlan(sessionId, userMessage, planJson, projectId = null, containerId = null) {
  const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  db.prepare(
    'INSERT INTO agent_plans(id, session_id, user_message, plan_json, status, project_id, container_id) VALUES(?, ?, ?, ?, ?, ?, ?)'
  ).run(
    planId,
    sessionId == null ? 0 : Number(sessionId),
    String(userMessage || ''),
    JSON.stringify(planJson || {}),
    'pending',
    projectId || null,
    containerId || null
  );
  return planId;
}

export function getAgentPlan(planId) {
  return db.prepare('SELECT * FROM agent_plans WHERE id = ?').get(planId) || null;
}

export function updateAgentPlan(planId, patch = {}) {
  const current = getAgentPlan(planId);
  if (!current) return null;
  const status = patch.status !== undefined ? String(patch.status) : current.status;
  const resultJson = patch.resultJson !== undefined ? JSON.stringify(redactValue(patch.resultJson)) : current.result_json;
  const executedAt = patch.executedAt !== undefined ? patch.executedAt : current.executed_at;
  // 计划参数可能包含用户明确要求写入的 secret,必须保留给后续执行;
  // 对外读取统一经过路由层脱敏,执行结果与审计结果仍在这里脱敏。
  const planJson = patch.planJson !== undefined ? JSON.stringify(patch.planJson) : current.plan_json;
  const progressStage = patch.progressStage !== undefined ? String(patch.progressStage || '') : current.progress_stage;
  const progressPercent = patch.progressPercent !== undefined ? Number(patch.progressPercent) : current.progress_percent;
  const currentStepIndex = patch.currentStepIndex !== undefined ? Number(patch.currentStepIndex) : current.current_step_index;
  const updatedAt = patch.updatedAt !== undefined ? patch.updatedAt : current.updated_at;
  db.prepare(`
    UPDATE agent_plans
    SET status = ?, result_json = ?, executed_at = ?, plan_json = ?,
        progress_stage = ?, progress_percent = ?, current_step_index = ?, updated_at = ?
    WHERE id = ?
  `).run(status, resultJson, executedAt, planJson, progressStage, progressPercent, currentStepIndex, updatedAt, planId);
  return getAgentPlan(planId);
}

export function listAgentPlans(limit = 30) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  return db.prepare('SELECT * FROM agent_plans ORDER BY id DESC LIMIT ?').all(safeLimit);
}

export function recordAgentExecution(planId, toolName, params, status = 'pending') {
  const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  db.prepare(
    'INSERT INTO agent_executions(id, plan_id, tool_name, parameters, status) VALUES(?, ?, ?, ?, ?)'
  ).run(execId, planId, String(toolName || ''), JSON.stringify(redactValue(params || {})), String(status || 'pending'));
  db.prepare('UPDATE agent_executions SET parameters_hash = ? WHERE id = ?')
    .run(createHash('sha256').update(JSON.stringify(params || {})).digest('hex'), execId);
  return execId;
}

export function updateAgentExecution(execId, { status, result, error, durationMs, confirmedBy, confirmedAt, confirmationStatus, parametersHash } = {}) {
  const current = db.prepare('SELECT * FROM agent_executions WHERE id = ?').get(execId);
  if (!current) return null;
  const nextStatus = status !== undefined ? String(status) : current.status;
  const nextResult = result !== undefined ? JSON.stringify(redactValue(result)) : current.result;
  const nextError = error !== undefined ? redactValue(String(error)) : current.error;
  const nextDuration = durationMs !== undefined ? Number(durationMs) : current.duration_ms;
  const nextConfirmedBy = confirmedBy !== undefined ? confirmedBy : current.confirmed_by;
  const nextConfirmedAt = confirmedAt !== undefined ? confirmedAt : current.confirmed_at;
  const nextConfirmationStatus = confirmationStatus !== undefined ? String(confirmationStatus) : current.confirmation_status;
  const nextParametersHash = parametersHash !== undefined ? String(parametersHash) : current.parameters_hash;
  db.prepare(`
    UPDATE agent_executions
    SET status = ?, result = ?, error = ?, duration_ms = ?, confirmed_by = ?, confirmed_at = ?,
        confirmation_status = ?, parameters_hash = ?
    WHERE id = ?
  `).run(nextStatus, nextResult, nextError, nextDuration, nextConfirmedBy, nextConfirmedAt, nextConfirmationStatus, nextParametersHash, execId);
  return db.prepare('SELECT * FROM agent_executions WHERE id = ?').get(execId);
}

export function listAgentExecutions(planId, limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  if (planId) {
    return db.prepare('SELECT * FROM agent_executions WHERE plan_id = ? ORDER BY id ASC LIMIT ?').all(planId, safeLimit);
  }
  return db.prepare('SELECT * FROM agent_executions ORDER BY id DESC LIMIT ?').all(safeLimit);
}

/** 记录用户对某次执行计划的评分与反馈。 */
export function recordAgentFeedback(planId, rating, feedbackText = '') {
  const current = getAgentPlan(planId);
  if (!current) return null;
  const safeRating = rating == null ? null : Math.max(1, Math.min(Number(rating) || 5, 5));
  db.prepare(`
    UPDATE agent_plans
    SET rating = ?, feedback_text = ?, feedback_at = ?
    WHERE id = ?
  `).run(safeRating, String(feedbackText || '').slice(0, 2000), new Date().toISOString(), planId);
  return getAgentPlan(planId);
}

/** 带反馈的计划列表,供反馈循环 UI 使用。 */
export function listAgentFeedback(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.prepare(`
    SELECT id, user_message AS userMessage, status, rating, feedback_text AS feedbackText,
           feedback_at AS feedbackAt, created_at AS createdAt
    FROM agent_plans
    WHERE feedback_text <> '' OR rating IS NOT NULL
    ORDER BY id DESC LIMIT ?
  `).all(safeLimit);
}

export function addPerformanceBaseline(label, snapshot) {
  const result = db.prepare(
    'INSERT INTO performance_baselines(label, snapshot) VALUES(?, ?)'
  ).run(String(label || ''), JSON.stringify(snapshot || {}));
  return Number(result.lastInsertRowid);
}

export function listPerformanceBaselines(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  return db.prepare('SELECT * FROM performance_baselines ORDER BY id DESC LIMIT ?').all(safeLimit);
}

export function addAlertEvent({ key, title, detail, priority = 'warning', to = null, logs = '' }) {
  // 同一 key 的未读事件先静默,避免重复刷屏
  db.prepare('UPDATE alert_events SET muted = 1 WHERE key = ? AND read = 0 AND muted = 0').run(key);
  const result = db.prepare(`
    INSERT INTO alert_events(key, title, detail, priority, target, logs)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(key || '', String(title || ''), String(detail || ''), String(priority || 'warning'), to || null, String(logs || '').slice(0, 20000));
  return db.prepare('SELECT * FROM alert_events WHERE id = ?').get(Number(result.lastInsertRowid));
}

export function listAlertEvents(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.prepare('SELECT * FROM alert_events ORDER BY id DESC LIMIT ?').all(safeLimit);
}

export function updateAlertEvent(id, patch = {}) {
  const current = db.prepare('SELECT * FROM alert_events WHERE id = ?').get(id);
  if (!current) return null;
  const read = patch.read !== undefined ? (patch.read ? 1 : 0) : current.read;
  const muted = patch.muted !== undefined ? (patch.muted ? 1 : 0) : current.muted;
  db.prepare("UPDATE alert_events SET read = ?, muted = ?, updated_at = datetime('now') WHERE id = ?").run(read, muted, id);
  return db.prepare('SELECT * FROM alert_events WHERE id = ?').get(id);
}

export function pruneAlertEvents(days = 7) {
  const safeDays = Math.max(1, Number(days) || 7);
  return db.prepare("DELETE FROM alert_events WHERE julianday('now') - julianday(created_at) > ?").run(safeDays);
}

export function createSession(tokenHash, expiresAt) {
  db.prepare("DELETE FROM sessions WHERE julianday(expires_at) <= julianday('now')").run();
  db.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES(?, ?)').run(tokenHash, expiresAt);
}

export function hasSession(tokenHash) {
  return !!db.prepare(
    "SELECT 1 FROM sessions WHERE token_hash = ? AND julianday(expires_at) > julianday('now')"
  ).get(tokenHash);
}

export function deleteSession(tokenHash) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function clearSessions() {
  db.prepare('DELETE FROM sessions').run();
}

export function getProjectPreference(projectId) {
  return db.prepare(
    'SELECT managed, favorite, note FROM project_preferences WHERE project_id = ?'
  ).get(projectId) || { managed: 0, favorite: 0, note: '' };
}

export function getProjectMountEnabled(projectId) {
  return !!db.prepare('SELECT mount_enabled FROM project_preferences WHERE project_id = ?').get(projectId)?.mount_enabled;
}

export function setProjectPreference(projectId, { managed, mountEnabled, favorite, note }) {
  const current = getProjectPreference(projectId);
  const currentMountEnabled = getProjectMountEnabled(projectId);
  const nextManaged = typeof managed === 'boolean' ? Number(managed) : current.managed;
  const nextMountEnabled = typeof mountEnabled === 'boolean' ? Number(mountEnabled) : Number(currentMountEnabled);
  const nextFavorite = typeof favorite === 'boolean' ? Number(favorite) : current.favorite;
  const nextNote = typeof note === 'string' ? note.slice(0, 500) : current.note;
  db.prepare(`
    INSERT INTO project_preferences(project_id, managed, mount_enabled, favorite, note, updated_at)
    VALUES(?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET
      managed = excluded.managed,
      mount_enabled = excluded.mount_enabled,
      favorite = excluded.favorite,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(projectId, nextManaged, nextMountEnabled, nextFavorite, nextNote);
  return { managed: !!nextManaged, favorite: !!nextFavorite, note: nextNote };
}

export function setProjectManagement(discoveredProjectIds, managedProjectIds, mountProjectIds = null) {
  const managedSet = new Set(managedProjectIds);
  const mountSet = new Set(mountProjectIds || []);
  const update = db.transaction(() => {
    // 保存的是完整允许列表；先撤销旧授权，避免暂时消失的项目日后自动恢复权限。
    db.prepare("UPDATE project_preferences SET managed = 0, mount_enabled = 0, updated_at = datetime('now') WHERE managed <> 0 OR mount_enabled <> 0").run();
    for (const projectId of discoveredProjectIds.filter((id) => managedSet.has(id))) {
      setProjectPreference(projectId, { managed: true, mountEnabled: mountSet.has(projectId) });
    }
  });
  update();
  return {
    managedProjectIds: discoveredProjectIds.filter((id) => managedSet.has(id)),
    mountProjectIds: discoveredProjectIds.filter((id) => managedSet.has(id) && mountSet.has(id)),
  };
}

export function setProjectMounts(discoveredProjectIds, managedProjectIds, mountProjectIds) {
  return setProjectManagement(discoveredProjectIds, managedProjectIds, mountProjectIds);
}

/** Compose 备份每项目保留份数:maintenance.pruneComposeBackups 与这里共用同一常量,防止两处漂移。 */
export const COMPOSE_BACKUP_KEEP = 20;

export function addComposeBackup(projectId, filePath, content, reason = 'save') {
  const result = db.prepare(
    'INSERT INTO compose_backups(project_id, file_path, content, reason) VALUES(?, ?, ?, ?)'
  ).run(projectId, filePath, content, reason);
  db.prepare(`
    DELETE FROM compose_backups
    WHERE project_id = ? AND id NOT IN (
      SELECT id FROM compose_backups WHERE project_id = ? ORDER BY id DESC LIMIT ${COMPOSE_BACKUP_KEEP}
    )
  `).run(projectId, projectId);
  return Number(result.lastInsertRowid);
}

export function listComposeBackups(projectId) {
  return db.prepare(`
    SELECT id, project_id AS projectId, file_path AS filePath, reason, created_at AS createdAt,
           length(content) AS size
    FROM compose_backups WHERE project_id = ? ORDER BY id DESC LIMIT ${COMPOSE_BACKUP_KEEP}
  `).all(projectId);
}

export function getComposeBackup(projectId, id) {
  return db.prepare(`
    SELECT id, project_id AS projectId, file_path AS filePath, content, reason,
           created_at AS createdAt
    FROM compose_backups WHERE project_id = ? AND id = ?
  `).get(projectId, id);
}

export function addOperation({ projectId = null, projectName = null, action, status, detail = '' }) {
  const result = db.prepare(`
    INSERT INTO operation_history(project_id, project_name, action, status, detail)
    VALUES(?, ?, ?, ?, ?)
  `).run(projectId, projectName, action, status, String(detail || '').slice(-20000));
  return Number(result.lastInsertRowid);
}

export function pruneOperationHistory(days = 30) {
  const safeDays = Math.max(1, Math.min(Math.floor(Number(days) || 30), 3650));
  return db.prepare(
    "DELETE FROM operation_history WHERE julianday('now') - julianday(created_at) > ?"
  ).run(safeDays);
}

/** 归档/清理过期告警事件:优先保留未读/未静音(详见 events.js)。 */
export function pruneAgentPlans(days = 30) {
  const safeDays = Math.max(1, Math.min(Math.floor(Number(days) || 30), 3650));
  return db.prepare(
    "DELETE FROM agent_plans WHERE julianday('now') - julianday(created_at) > ?"
  ).run(safeDays);
}

export function listOperations(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return db.prepare(`
    SELECT id, project_id AS projectId, project_name AS projectName, action, status, detail,
           created_at AS createdAt
    FROM operation_history ORDER BY id DESC LIMIT ?
  `).all(safeLimit);
}

export function listProjectOperations(projectId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  return db.prepare(`
    SELECT id, project_id AS projectId, project_name AS projectName, action, status, detail,
           created_at AS createdAt
    FROM operation_history WHERE project_id = ? ORDER BY id DESC LIMIT ?
  `).all(projectId, safeLimit);
}

export function createBackgroundJob({ id, type, action, projects }) {
  const insert = db.transaction(() => {
    db.prepare('INSERT INTO background_jobs(id, type, action, status, total) VALUES(?, ?, ?, ?, ?)')
      .run(id, type, action, 'queued', projects.length);
    const statement = db.prepare('INSERT INTO background_job_items(job_id, project_id, project_name, status) VALUES(?, ?, ?, ?)');
    for (const project of projects) statement.run(id, project.id, project.projectName, 'pending');
  });
  insert();
  return getBackgroundJob(id);
}

export function updateBackgroundJob(id, status, completed = null) {
  const timestamps = status === 'running'
    ? "started_at = COALESCE(started_at, datetime('now'))"
    : ['success', 'failed', 'interrupted'].includes(status) ? "finished_at = datetime('now')" : 'finished_at = finished_at';
  db.prepare(`UPDATE background_jobs SET status = ?, completed = COALESCE(?, completed), ${timestamps} WHERE id = ?`)
    .run(status, completed, id);
}

export function updateBackgroundJobItem(id, { status, output = '', exitCode = null }) {
  const timestamps = status === 'running'
    ? "started_at = COALESCE(started_at, datetime('now'))"
    : ['success', 'failed', 'interrupted'].includes(status) ? "finished_at = datetime('now')" : 'finished_at = finished_at';
  db.prepare(`UPDATE background_job_items SET status = ?, output = ?, exit_code = ?, ${timestamps} WHERE id = ?`)
    .run(status, String(output || '').slice(-20000), exitCode, id);
}

export function getBackgroundJob(id) {
  const job = db.prepare(`
    SELECT id, type, action, status, total, completed, created_at AS createdAt,
           started_at AS startedAt, finished_at AS finishedAt
    FROM background_jobs WHERE id = ?
  `).get(id);
  if (!job) return null;
  job.items = db.prepare(`
    SELECT id, project_id AS projectId, project_name AS projectName, status, output,
           exit_code AS exitCode, started_at AS startedAt, finished_at AS finishedAt
    FROM background_job_items WHERE job_id = ? ORDER BY id
  `).all(id);
  return job;
}

export function listBackgroundJobs(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  return db.prepare(`
    SELECT id, type, action, status, total, completed, created_at AS createdAt,
           started_at AS startedAt, finished_at AS finishedAt
    FROM background_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(safeLimit);
}

export function interruptRunningBackgroundJobs() {
  const jobs = db.prepare("SELECT id FROM background_jobs WHERE status IN ('queued', 'running')").all();
  const interrupt = db.transaction(() => {
    db.prepare("UPDATE background_job_items SET status = 'interrupted', finished_at = datetime('now') WHERE status IN ('pending', 'running')").run();
    db.prepare("UPDATE background_jobs SET status = 'interrupted', finished_at = datetime('now') WHERE status IN ('queued', 'running')").run();
  });
  interrupt();
  return jobs.map((job) => job.id);
}

export function exportUserData() {
  // docker.hosts 必须整键排除(而非脱敏后导出):SSH 密码/私钥/TLS 证书是明文落库的,
  // 脱敏导出再导入会把无凭据条目回灌覆盖真实凭据;导入侧 allowlist 本就不含该键。
  const settings = Object.fromEntries(
    db.prepare("SELECT key, value FROM settings WHERE key NOT IN ('ai.api_key', 'auth.password_hash', 'notifications.config', 'docker.hosts')").all()
      .map((row) => [row.key, row.value])
  );
  return {
    exportedAt: new Date().toISOString(),
    settings,
    projectPreferences: db.prepare(
      'SELECT project_id AS projectId, managed, mount_enabled AS mountEnabled, favorite, note, updated_at AS updatedAt FROM project_preferences'
    ).all(),
    operations: listOperations(500),
  };
}

export function importUserData(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('导入文件格式无效');
  const allowedSettings = new Set([
    'ai.base_url', 'ai.model', 'ai.system_prompt', 'ui.refresh_interval', 'ui.log_tail',
    'updates.auto_enabled', 'updates.interval_hours',
  ]);
  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(payload.settings || {})) {
      if (allowedSettings.has(key) && typeof value === 'string') setSetting(key, value);
    }
    for (const preference of payload.projectPreferences || []) {
      if (typeof preference?.projectId !== 'string') continue;
      setProjectPreference(preference.projectId, {
        managed: !!preference.managed,
        mountEnabled: !!preference.mountEnabled,
        favorite: !!preference.favorite,
        note: typeof preference.note === 'string' ? preference.note : '',
      });
    }
  });
  transaction();
  return { ok: true };
}

// ===== 数据卷备份 =====

const VOLUME_BACKUP_KEEP = 20; // 每个卷最多保留的备份份数,与 compose 备份策略一致

export function addVolumeBackup({ projectId, projectName, volume, file, bytes = 0, host = 'local' }) {
  const result = db.prepare(
    'INSERT INTO volume_backups(project_id, project_name, volume, file, bytes, host) VALUES(?, ?, ?, ?, ?, ?)'
  ).run(projectId, projectName, volume, file, Number(bytes) || 0, host);
  // 超限清理由服务层负责(pruneVolumeBackups 只查询,删文件与删行必须同处执行)
  return Number(result.lastInsertRowid);
}

export function listVolumeBackups(projectId = '') {
  const rows = projectId
    ? db.prepare('SELECT * FROM volume_backups WHERE project_id = ? ORDER BY id DESC LIMIT 200').all(projectId)
    : db.prepare('SELECT * FROM volume_backups ORDER BY id DESC LIMIT 500').all();
  return rows.map((row) => ({
    id: Number(row.id),
    projectId: row.project_id,
    projectName: row.project_name,
    volume: row.volume,
    file: row.file,
    bytes: Number(row.bytes) || 0,
    host: row.host,
    createdAt: row.created_at,
  }));
}

export function getVolumeBackup(id) {
  const row = db.prepare('SELECT * FROM volume_backups WHERE id = ?').get(Number(id));
  return row ? { id: Number(row.id), projectId: row.project_id, projectName: row.project_name, volume: row.volume, file: row.file, bytes: Number(row.bytes) || 0, host: row.host, createdAt: row.created_at } : null;
}

export function deleteVolumeBackupRow(id) {
  return db.prepare('DELETE FROM volume_backups WHERE id = ?').run(Number(id)).changes > 0;
}

/** 同一宿主的(project, volume)只保留最近 N 份,返回被清理的记录(调用方负责删文件)。 */
export function pruneVolumeBackups(projectId, volume, keepOrOptions = VOLUME_BACKUP_KEEP, host = null) {
  const options = keepOrOptions && typeof keepOrOptions === 'object' ? keepOrOptions : {};
  const keep = Number.isInteger(options.keep) && options.keep >= 0
    ? options.keep
    : (Number.isInteger(keepOrOptions) && keepOrOptions >= 0 ? keepOrOptions : VOLUME_BACKUP_KEEP);
  const scopedHost = options.host ?? host;
  const hostClause = scopedHost ? ' AND host = ?' : '';
  const params = scopedHost
    ? [projectId, volume, scopedHost, projectId, volume, scopedHost, keep]
    : [projectId, volume, projectId, volume, keep];
  return db.prepare(`
    SELECT * FROM volume_backups
    WHERE project_id = ? AND volume = ?${hostClause} AND id NOT IN (
      SELECT id FROM volume_backups WHERE project_id = ? AND volume = ?${hostClause} ORDER BY id DESC LIMIT ?
    )
  `).all(...params).map((row) => ({ id: Number(row.id), file: row.file, host: row.host || 'local' }));
}

// ===== 巡检报告 =====

const INSPECTION_KEEP = 120; // 报告留最近 120 次,容量预测最多回看 30 天,足够

/** 落一条巡检报告,返回行 id。 */
export function addInspection({ source = 'manual', score = 100, grade = 'healthy', findings = [], predictions = [], summary = '', stats = {}, diskUsed = null, diskTotal = null, durationMs = null }) {
  const result = db.prepare(`
    INSERT INTO inspections(source, score, grade, findings_json, predictions_json, summary, stats_json, disk_used, disk_total, duration_ms)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(source || 'manual'),
    Math.max(0, Math.min(Number(score) || 0, 100)),
    String(grade || 'healthy'),
    JSON.stringify(findings || []),
    JSON.stringify(predictions || []),
    String(summary || '').slice(0, 4000),
    JSON.stringify(stats || {}),
    diskUsed == null ? null : Math.round(Number(diskUsed) || 0),
    diskTotal == null ? null : Math.round(Number(diskTotal) || 0),
    durationMs == null ? null : Math.round(Number(durationMs) || 0)
  );
  const id = Number(result.lastInsertRowid);
  // 超限裁剪:同一张表既存报告又存预测样本,不能无限增长。
  db.prepare(`
    DELETE FROM inspections WHERE id NOT IN (SELECT id FROM inspections ORDER BY id DESC LIMIT ?)
  `).run(INSPECTION_KEEP);
  return id;
}

/** 读取一条巡检报告(含解析后的 findings/predictions)。 */
export function getInspection(id) {
  const row = db.prepare('SELECT * FROM inspections WHERE id = ?').get(Number(id));
  return row ? mapInspectionRow(row) : null;
}

/** 列出巡检报告,仅返回摘要所需的字段(不含 findings 明细,避免列表接口过重)。 */
export function listInspections(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  return db.prepare('SELECT * FROM inspections ORDER BY id DESC LIMIT ?').all(safeLimit).map(mapInspectionRow);
}

/** 供容量预测使用的磁盘采样点(按时间正序)。 */
export function listDiskSamples(days = 30) {
  const safeDays = Math.max(1, Math.min(Number(days) || 30, 365));
  const cutoff = new Date(Date.now() - safeDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  return db.prepare(`
    SELECT created_at AS createdAt, disk_used AS diskUsed, disk_total AS diskTotal
    FROM inspections
    WHERE created_at >= ? AND disk_used IS NOT NULL AND disk_total IS NOT NULL
    ORDER BY id ASC
  `).all(cutoff).map((row) => ({ createdAt: row.createdAt, diskUsed: Number(row.diskUsed) || 0, diskTotal: Number(row.diskTotal) || 0 }));
}

/** 清理超过保留期的巡检报告,返回删除行数。 */
export function pruneInspections(days = 180) {
  const safeDays = Math.max(7, Number(days) || 180);
  return db.prepare("DELETE FROM inspections WHERE julianday('now') - julianday(created_at) > ?").run(safeDays);
}

function mapInspectionRow(row) {
  const parse = (value, fallback) => {
    try { const parsed = JSON.parse(value); return parsed ?? fallback; } catch { return fallback; }
  };
  return {
    id: Number(row.id),
    source: row.source,
    score: Number(row.score) || 0,
    grade: row.grade,
    findings: parse(row.findings_json, []),
    predictions: parse(row.predictions_json, []),
    summary: row.summary,
    stats: parse(row.stats_json, {}),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: row.created_at,
  };
}

// ===== 统一资产模型(CMDB) =====

export function upsertAsset({ id, kind, name, displayName = '', hostId = 'local', status = 'unknown', properties = {}, tags = [], owner = '', environment = '', source = 'manual' }) {
  const assetId = id || `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO assets(id, kind, name, display_name, host_id, status, properties, tags, owner, environment, source, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      name = excluded.name,
      display_name = excluded.display_name,
      host_id = excluded.host_id,
      status = excluded.status,
      properties = excluded.properties,
      tags = excluded.tags,
      owner = excluded.owner,
      environment = excluded.environment,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(
    assetId,
    String(kind || 'service'),
    String(name || ''),
    String(displayName || ''),
    String(hostId || 'local'),
    String(status || 'unknown'),
    JSON.stringify(properties || {}),
    JSON.stringify(tags || []),
    String(owner || ''),
    String(environment || ''),
    String(source || 'manual')
  );
  return getAsset(assetId);
}

export function getAsset(id) {
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  return row ? mapAssetRow(row) : null;
}

export function listAssets({ kind = '', hostId = '', query = '', limit = 500, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (kind) { conditions.push('kind = ?'); params.push(kind); }
  if (hostId) { conditions.push('host_id = ?'); params.push(hostId); }
  if (query) { conditions.push('(name LIKE ? OR display_name LIKE ? OR owner LIKE ?)'); const like = `%${query}%`; params.push(like, like, like); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 500));
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, 100000));
  const rows = db.prepare(`SELECT * FROM assets ${where} ORDER BY kind, name LIMIT ? OFFSET ?`).all(...params, safeLimit, safeOffset);
  return rows.map(mapAssetRow);
}

export function deleteAsset(id) {
  return db.prepare('DELETE FROM assets WHERE id = ?').run(id).changes > 0;
}

export function addAssetRelation(sourceId, targetId, relation, properties = {}) {
  db.prepare(`
    INSERT INTO asset_relations(source_id, target_id, relation, properties)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(source_id, target_id, relation) DO UPDATE SET properties = excluded.properties
  `).run(sourceId, targetId, String(relation || 'depends_on'), JSON.stringify(properties || {}));
  return true;
}

export function listAssetRelations({ limit = 500, offset = 0, assetIds = null } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 500));
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, 100000));
  const params = [];
  let filter = '';
  if (Array.isArray(assetIds) && assetIds.length) {
    const placeholders = assetIds.map(() => '?').join(',');
    filter = `WHERE r.source_id IN (${placeholders}) AND r.target_id IN (${placeholders})`;
    params.push(...assetIds, ...assetIds);
  }
  return db.prepare(`
    SELECT r.id, r.source_id AS sourceId, r.target_id AS targetId, r.relation, r.properties, r.created_at AS createdAt,
           s.name AS sourceName, s.kind AS sourceKind, t.name AS targetName, t.kind AS targetKind
    FROM asset_relations r
    JOIN assets s ON s.id = r.source_id
    JOIN assets t ON t.id = r.target_id
    ${filter}
    ORDER BY r.id LIMIT ? OFFSET ?
  `).all(...params, safeLimit, safeOffset).map((row) => ({ ...row, properties: safeParse(row.properties, {}) }));
}

export function deleteAssetRelation(id) {
  return db.prepare('DELETE FROM asset_relations WHERE id = ?').run(Number(id)).changes > 0;
}

function mapAssetRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    displayName: row.display_name,
    hostId: row.host_id,
    status: row.status,
    properties: safeParse(row.properties, {}),
    tags: safeParse(row.tags, []),
    owner: row.owner,
    environment: row.environment,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ===== 统一事件中心 =====

export function addEventRecord({ eventType = 'alert', source = 'system', title, detail = '', severity = 'info', status = 'open', assetId = null, assetName = '', payload = {} }) {
  const result = db.prepare(`
    INSERT INTO event_records(event_type, source, title, detail, severity, status, asset_id, asset_name, payload)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(eventType || 'alert'),
    String(source || 'system'),
    String(title || ''),
    String(detail || ''),
    String(severity || 'info'),
    String(status || 'open'),
    assetId || null,
    String(assetName || ''),
    JSON.stringify(payload || {})
  );
  return getEventRecord(Number(result.lastInsertRowid));
}

export function getEventRecord(id) {
  const row = db.prepare('SELECT * FROM event_records WHERE id = ?').get(Number(id));
  return row ? mapEventRecordRow(row) : null;
}

export function listEventRecords({ eventType = '', severity = '', status = '', limit = 100 } = {}) {
  const conditions = [];
  const params = [];
  if (eventType) { conditions.push('event_type = ?'); params.push(eventType); }
  if (severity) { conditions.push('severity = ?'); params.push(severity); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const rows = db.prepare(`SELECT * FROM event_records ${where} ORDER BY id DESC LIMIT ?`).all(...params, safeLimit);
  return rows.map(mapEventRecordRow);
}

export function updateEventRecord(id, patch = {}) {
  const current = db.prepare('SELECT * FROM event_records WHERE id = ?').get(Number(id));
  if (!current) return null;
  const status = patch.status !== undefined ? String(patch.status) : current.status;
  const read = patch.read !== undefined ? (patch.read ? 1 : 0) : current.read;
  db.prepare("UPDATE event_records SET status = ?, read = ?, updated_at = datetime('now') WHERE id = ?").run(status, read, Number(id));
  return getEventRecord(Number(id));
}

export function pruneEventRecords(days = 30) {
  const safeDays = Math.max(1, Number(days) || 30);
  return db.prepare("DELETE FROM event_records WHERE julianday('now') - julianday(created_at) > ?").run(safeDays);
}

function mapEventRecordRow(row) {
  return {
    id: Number(row.id),
    eventType: row.event_type,
    source: row.source,
    title: row.title,
    detail: row.detail,
    severity: row.severity,
    status: row.status,
    assetId: row.asset_id,
    assetName: row.asset_name,
    payload: safeParse(row.payload, {}),
    read: Number(row.read) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ===== 工作流引擎 =====

export function createWorkflowDefinition({ id, name, description = '', triggerType = 'manual', triggerConfig = {}, nodes = [], enabled = 1 }) {
  const defId = id || `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO workflow_definitions(id, name, description, trigger_type, trigger_config, nodes, enabled)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(
    defId,
    String(name || ''),
    String(description || ''),
    String(triggerType || 'manual'),
    JSON.stringify(triggerConfig || {}),
    JSON.stringify(nodes || []),
    enabled ? 1 : 0
  );
  return getWorkflowDefinition(defId);
}

export function getWorkflowDefinition(id) {
  const row = db.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id);
  return row ? mapWorkflowDefinitionRow(row) : null;
}

export function listWorkflowDefinitions() {
  return db.prepare('SELECT * FROM workflow_definitions ORDER BY created_at DESC').all().map(mapWorkflowDefinitionRow);
}

export function updateWorkflowDefinition(id, patch = {}) {
  const current = getWorkflowDefinition(id);
  if (!current) return null;
  const name = patch.name !== undefined ? String(patch.name) : current.name;
  const description = patch.description !== undefined ? String(patch.description) : current.description;
  const triggerType = patch.triggerType !== undefined ? String(patch.triggerType) : current.triggerType;
  const triggerConfig = patch.triggerConfig !== undefined ? JSON.stringify(patch.triggerConfig) : JSON.stringify(current.triggerConfig);
  const nodes = patch.nodes !== undefined ? JSON.stringify(patch.nodes) : JSON.stringify(current.nodes);
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
  db.prepare(`
    UPDATE workflow_definitions SET name = ?, description = ?, trigger_type = ?, trigger_config = ?, nodes = ?, enabled = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, description, triggerType, triggerConfig, nodes, enabled, id);
  return getWorkflowDefinition(id);
}

export function deleteWorkflowDefinition(id) {
  return db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run(id).changes > 0;
}

export function createWorkflowInstance({ id, definitionId, name = '', status = 'pending', context = {} }) {
  const instanceId = id || `wfi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO workflow_instances(id, definition_id, name, status, context)
    VALUES(?, ?, ?, ?, ?)
  `).run(instanceId, definitionId, String(name || ''), String(status || 'pending'), JSON.stringify(context || {}));
  return getWorkflowInstance(instanceId);
}

export function getWorkflowInstance(id) {
  const row = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(id);
  if (!row) return null;
  const instance = mapWorkflowInstanceRow(row);
  instance.steps = db.prepare('SELECT * FROM workflow_steps WHERE instance_id = ? ORDER BY id').all(id).map(mapWorkflowStepRow);
  return instance;
}

export function listWorkflowInstances({ status = '', limit = 50 } = {}) {
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const rows = db.prepare(`SELECT * FROM workflow_instances ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, safeLimit);
  return rows.map(mapWorkflowInstanceRow);
}

export function updateWorkflowInstance(id, patch = {}) {
  const current = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(id);
  if (!current) return null;
  const status = patch.status !== undefined ? String(patch.status) : current.status;
  const currentNode = patch.currentNode !== undefined ? String(patch.currentNode) : current.current_node;
  const context = patch.context !== undefined ? JSON.stringify(patch.context) : current.context;
  const result = patch.result !== undefined ? JSON.stringify(patch.result) : current.result;
  const startedAt = patch.startedAt !== undefined ? patch.startedAt : current.started_at;
  const finishedAt = patch.finishedAt !== undefined ? patch.finishedAt : current.finished_at;
  db.prepare(`
    UPDATE workflow_instances SET status = ?, current_node = ?, context = ?, result = ?, started_at = ?, finished_at = ?
    WHERE id = ?
  `).run(status, currentNode, context, result, startedAt, finishedAt, id);
  return getWorkflowInstance(id);
}

/** 仅当实例仍处于指定状态时更新，避免取消与执行完成互相覆盖。 */
export function updateWorkflowInstanceIfStatus(id, expectedStatuses, patch = {}) {
  const current = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(id);
  if (!current) return null;
  const expected = Array.isArray(expectedStatuses) ? expectedStatuses.map(String) : [String(expectedStatuses)];
  if (!expected.includes(String(current.status))) return null;
  const status = patch.status !== undefined ? String(patch.status) : current.status;
  const currentNode = patch.currentNode !== undefined ? String(patch.currentNode) : current.current_node;
  const context = patch.context !== undefined ? JSON.stringify(patch.context) : current.context;
  const result = patch.result !== undefined ? JSON.stringify(patch.result) : current.result;
  const startedAt = patch.startedAt !== undefined ? patch.startedAt : current.started_at;
  const finishedAt = patch.finishedAt !== undefined ? patch.finishedAt : current.finished_at;
  const placeholders = expected.map(() => '?').join(',');
  const changed = db.prepare(`
    UPDATE workflow_instances SET status = ?, current_node = ?, context = ?, result = ?, started_at = ?, finished_at = ?
    WHERE id = ? AND status IN (${placeholders})
  `).run(status, currentNode, context, result, startedAt, finishedAt, id, ...expected).changes;
  return changed ? getWorkflowInstance(id) : null;
}

export function addWorkflowStep({ instanceId, nodeId = '', nodeType = '', status = 'pending', input = {}, output = {}, error = '' }) {
  const result = db.prepare(`
    INSERT INTO workflow_steps(instance_id, node_id, node_type, status, input, output, error)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(instanceId, String(nodeId || ''), String(nodeType || ''), String(status || 'pending'), JSON.stringify(input || {}), JSON.stringify(output || {}), String(error || ''));
  return Number(result.lastInsertRowid);
}

export function updateWorkflowStep(id, patch = {}) {
  const current = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(Number(id));
  if (!current) return null;
  const status = patch.status !== undefined ? String(patch.status) : current.status;
  const output = patch.output !== undefined ? JSON.stringify(patch.output) : current.output;
  const error = patch.error !== undefined ? String(patch.error) : current.error;
  const startedAt = patch.startedAt !== undefined ? patch.startedAt : current.started_at;
  const finishedAt = patch.finishedAt !== undefined ? patch.finishedAt : current.finished_at;
  db.prepare(`
    UPDATE workflow_steps SET status = ?, output = ?, error = ?, started_at = ?, finished_at = ?
    WHERE id = ?
  `).run(status, output, error, startedAt, finishedAt, Number(id));
  return db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(Number(id));
}

function mapWorkflowDefinitionRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type,
    triggerConfig: safeParse(row.trigger_config, {}),
    nodes: safeParse(row.nodes, []),
    enabled: Number(row.enabled) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkflowInstanceRow(row) {
  return {
    id: row.id,
    definitionId: row.definition_id,
    name: row.name,
    status: row.status,
    currentNode: row.current_node,
    context: safeParse(row.context, {}),
    result: safeParse(row.result, {}),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapWorkflowStepRow(row) {
  return {
    id: Number(row.id),
    instanceId: row.instance_id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    status: row.status,
    input: safeParse(row.input, {}),
    output: safeParse(row.output, {}),
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function safeParse(value, fallback) {
  try { const parsed = JSON.parse(value); return parsed ?? fallback; } catch { return fallback; }
}

// ===== 会话/Agent 审计数据保留策略 =====

/** 清理超过保留期的 AI 会话消息与 Agent 审计数据,返回各表删除行数。 */
export function pruneAiData(retentionDays = 90) {
  const days = Math.max(7, Math.min(Number(retentionDays) || 90, 3650));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const tx = db.transaction(() => {
    const plans = db.prepare(`
      DELETE FROM agent_executions WHERE plan_id IN (SELECT id FROM agent_plans WHERE created_at < ?)
    `).run(cutoff);
    // 反馈(rating/feedback_text)是 agent_plans 的列,随计划一并删除,无独立表
    const oldPlans = db.prepare('DELETE FROM agent_plans WHERE created_at < ?').run(cutoff);
    const history = db.prepare('DELETE FROM ai_history WHERE created_at < ?').run(cutoff);
    return { plans: oldPlans.changes, executions: plans.changes, history: history.changes };
  });
  return tx();
}

export default db;
