// Opt-in real Docker acceptance. Only creates/deletes a unique fixture project.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Docker from 'dockerode';
if (!process.argv.includes('--run-isolated-fixtures')) throw new Error('需显式传入 --run-isolated-fixtures 才运行 Docker 验收');
const outputDir = path.resolve(process.env.SRE_EVIDENCE_DIR || '/tmp/composeops-business-evidence');
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const work = await mkdtemp(path.join(os.tmpdir(), 'composeops-business-drill-'));
process.env.DB_PATH = path.join(work, 'verification.db'); process.env.DISABLE_BACKGROUND_JOBS = '1'; process.env.SERVE_FRONTEND = '0';
const { default: db, setProjectPreference } = await import('../backend/src/lib/db.js');
const { getHost } = await import('../backend/src/services/docker-hosts.js');
const { captureDeploymentInputs } = await import('../backend/src/services/reviewed-deployment.js');
const { hostRevision } = await import('../backend/src/services/incident-observer.js');
const { businessExec, waitBusinessDatabase } = await import('../backend/src/services/business-recovery-docker.js');
const { saveBusinessPlan, queueBusinessBackup, executeBusinessBackup, queueBusinessRun, executeBusinessRun } = await import('../backend/src/services/sre-business-recovery.js');
const { createTelemetryCredential, authenticateTelemetry, ingestOtlp } = await import('../backend/src/services/sre-telemetry.js');
const { recordIncidentObservation } = await import('../backend/src/services/incident-store.js');
const { collectIncidentCorrelation } = await import('../backend/src/services/incident-correlation.js');
const { saveSreProfile } = await import('../backend/src/services/sre-profiles.js');
const { saveOnboarding, applyOnboarding } = await import('../backend/src/services/sre-onboarding.js');
const { SLO_ALERT_DEFAULTS } = await import('../backend/src/services/sre-slo-alerts.js');
const { readContainerLogs } = await import('../backend/src/lib/docker-exec.js');
const docker = new Docker(), cli = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { at: new Date().toISOString(), cases: [], sourceDataUnchanged: false, fixtureCleanup: false };
const engines = process.env.SRE_FIXTURE_ENGINES?.split(',') || ['postgres', 'mariadb'];
async function run(engine) {
  assert.ok(['postgres', 'mariadb', 'mysql'].includes(engine));
  const name = 'composeops-test-business-' + randomBytes(5).toString('hex'), dir = path.join(work, name); await mkdir(dir);
  const pg = engine === 'postgres', password = randomBytes(18).toString('hex'), user = pg ? 'postgres' : 'root', database = 'business', credentialEnv = pg ? 'POSTGRES_PASSWORD' : engine === 'mariadb' ? 'MARIADB_ROOT_PASSWORD' : 'MYSQL_ROOT_PASSWORD';
  const image = pg ? 'postgres:16-alpine' : engine === 'mariadb' ? 'mariadb:11' : 'mysql:8.4';
  const env = pg ? { POSTGRES_PASSWORD: password, POSTGRES_DB: database } : { [credentialEnv]: password, [engine === 'mariadb' ? 'MARIADB_DATABASE' : 'MYSQL_DATABASE']: database };
  const document = { services: {
    db: { image, environment: env, volumes: ['db-data:' + (pg ? '/var/lib/postgresql/data' : '/var/lib/mysql')] },
    app: { image: 'composeops:sre-business-fixture-20261110', depends_on: ['db'], environment: { DATABASE_URL: `${pg ? 'postgresql' : 'mysql'}://${user}:${password}@db:${pg ? 5432 : 3306}/${database}` } },
  }, volumes: { 'db-data': {} }, networks: { default: { internal: true } } };
  const file = path.join(dir, 'compose.json'); await writeFile(file, JSON.stringify(document), { mode: 0o600 });
  const compose = args => cli('docker', ['compose', '-p', name, '-f', file, ...args], { timeout: 180000, maxBuffer: 1024 ** 2 });
  let source;
  try {
    await compose(['up', '-d', '--no-build', '--pull', 'never']);
    const rows = await docker.listContainers({ all: true, filters: { label: ['com.docker.compose.project=' + name] } });
    const dbRow = rows.find(row => row.Labels['com.docker.compose.service'] === 'db'), appRow = rows.find(row => row.Labels['com.docker.compose.service'] === 'app');
    source = docker.getContainer(dbRow.Id); const app = docker.getContainer(appRow.Id);
    const config = { engine, dbService: 'db', appService: 'app', database, user, credentialEnv, appEnvironment: { DATABASE_URL: '$DB_URL' }, assertions: [
      { table: pg ? 'public.items' : 'items', expectedRows: 2 }, { table: pg ? 'public.items' : 'items', column: 'name', equals: 'known-business-value', expectedRows: 1 },
    ], http: { port: 8080, path: '/items', bodyContains: 'known-business-value', expectedStatus: 200 }, rpoMinutes: 60, rtoMinutes: 5, scheduleHours: 0 };
    await waitBusinessDatabase(source, config, password, { sleep, deadline: Date.now() + 120000 });
    const dbCommand = sql => pg ? ['psql', '-X', '-h', '127.0.0.1', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]
      : [engine === 'mariadb' ? 'mariadb' : 'mysql', '--protocol=TCP', '-h', '127.0.0.1', '-u', user, '-N', '-B', database, '-e', sql];
    const query = sql => businessExec(source, dbCommand(sql), [pg ? 'PGPASSWORD=' + password : 'MYSQL_PWD=' + password]);
    await query("CREATE TABLE items(id INTEGER PRIMARY KEY, name VARCHAR(100)); INSERT INTO items VALUES(1,'known-business-value'),(2,'untouched-source');");
    const before = await query('SELECT id,name FROM items ORDER BY id');
    const request = async () => JSON.parse(await businessExec(app, ['node', '-e', "fetch('http://127.0.0.1:8080/items').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text(),trace:r.headers.get('x-fixture-trace')})))"], [], { timeoutMs: 10000 }));
    const original = await request(); assert.equal(original.status, 200); assert.match(original.body, /known-business-value/);
    const project = { id: name, projectName: name, hostId: 'local', host: getHost('local'), managed: true, editable: true, mountEnabled: true, mounted: true, workingDir: dir, composeFiles: [file],
      containers: rows.map(row => ({ id: row.Id, service: row.Labels['com.docker.compose.service'] })) };
    setProjectPreference(name, { managed: true, mountEnabled: true });
    const dependencies = { scan: async () => [project], dockerForHost: () => docker, host: getHost, capture: captureDeploymentInputs };
    const plan = await saveBusinessPlan({ projectId: name, config, noConcurrentDdl: true }, 'isolated-acceptance', dependencies);
    const queued = queueBusinessBackup(plan.id, 'isolated-acceptance'), backup = await executeBusinessBackup(queued.id, dependencies);
    assert.equal(backup.status, 'verified', backup.error);
    const queuedRun = queueBusinessRun(plan.id, backup.id, 'isolated-acceptance'), recovery = await executeBusinessRun(queuedRun.id, dependencies);
    await writeFile(path.join(outputDir, engine + '-recovery.json'), JSON.stringify({ plan, backup, recovery }, null, 2), { mode: 0o600 });
    assert.equal(recovery.status, 'passed', recovery.error); assert.equal(recovery.result.cleanupComplete, true);
    const after = await query('SELECT id,name FROM items ORDER BY id'); assert.equal(after, before);
    const appNetwork = Object.values((await app.inspect()).NetworkSettings.Networks)[0];
    const healthUrl = 'http://' + appNetwork.IPAddress + ':8080/items'; assert.equal((await fetch(healthUrl)).status, 200);
    const profile = await saveSreProfile({ projectId: name, serviceName: 'app', config: { url: healthUrl } }, 'isolated-acceptance', dependencies);
    const onboarding = await saveOnboarding({ projectId: name, config: { health: { mode: 'existing', id: profile.id, version: profile.version }, recovery: { mode: 'existing', id: plan.id, version: plan.version },
      alerts: { ...structuredClone(SLO_ALERT_DEFAULTS), enabled: true }, notifications: 'later', autonomy: { enabled: false } } }, 'isolated-acceptance', dependencies);
    const onboarded = await applyOnboarding(onboarding.id, { version: onboarding.version, fingerprint: onboarding.fingerprint, confirm: 'APPLY_APPLICATION_ONBOARDING' }, 'isolated-acceptance', dependencies);
    assert.equal(onboarded.status, 'complete', onboarded.error); assert.equal(onboarded.progress.autonomy.enabled, false);
    await writeFile(path.join(outputDir, engine + '-onboarding.json'), JSON.stringify(onboarded, null, 2), { mode: 0o600 });
    const credential = await createTelemetryCredential({ name: 'isolated-' + engine, hostId: 'local', projectId: name, services: ['app', 'db'] }, 'isolated-acceptance', dependencies);
    await source.stop({ t: 5 });
    const broken = await request(); assert.equal(broken.status, 503);
    const log = await readContainerLogs(app, 20);
    const entries = String(log).split('\n').flatMap(line => { try { return [JSON.parse(line.slice(line.indexOf('{')))]; } catch { return []; } });
    const failure = entries.find(row => row.traceId === broken.trace); assert.ok(failure);
    const scoped = await authenticateTelemetry('Bearer ' + credential.token, dependencies);
    ingestOtlp(failure.traces, 'traces', scoped); ingestOtlp(failure.logs, 'logs', scoped);
    const appInfo = await app.inspect(), info = await docker.info();
    const incident = recordIncidentObservation({ project, identity: { hostRevision: hostRevision(getHost('local')), engineId: info.ID, containerId: appInfo.Id, createdAt: appInfo.Created, composeProject: name },
      snapshot: { id: appInfo.Id, service: 'app', name: 'fixture-app', state: 'running', healthy: false, fault: 'HTTP 503 after fixture database stopped', startedAt: appInfo.State.StartedAt }, at: new Date().toISOString() });
    const correlation = await collectIncidentCorrelation(incident.id, dependencies);
    assert.ok(correlation.traces.some(row => row.traceId === broken.trace)); assert.ok(correlation.hypotheses.some(row => row.confidence === 'medium'));
    assert.ok(correlation.hypotheses.every(row => row.kind === 'hypothesis'));
    await source.start(); await waitBusinessDatabase(source, config, password, { sleep, deadline: Date.now() + 120000 });
    assert.equal((await request()).status, 200); assert.equal(await query('SELECT id,name FROM items ORDER BY id'), before);
    await writeFile(path.join(outputDir, engine + '-dependency-fault.json'), JSON.stringify({ original, broken, correlation, recovered: true }, null, 2), { mode: 0o600 });
    report.cases.push({ engine, backupId: backup.id, runId: recovery.id, status: recovery.status, sqlAssertions: recovery.result.assertions, httpChecks: recovery.result.httpChecks,
      sourceRowsBefore: before, sourceRowsAfter: after, dependencyFaultCorrelated: true, fixtureProject: name });
    console.log(JSON.stringify({ engine, recovery: recovery.status, sourceDataUnchanged: true, dependencyFaultCorrelated: true }));
  } finally {
    await compose(['down', '-v', '--remove-orphans']);
    const remaining = await docker.listContainers({ all: true, filters: { label: ['com.docker.compose.project=' + name] } }); assert.equal(remaining.length, 0);
  }
}
try {
  for (const engine of engines) await run(engine);
  report.sourceDataUnchanged = true; report.fixtureCleanup = true;
} catch (error) { report.error = error.message; throw error; }
finally {
  await writeFile(path.join(outputDir, 'business-recovery-summary.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await import('../backend/src/services/workflow-engine.js'); await new Promise(resolve => setImmediate(resolve)); db.close();
  // Keep failed run DB/evidence for reconciliation; successful fixture credentials are erased.
  if (!report.error) await rm(work, { recursive: true, force: true });
  else { await rm(path.join(work, 'unused'), { force: true }); console.error('验收失败，隔离状态保留于：' + work); }
}
