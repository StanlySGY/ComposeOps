import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import personalRoutes from '../src/routes/personal.js';
import db, { getSetting, setSetting } from '../src/lib/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('AI retention API previews without deleting, saves one policy and rejects stale confirmation', async () => {
  const app = Fastify(); await app.register(personalRoutes);
  setSetting('retention.ai_days', '90');
  db.exec("DELETE FROM ai_history; INSERT INTO ai_history(role,content,created_at) VALUES('user','retain',datetime('now','-45 days'))");
  try {
    let result = await app.inject('/maintenance/ai-retention');
    assert.equal(result.json().days, 90); assert.equal(result.json().counts.history, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_history').get().n, 1);
    assert.equal((await app.inject({ method: 'PUT', url: '/maintenance/ai-retention', payload: { days: 0 } })).statusCode, 400);
    result = await app.inject({ method: 'PUT', url: '/maintenance/ai-retention', payload: { days: 30 } });
    assert.equal(result.statusCode, 200); assert.equal(result.json().counts.history, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/maintenance/ai-retention/prune', payload: { days: 90 } })).statusCode, 409);
    result = await app.inject({ method: 'POST', url: '/maintenance/ai-retention/prune', payload: { days: 30 } });
    assert.equal(result.statusCode, 200); assert.equal(result.json().lastResult.counts.history, 1);
    assert.equal(result.json().counts.history, 0);
  } finally { setSetting('retention.ai_days', '90'); await app.close(); }
});

test('archive API rejects missing keys before enabling and permits pausing invalid configuration', async () => {
 const app=Fastify();await app.register(personalRoutes);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-api-'));
 const original=Object.fromEntries(['AGENT_ARCHIVE_DIR','DB_ENCRYPTION_KEY','DB_ENCRYPTION_KEY_FILE'].map(key=>[key,process.env[key]]));
 process.env.AGENT_ARCHIVE_DIR=root;delete process.env.DB_ENCRYPTION_KEY;delete process.env.DB_ENCRYPTION_KEY_FILE;
 setSetting('retention.run_archive_enabled','0');
 try {
  let result=await app.inject('/maintenance/data-lifecycle');assert.equal(result.statusCode,200);assert.equal(result.json().archiveStorage.ready,false);
  result=await app.inject({method:'PUT',url:'/maintenance/data-lifecycle',payload:{enabled:true}});
  assert.equal(result.statusCode,400);assert.equal(getSetting('retention.run_archive_enabled'),'0');
  // Mimic a previously enabled deployment whose external key has become unavailable.
  setSetting('retention.run_archive_enabled','1');
  result=await app.inject({method:'PUT',url:'/maintenance/data-lifecycle',payload:{enabled:false}});
  assert.equal(result.statusCode,200);assert.equal(result.json().archiveEnabled,false);
 } finally {
  for(const [key,value] of Object.entries(original)) {if(value===undefined) delete process.env[key];else process.env[key]=value;}
  fs.rmSync(root,{recursive:true,force:true});await app.close();
 }
});
