import { DatabaseSync } from 'node:sqlite';

function sanitizeParam(val) {
  if (val === undefined) return null;
  return val;
}

function sanitizeParams(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const obj = {};
    for (const [k, v] of Object.entries(params[0])) {
      obj[k] = sanitizeParam(v);
    }
    return [obj];
  }
  return params.map(sanitizeParam);
}

class StatementWrapper {
  constructor(stmt) {
    this._stmt = stmt;
  }

  run(...params) {
    const cleaned = sanitizeParams(params);
    const result = this._stmt.run(...cleaned);
    return {
      changes: result.changes ?? 0,
      lastInsertRowid: result.lastInsertRowid ?? 0,
    };
  }

  get(...params) {
    const cleaned = sanitizeParams(params);
    const result = this._stmt.get(...cleaned);
    // node:sqlite 返回 null-prototype 对象,better-sqlite3 返回普通对象;
    // 展开一层,保证 deepStrictEqual / JSON 序列化行为与迁移前一致。
    return result ? { ...result } : undefined;
  }

  all(...params) {
    const cleaned = sanitizeParams(params);
    return this._stmt.all(...cleaned).map((row) => ({ ...row }));
  }

  *iterate(...params) {
    const cleaned = sanitizeParams(params);
    for (const row of this._stmt.iterate(...cleaned)) {
      yield { ...row };
    }
  }
}

export default class Database {
  constructor(location, options = {}) {
    this._db = new DatabaseSync(location, {
      readOnly: options.readonly ?? false,
      // better-sqlite3 默认关闭外键约束,保持行为兼容,避免既有写入路径被 FK 拦下。
      enableForeignKeyConstraints: false,
    });
  }

  prepare(sql) {
    const stmt = this._db.prepare(sql);
    return new StatementWrapper(stmt);
  }

  exec(sql) {
    return this._db.exec(sql);
  }

  pragma(pragmaStr, options = {}) {
    const trimmed = pragmaStr.trim();
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed};`);
      return [];
    }
    const rows = this._db.prepare(`PRAGMA ${trimmed};`).all();
    if (options.simple) {
      if (!rows.length) return undefined;
      const firstRow = rows[0];
      const keys = Object.keys(firstRow);
      return keys.length ? firstRow[keys[0]] : undefined;
    }
    return rows;
  }

  transaction(fn) {
    return (...args) => {
      this._db.exec('BEGIN');
      try {
        const res = fn(...args);
        this._db.exec('COMMIT');
        return res;
      } catch (err) {
        try {
          this._db.exec('ROLLBACK');
        } catch (_) { /* 事务已失效时回滚本身也会失败,吞掉后向上抛原错误 */ }
        throw err;
      }
    };
  }

  /**
   * 导出一致性快照(node:sqlite 在 Node 22 上没有 backup API,用 VACUUM INTO)。
   * 注意:目标文件必须不存在,且本连接不能是 readOnly(SQLite 拒绝只读源)。
   */
  vacuumInto(destinationPath) {
    const target = String(destinationPath).replace(/'/g, "''");
    this._db.exec(`VACUUM INTO '${target}'`);
  }

  close() {
    return this._db.close();
  }
}
