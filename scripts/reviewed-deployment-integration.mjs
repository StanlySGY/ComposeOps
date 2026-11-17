import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'composeops-review-integration-'));
const projectName = `co-review-${Date.now()}`;
const composeFile = path.join(directory, 'compose.yaml');
const content = 'services:\n  probe:\n    image: busybox:${TAG}\n    command: ["sleep", "300"]\n';
const overrideFile = path.join(directory, 'override.yaml');
const envFile = path.join(directory, '.env');
const overrideContent = 'services: { probe: { environment: { REVIEW_MARKER: reviewed } } }';
writeFileSync(composeFile, content);
writeFileSync(overrideFile, overrideContent);
writeFileSync(envFile, 'TAG=1.36');
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.SERVE_FRONTEND = '0';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const compose = (...args) => docker('compose', '--project-name', projectName, '-f', composeFile, '-f', overrideFile, ...args);
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
  const issue = async () => {
    const result = await app.inject({ method: 'POST', url: `/projects/${project.id}/deployment-review` });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().files.length, 2);
    return { action: 'up', reviewToken: result.json().token };
  };
  const url = `/projects/${project.id}/actions`;
  for (const [file, changed, original] of [
    [composeFile, content.replace('sleep', 'echo'), content],
    [overrideFile, overrideContent.replace('reviewed', 'changed'), overrideContent],
    [envFile, 'TAG=1.35', 'TAG=1.36'],
  ]) {
    const payload = await issue(); writeFileSync(file, changed);
    const rejected = await app.inject({ method: 'POST', url, payload });
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(docker('inspect', '-f', '{{.State.Running}}', container).trim(), 'false');
    writeFileSync(file, original);
  }
  const payload = await issue();
  const response = await app.inject({ method: 'POST', url, payload });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"type":"exit","data":\{"code":0\}/);
  assert.equal(docker('inspect', '-f', '{{.State.Running}}', container).trim(), 'true');
  console.log(JSON.stringify({ passed: true, multiFileAndEnvironmentDriftBlocked: true, matchingReviewStartedTemporaryContainer: true }));
} finally {
  await app?.close();
  try { compose('down', '--remove-orphans'); }
  finally { rmSync(directory, { recursive: true, force: true }); }
  console.log('Temporary review project removed.');
}
