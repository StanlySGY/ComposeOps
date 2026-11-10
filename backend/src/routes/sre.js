import { scanAllProjects } from '../services/scanner.js';
import { getSreProfile, listSreProfiles, saveSreProfile, pauseSreProfile } from '../services/sre-profiles.js';
import { latestProbe, probeStatistics } from '../services/sre-probes.js';
import { getAutonomyPolicy, saveAutonomyPolicy } from '../services/sre-autonomy.js';
import { sreInsights } from '../services/sre-insights.js';

const actor = request => request.user?.username || request.user?.id || 'admin';
const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 160 } } };
const profileView = profile => ({ ...profile, latest: latestProbe(profile), statistics: probeStatistics(profile), policy: getAutonomyPolicy(profile.id) });
export default async function sreRoutes(fastify) {
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
  fastify.get('/profiles/:id', { schema: { params } }, async request => ({ profile: profileView(getSreProfile(request.params.id)) }));
}
