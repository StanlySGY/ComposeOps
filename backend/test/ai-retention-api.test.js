import './helpers/isolated-db.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import personalRoutes from '../src/routes/personal.js';
import db, { setSetting } from '../src/lib/db.js';

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
