#!/usr/bin/env node
/** Offline/read-only size attribution, safe for an isolated restored database. Never prints row content. */
import Database from '../src/lib/sqlite.js';
import { statSync } from 'node:fs';
const file = process.argv[2];
if (!file) throw new Error('Usage: DB_ENCRYPTION_KEY_FILE=/outside/key node backend/scripts/database-footprint.js /outside/restored.db');
const database = new Database(file, { readonly: true, fileMustExist: true });
try {
 const pageSize = database.pragma('page_size', { simple: true }), pageCount = database.pragma('page_count', { simple: true }), free = database.pragma('freelist_count', { simple: true });
 const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
 let sizes = [], attribution = 'exact-pages';
 try { sizes = database.prepare('SELECT name,SUM(pgsize) AS bytes,COUNT(*) AS pages FROM dbstat GROUP BY name ORDER BY bytes DESC').all(); }
 catch { attribution = 'row-counts-only-dbstat-unavailable'; }
 const counts = tables.map(({name})=>({name, rows: database.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n}));
 console.log(JSON.stringify({ readonly:true, bytes:statSync(file).size, allocatedBytes:pageSize*pageCount, reusableBytes:pageSize*free, attribution, objects:sizes, tables:counts },null,2));
} finally { database.close(); }
