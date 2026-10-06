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
    return result || undefined;
  }

  all(...params) {
    const cleaned = sanitizeParams(params);
    return this._stmt.all(...cleaned);
  }

  iterate(...params) {
    const cleaned = sanitizeParams(params);
    return this._stmt.iterate(...cleaned);
  }
}

export default class Database {
  constructor(location, options = {}) {
    this._db = new DatabaseSync(location, {
      readOnly: options.readonly ?? false,
      enableForeignKeyConstraints: true,
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
        } catch (_) {}
        throw err;
      }
    };
  }

  async backup(destinationPath) {
    // node:sqlite backup support if available
    try {
      const sqlite = await import('node:sqlite');
      if (typeof sqlite.backup === 'function') {
        await sqlite.backup(this._db, destinationPath);
        return;
      }
    } catch (_) {}
  }

  close() {
    return this._db.close();
  }
}
