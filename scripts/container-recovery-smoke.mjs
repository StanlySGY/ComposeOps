import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Docker from 'dockerode';

const execFileAsync = promisify(execFile);
const docker = new Docker();
const root = await mkdtemp(path.join(os.tmpdir(), 'composeops-recovery-'));
process.env.DB_PATH = path.join(root, 'smoke.db');
const { prepareProjectAction } = await import('../backend/src/services/project-action-runner.js');
const projectName = `composeops-recovery-${process.pid}-${Date.now()}`;
const composeFile = path.join(root, 'compose.yml');
const compose = `services:
  recovery-target:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
`;

async function composeCommand(...args) {
  return execFileAsync('docker', ['compose', '-p', projectName, '-f', composeFile, ...args], { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
}
async function cleanup() {
  try { await composeCommand('down', '-v', '--remove-orphans'); } catch {}
  await rm(root, { recursive: true, force: true });
}
try {
  await writeFile(composeFile, compose, 'utf8');
  await composeCommand('up', '-d');
  const listed = await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${projectName}`] } });
  assert.equal(listed.length, 1, 'temporary Compose project must expose exactly one container');
  const containerId = listed[0].Id;
  const container = docker.getContainer(containerId);
  await container.stop({ t: 1 });
  const stopped = await container.inspect();
  assert.equal(stopped.State.Status, 'exited', 'failure injection must leave the target exited');

  const project = {
    id: `smoke-${tprojectName}`,
    projectName,
    owner: 'composeops-smoke',
    workingDir: root,
    composeFiles: [composeFile],
    composeFile,
    managed: true,
    mountEnabled: false,
    editable: false,
    mounted: false,
    containers: [{ id: containerId, name: listed[0].Names[0].replace(/^\//, ''), state: 'exited', image: listed[0].Image }],
  };
  const prepared = await prepareProjectAction(project, 'up');
  assert.equal(prepared.mode, 'containers', 'unmounted managed project must use containers mode');
  const output = [];
  const exitCode = await prepared.run((stream, text) => output.push({ stream, text }));
  assert.equal(exitCode, 0, `container recovery action must succeed: ${JSON.stringify(output)}`);
  const recovered = await container.inspect();
  assert.equal(recovered.State.Status, 'running', 'container must be running after recovery');
  assert.ok(output.some((item) => item.stream === 'stdout'), 'recovery must emit stdout');
  console.log('CONTAINER_RECOVERY_SMOKE=PASS');
  console.log(`PROJECT=${projectName}`);
  console.log(`MODE=${prepared.mode}`);
  console.log('INJECTED=exited');
  console.log(`ACTION_CODE=${exitCode}`);
  console.log(`RECOVERED-${recovered.State.Status}`);
} finally {
  await cleanup();
}

