// 测试库隔离:必须在任何 src/* 之前 import。
// src/lib/db.js 在模块顶层就读 process.env.DB_PATH 并打开库,晚一步赋值无效;
// ESM 按 import 声明顺序求值,所以把它放在每个测试文件的第一行。
// 不隔离时,并发跑的测试进程共用 data/opsdash.db,会撞写锁(database is locked)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-test-db-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.on('exit', () => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 临时目录由系统回收 */ } });
