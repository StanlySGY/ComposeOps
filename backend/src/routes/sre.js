import { scanAllProjects } from '../services/scanner.js';
import { getSreProfile, listSreProfiles, saveSreProfile, pauseSreProfile, archiveSreProfile } from '../services/sre-profiles.js';
import { latestProbe, probeStatistics } from '../services/sre-probes.js';
import { getAutonomyPolicy, saveAutonomyPolicy } from '../services/sre-autonomy.js';
import { sreInsights } from '../services/sre-insights.js';
import { listSreChanges, reviewSreChange, approveSreChange, cancelSreChange, sreChangeFingerprint, acknowledgeSreChange } from '../services/sre-changes.js';
import { listRecoveryPlans, listRecoveryRuns, recoveryCandidates, saveRecoveryPlan, pauseRecoveryPlan, queueRecoveryRun, acknowledgeRecoveryRun } from '../services/sre-recovery.js';
import { listSreRetrospectives, createSreRetrospective } from '../services/sre-retrospectives.js';
import { platformSnapshot, savePlatformConfig, rotatePlatformMonitorToken } from '../services/sre-platform.js';
import { getSloAlertRule, saveSloAlertRule, sloAlertEvidence } from '../services/sre-slo-alerts.js';
import { listDiagnosisEvaluations, queueDiagnosisEvaluation, diagnosisSuiteInfo } from '../services/diagnosis-evaluation.js';
import { getAiConfig } from '../services/ai.js';
import { listTelemetryCredentials, createTelemetryCredential, revokeTelemetryCredential } from '../services/sre-telemetry.js';
import businessRecoveryRoutes from './business-recovery.js';
import onboardingRoutes from './onboarding.js';
import { listSreReleases, reviewSreRelease, approveSreRelease } from '../services/sre-releases.js';

const actor = request => request.user?.username || request.user?.id || 'admin';
const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 160 } } };
const profileView = profile => ({ ...profile, latest: latestProbe(profile), statistics: probeStatistics(profile), policy: getAutonomyPolicy(profile.id) });
export default async function sreRoutes(fastify) {
  await fastify.register(businessRecoveryRoutes, { prefix: '/business-recovery' });
  await fastify.register(onboardingRoutes, { prefix: '/onboarding' });
  fastify.get('/releases', async () => ({ releases: listSreReleases().map(change => ({ ...change, fingerprint: sreChangeFingerprint(change) })) }));
  fastify.post('/releases/review', { schema: { body: { type: 'object', additionalProperties: false, required: ['services'], properties: { services: { type: 'array', minItems: 2, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['profileId', 'image', 'migration', 'compatibilityNote'], properties: { profileId: { type: 'string', maxLength: 160 }, image: { type: 'string', maxLength: 300 }, migration: { enum: ['none', 'backward_compatible'] }, compatibilityNote: { type: 'string', minLength: 8, maxLength: 1000 } } } } } } } }, async (request, reply) => {
    const change = await reviewSreRelease(request.body, actor(request)); return reply.code(201).send({ change: { ...change, fingerprint: sreChangeFingerprint(change) } });
  });
  fastify.post('/releases/:id/approve', { schema: { params, body: { type: 'object', required: ['confirm', 'fingerprint', 'allowRollback', 'compatibilityConfirmed'], properties: { confirm: { const: 'APPLY_APPLICATION_RELEASE' }, fingerprint: { type: 'string', maxLength: 64 }, allowRollback: { type: 'boolean' }, compatibilityConfirmed: { const: true } } } } }, async request => ({ change: approveSreRelease(request.params.id, request.body, actor(request)) }));
  fastify.get('/telemetry/credentials', async () => ({ credentials: listTelemetryCredentials(), limits: { batchRecords: 200, recordsPerMinute: 2000, bytesPerMinute: 8 * 1024 ** 2, retentionDays: 7, perProject: 20000, global: 200000 } }));
  fastify.post('/telemetry/credentials', { schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'hostId', 'projectId', 'services'], properties: { name: { type: 'string', maxLength: 100 }, hostId: { type: 'string', maxLength: 160 }, projectId: { type: 'string', maxLength: 160 }, services: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 160 } } } } } }, async (request, reply) => reply.code(201).send(await createTelemetryCredential(request.body, actor(request))));
  fastify.delete('/telemetry/credentials/:id', { schema: { params } }, async request => revokeTelemetryCredential(request.params.id, actor(request)));
  fastify.get('/diagnosis/evaluations', async () => ({ evaluations: listDiagnosisEvaluations(), suite: diagnosisSuiteInfo(), channels: getAiConfig().channels.filter(row => row.enabled && row.apiKey).map(row => ({ id: row.id, name: row.name, model: row.model })) }));
  fastify.post('/diagnosis/evaluations', { schema: { body: { type: 'object', additionalProperties: false, properties: { channelId: { type: 'string', maxLength: 160 } } } } }, async (request, reply) => reply.code(202).send({ evaluation: queueDiagnosisEvaluation(request.body, actor(request)) }));
  fastify.get('/platform', async () => platformSnapshot());
  fastify.put('/platform/config', { schema: { body: { type: 'object', required: ['version', 'thresholds'], properties: { version: { type: 'integer', minimum: 0 }, thresholds: { type: 'object' } } } } }, async request => ({ config: savePlatformConfig(request.body, actor(request)) }));
  fastify.post('/platform/monitor-token', async request => rotatePlatformMonitorToken(actor(request)));
  fastify.get('/profiles/:id/alerts', { schema: { params } }, async request => { const profile = getSreProfile(request.params.id), rule = getSloAlertRule(profile.id); return { rule, evidence: sloAlertEvidence(profile, rule) }; });
  fastify.put('/profiles/:id/alerts', { schema: { params, body: { type: 'object', required: ['version', 'config'], properties: { version: { type: 'integer', minimum: 0 }, config: { type: 'object' } } } } }, async request => ({ rule: saveSloAlertRule(request.params.id, request.body, actor(request)) }));
  const acknowledgement = { params, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 8, maxLength: 1000 } } } };
  fastify.post('/changes/:id/acknowledge', { schema: acknowledgement }, async request => ({ change: await acknowledgeSreChange(request.params.id, request.body.reason, actor(request)) }));
  fastify.post('/recovery/runs/:id/acknowledge', { schema: acknowledgement }, async request => ({ run: await acknowledgeRecoveryRun(request.params.id, request.body.reason, actor(request)) }));
  const changeView = change => ({ ...change, fingerprint: sreChangeFingerprint(change) });
  fastify.get('/operations', async () => ({ changes: listSreChanges().filter(change => change.review.recipe !== 'application-release-v1').map(changeView), recoveryPlans: listRecoveryPlans(), recoveryRuns: listRecoveryRuns(), retrospectives: listSreRetrospectives(), insights: sreInsights() }));
  fastify.post('/changes/review', { schema: { body: { type: 'object', required: ['profileId', 'image'], properties: { profileId: { type: 'string', maxLength: 160 }, image: { type: 'string', maxLength: 300 } } } } }, async (request, reply) => reply.code(201).send({ change: changeView(await reviewSreChange(request.body, actor(request))) }));
  fastify.post('/changes/:id/approve', { schema: { params, body: { type: 'object', required: ['confirm', 'fingerprint', 'allowRollback'], properties: { confirm: { type: 'string' }, fingerprint: { type: 'string', maxLength: 64 }, allowRollback: { type: 'boolean' } } } } }, async request => ({ change: changeView(approveSreChange(request.params.id, request.body, actor(request))) }));
  fastify.post('/changes/:id/cancel', { schema: { params } }, async request => ({ change: changeView(cancelSreChange(request.params.id, actor(request))) }));
  fastify.get('/recovery/candidates', { schema: { querystring: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string', maxLength: 160 }, hostId: { type: 'string', maxLength: 160 } } } } }, async request => recoveryCandidates(request.query));
  const planBody = { type: 'object', required: ['volumes'], properties: { version: { type: 'integer', minimum: 1 }, hostId: { type: 'string', maxLength: 160 }, projectId: { type: 'string', maxLength: 160 }, volumes: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 255 } }, rpoMinutes: { type: 'integer' }, rtoMinutes: { type: 'integer' }, scheduleHours: { type: 'integer' }, enabled: { type: 'boolean' }, confirm: { type: 'string', maxLength: 40 } } };
  fastify.post('/recovery/plans', { schema: { body: planBody } }, async request => ({ plan: await saveRecoveryPlan({ ...request.body, id: undefined }, actor(request)) }));
  fastify.put('/recovery/plans/:id', { schema: { params, body: planBody } }, async request => ({ plan: await saveRecoveryPlan({ ...request.body, id: request.params.id }, actor(request)) }));
  fastify.post('/recovery/plans/:id/pause', { schema: { params } }, async request => ({ plan: pauseRecoveryPlan(request.params.id, actor(request)) }));
  fastify.post('/recovery/plans/:id/run', { schema: { params } }, async (request, reply) => reply.code(202).send({ run: queueRecoveryRun(request.params.id, actor(request)) }));
  fastify.post('/retrospectives', async request => ({ retrospective: await createSreRetrospective(actor(request)) }));
  fastify.get('/profiles', async () => ({ profiles: listSreProfiles().map(profileView), insights: sreInsights() }));
  fastify.get('/targets', async () => ({ targets: (await scanAllProjects()).filter(project => project.managed).map(project => ({
    hostId: project.hostId, projectId: project.id, projectName: project.projectName, editable: project.editable,
    services: [...new Set(project.containers.map(container => container.service).filter(Boolean))],
  })) }));
  fastify.post('/profiles', { schema: { body: { type: 'object', required: ['projectId', 'serviceName', 'config'], properties: {
    hostId: { type: 'string', maxLength: 160 }, projectId: { type: 'string', maxLength: 160 }, serviceName: { type: 'string', maxLength: 160 },
    config: { type: 'object' }, enabled: { type: 'boolean' },
  } } } }, async (request, reply) => reply.code(201).send({ profile: profileView(await saveSreProfile({ ...request.body, id: undefined, version: undefined }, actor(request))) }));
  fastify.put('/profiles/:id', { schema: { params, body: { type: 'object', required: ['version', 'config'], properties: {
    version: { type: 'integer', minimum: 1 }, config: { type: 'object' }, enabled: { type: 'boolean' },
  } } } }, async request => ({ profile: profileView(await saveSreProfile({ ...request.body, id: request.params.id }, actor(request))) }));
  fastify.post('/profiles/:id/pause', { schema: { params } }, async request => ({ profile: profileView(pauseSreProfile(request.params.id, actor(request))) }));
  fastify.put('/profiles/:id/autonomy', { schema: { params, body: { type: 'object', required: ['version', 'enabled'], properties: {
    version: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' }, confirm: { type: 'string', maxLength: 40 },
    expiresAt: { type: 'integer' }, cooldownMs: { type: 'integer' }, maxDaily: { type: 'integer' }, maintenanceUntil: { type: 'integer' },
  } } } }, async request => ({ policy: saveAutonomyPolicy(request.params.id, request.body, actor(request)) }));
  fastify.delete('/profiles/:id', { schema: { params } }, async request => ({ profile: archiveSreProfile(request.params.id, actor(request)) }));
  fastify.get('/profiles/:id', { schema: { params } }, async request => ({ profile: profileView(getSreProfile(request.params.id)) }));
}
