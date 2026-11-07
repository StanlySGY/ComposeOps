import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'composeops-review-integration-'));
const projectName = `co-review-${Date.now()}`;
const composeFile = path.join(directory, 'compose.yaml');
const content = 'services:\n  probe:\n    image: busybox:1.36\n    command: ["sleep", "300"]\n';
writeFileSync(composeFile, content);
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.SERVE_FRONTEND = '0';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const compose = (...args) => docker('compose', '--project-name', projectName, '-f', composeFile, ...args);
let app;
try {
  compose('create');
  const container = compose('ps', '-aq').trim();
  assert(container);
  const { default: Fastify } = await import('fastify');
  const { default: routes } = await import('../backend/src/routes/projects.js');
  const { scanProjects } = await import('../backend/src/services/scanner.js');
  const { setProjectPreference } = await import('../backend/src/lib/db.js');
  const project = (await scanProjects()).find(item => item.projectName === projectName);
  assert(project);
  setProjectPreference(project.id, { managed: true, mountEnabled: true });
  app = Fastify({ logger: false });
  await app.register(routes, { prefix: '/projects' });
  const read = await app.inject({ method: 'GET', url: `/projects/${project.id}/compose` });
  assert.equal(read.statusCode, 200); assert.equal(read.json().hostId, 'local');
  const payload = { action: 'up', expectedContent: content, expectedHostId: 'local' };
  const url = `/projects/${project.id}/actions`;
  for (const wrong of [{ expectedContent: 'services: {}' }, { expectedHostId: 'another-node' }]) {
    const response = await app.inject({ method: 'POST', url, payload: { ...payload, ...wrong } });
    assert.equal(response.statusCode, 409);
    assert.equal(docker('inspect', '-f', '{{.State.Running}}', container).trim(), 'false');
  }
  const response = await app.inject({ method: 'POST', url, payload });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"type":"exit","data":\{"code":0\}/);
  assert.equal(docker('inspect', '-f', '{{.State.Running}}', container).trim(), 'true');
  console.log(JSON.stringify({ passed: true, wrongContentBlocked: true, wrongHostBlocked: true, matchingReviewStartedTemporaryContainer: true }));
} finally {
  await app?.close();
  try { compose('down', '--remove-orphans'); }
  finally { rmSync(directory, { recursive: true, force: true }); }
  console.log('Temporary review project removed.');
}
