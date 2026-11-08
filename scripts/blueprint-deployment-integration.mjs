#!/usr/bin/env node
// Isolated real-Docker exercise. Creates only uniquely named test projects;
// removes their containers/directories and its separate SQLite database afterward.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'composeops-blueprint-drill-'));
process.env.DB_PATH = path.join(temporary, 'isolated.db');
process.env.COMPOSEOPS_RUNNER_IMAGE ||= 'stanly1997/opsdash:latest';
const prefix = `cops-blueprint-${randomBytes(5).toString('hex')}`;
const names = ['success', 'failed', 'concurrent', 'existing'].map(suffix => `${prefix}-${suffix}`);
const { listBlueprints, deployBlueprint, renderBlueprintCompose } = await import('../backend/src/services/app-blueprints.js');
const { withRunner, readArchiveFile, closeAllWorkspaceRunners } = await import('../backend/src/services/compose-workspace.js');
const { scanProjects, invalidateScanCache } = await import('../backend/src/services/scanner.js');
const { default: YAML } = await import('yaml');

function docker(args, { allowFailure = false, input } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`Docker exercise command failed (${result.status}): ${String(result.stderr).slice(0, 1200)}`);
  return String(result.stdout || '').trim();
}

function workspace(projectName) {
  const root = `/projects/${projectName}`;
  return { id: projectName, projectName, hostId: 'local', activeHostAtScan: 'local', workingDir: root, composeFiles: [`${root}/docker-compose.yml`] };
}

function helper(args) {
  return docker(['run', '--rm', '--network', 'none', '--read-only', '-v', '/projects:/projects', '--entrypoint', 'sh', 'alpine:3.20', ...args]);
}

const fixture = {
  id: `${prefix}-fixture`, name: 'Isolated deployment exercise',
  defaultCompose: 'services:\n  test:\n    image: alpine:3.20\n    container_name: ${CONTAINER_NAME}\n    network_mode: none\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    command: [sleep, "300"]\n    env_file: [.env]\n    environment:\n      DIRECT_VALUE: "${PASSWORD}"\n',
  envSchema: [{ key: 'CONTAINER_NAME' }, { key: 'PASSWORD', secret: true }],
};
// The fixture exists only in this process's in-memory catalog, never in the repo.
const blueprints = await listBlueprints(); blueprints.push(fixture);
const checks = [];
try {
  const secret = 'synthetic $HOME ${USER} $$literal "quote" \'single\' \\path\nnext\r\ttail\\';
  const result = await deployBlueprint(fixture.id, { projectName: names[0], PASSWORD: secret });
  assert.equal(result.ok, true); assert.equal(result.code, 0); assert.equal(result.hostId, 'local');
  const inspection = JSON.parse(docker(['inspect', names[0]]))[0];
  assert.equal(inspection.State.Running, true);
  const environment = Object.fromEntries(inspection.Config.Env.map(entry => { const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)]; }));
  assert.equal(environment.DIRECT_VALUE, secret);
  assert.equal(environment.PASSWORD, secret);
  checks.push('fresh host directory → actual Compose start; literal dollars, quotes, backslashes and multiline values preserved in both Compose and env_file');
  await withRunner(workspace(names[0]), async runner => {
    for (const file of ['docker-compose.yml', '.env']) {
      const archived = await readArchiveFile(runner, `/projects/${names[0]}/${file}`);
      assert.equal(archived.header.mode & 0o777, 0o600);
    }
  });
  invalidateScanCache();
  const discovered = (await scanProjects()).find(project => project.id === result.projectId);
  assert.ok(discovered?.managed); assert.equal(discovered.hostId, 'local');
  checks.push('files mode 0600; scanner discovers same host-scoped project and management');

  fixture.defaultCompose = fixture.defaultCompose.replace('[sleep, "300"]', '[/composeops-intentionally-missing-command]');
  const failed = await deployBlueprint(fixture.id, { projectName: names[1], PASSWORD: secret });
  assert.equal(failed.ok, false); assert.notEqual(failed.code, 0); assert.equal(failed.filesCreated, true);
  const previous = await withRunner(workspace(names[1]), runner => readArchiveFile(runner, `/projects/${names[1]}/docker-compose.yml`));
  await assert.rejects(deployBlueprint(fixture.id, { projectName: names[1], PASSWORD: 'different-on-retry' }), error => error.statusCode === 409);
  const after = await withRunner(workspace(names[1]), runner => readArchiveFile(runner, `/projects/${names[1]}/docker-compose.yml`));
  assert.equal(after.content, previous.content);
  checks.push('real OCI startup failure reported as failed; retry preserves existing configuration');

  fixture.defaultCompose = fixture.defaultCompose.replace('[/composeops-intentionally-missing-command]', '[sleep, "300"]');
  const concurrent = await Promise.allSettled([1, 2].map(() => deployBlueprint(fixture.id, { projectName: names[2], PASSWORD: secret })));
  assert.equal(concurrent.filter(item => item.status === 'fulfilled' && item.value.ok).length, 1);
  assert.equal(concurrent.filter(item => item.status === 'rejected' && item.reason.statusCode === 409).length, 1);
  checks.push('concurrent identical deployment starts exactly once');

  helper(['-c', 'mkdir -- "$1" && printf original > "$1/keep.txt"', 'test', `/projects/${names[3]}`]);
  await assert.rejects(deployBlueprint(fixture.id, { projectName: names[3], PASSWORD: secret }), error => error.statusCode === 409 && /目录/.test(error.message));
  assert.equal(helper(['-c', 'cat "$1/keep.txt"', 'test', `/projects/${names[3]}`]), 'original');
  checks.push('unregistered existing directory is protected even without Docker containers');

  for (const blueprint of blueprints.filter(item => item !== fixture)) {
    const values = Object.fromEntries((blueprint.envSchema || []).map(field => [field.key, field.secret ? 'synthetic-validation-only' : field.default ?? '']));
    const rendered = renderBlueprintCompose(blueprint, values);
    assert.ok(YAML.parse(rendered)?.services);
    docker(['compose', '--project-directory', temporary, '-p', prefix, '-f', '-', 'config', '--quiet'], { input: rendered });
  }
  checks.push('all shipped templates pass real docker compose config validation');
  console.log(JSON.stringify({ result: 'PASS', checks, prefix }, null, 2));
} finally {
  await closeAllWorkspaceRunners();
  for (const name of names) {
    const ids = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${name}`]);
    if (ids) docker(['rm', '-f', ...ids.split(/\s+/)]);
    helper(['-c', 'case "$1" in /projects/cops-blueprint-*) rm -rf -- "$1" ;; *) exit 1 ;; esac', 'test', `/projects/${name}`]);
  }
  const index = blueprints.indexOf(fixture); if (index >= 0) blueprints.splice(index, 1);
  rmSync(temporary, { force: true, recursive: true });
}
