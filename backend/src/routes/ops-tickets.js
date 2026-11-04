import {
  createOpsTicket, listOpsTickets, getOpsTicketDetail, updateOpsTicket,
  issueOpsMandate, revokeOpsMandate, createOpsAssignment, updateOpsAssignment,
  reconcileOpsAssignment, submitOpsReport, decideOpsReport, proposeOpsEffect,
  approveOpsEffect, cancelOpsEffect, reconcileOpsEffect,
} from '../services/ops-tickets.js';

const ticketParams = { type:'object', required:['ticketId'], additionalProperties:false, properties:{ ticketId:{type:'string',minLength:1,maxLength:160} } };
const nestedParams = { type:'object', required:['ticketId','mandateId'], additionalProperties:false, properties:{
  ticketId:{type:'string',minLength:1,maxLength:160}, mandateId:{type:'string',minLength:1,maxLength:160},
} };
const assignmentParams = { type:'object', required:['ticketId','assignmentId'], additionalProperties:false, properties:{
  ticketId:{type:'string',minLength:1,maxLength:160}, assignmentId:{type:'string',minLength:1,maxLength:160},
} };
const reportParams = { type:'object', required:['ticketId','reportId'], additionalProperties:false, properties:{
  ticketId:{type:'string',minLength:1,maxLength:160}, reportId:{type:'string',minLength:1,maxLength:160},
} };
const effectParams = { type:'object', required:['ticketId','effectId'], additionalProperties:false, properties:{
  ticketId:{type:'string',minLength:1,maxLength:160}, effectId:{type:'string',minLength:1,maxLength:160},
} };
const actor = (request) => request.user?.username || request.user?.id || 'admin';
const failure = (reply,error,defaultCode='ops_ticket_failed') => reply.code(error.statusCode || 400).send({
  error: error.code || defaultCode, message: error.message || '长期任务操作失败',
});

export default async function opsTicketRoutes(fastify) {
  fastify.get('/', {
    schema:{querystring:{type:'object',additionalProperties:false,properties:{
      status:{type:'string',maxLength:32},query:{type:'string',maxLength:120},limit:{type:'integer',minimum:1,maximum:200},
    }}},
  }, async (request) => listOpsTickets(request.query || {}));

  fastify.post('/', {
    schema:{body:{type:'object',additionalProperties:false,required:['title'],properties:{
      title:{type:'string',minLength:1,maxLength:200},description:{type:'string',maxLength:8000},
      priority:{type:'string',enum:['low','normal','high','urgent']},sourceType:{type:'string',enum:['manual','event','inspection','agent','workflow']},
      sourceId:{type:'string',maxLength:160},projectId:{type:'string',maxLength:160},hostId:{type:'string',maxLength:160},
      acceptanceCriteria:{type:'array',maxItems:20,items:{type:'string',maxLength:400}},idempotencyKey:{type:'string',maxLength:160},
    }}},
  }, async (request,reply) => {
    try { return reply.code(201).send(createOpsTicket(request.body || {},actor(request))); }
    catch(error) { return failure(reply,error); }
  });

  fastify.get('/:ticketId', { schema:{params:ticketParams} }, async (request,reply) => {
    try { return getOpsTicketDetail(request.params.ticketId); }
    catch(error) { return failure(reply,error); }
  });

  fastify.patch('/:ticketId', {
    schema:{params:ticketParams,body:{type:'object',additionalProperties:false,properties:{
      title:{type:'string',minLength:1,maxLength:200},description:{type:'string',maxLength:8000},
      priority:{type:'string',enum:['low','normal','high','urgent']},
      status:{type:'string',enum:['planning','ready','active','blocked','review','succeeded','failed','cancelled']},
      acceptanceCriteria:{type:'array',maxItems:20,items:{type:'string',maxLength:400}},
    }}},
  }, async (request,reply) => {
    try { return {ticket:updateOpsTicket(request.params.ticketId,request.body || {},actor(request))}; }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/mandates', {
    schema:{params:ticketParams,body:{type:'object',additionalProperties:false,required:['scope','allowedActions'],properties:{
      scope:{type:'object',additionalProperties:false,properties:{
        projectIds:{type:'array',maxItems:100,items:{type:'string',maxLength:160}},
        hostIds:{type:'array',maxItems:100,items:{type:'string',maxLength:160}},
        resourceIds:{type:'array',maxItems:100,items:{type:'string',maxLength:160}},
      }},
      allowedActions:{type:'array',minItems:1,maxItems:50,items:{type:'string',maxLength:120}},
      deniedActions:{type:'array',maxItems:50,items:{type:'string',maxLength:120}},
      expiresAt:{type:'string',maxLength:80},
    }}},
  }, async (request,reply) => {
    try { return reply.code(201).send({mandate:issueOpsMandate(request.params.ticketId,request.body || {},actor(request))}); }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/mandates/:mandateId/revoke', {
    schema:{params:nestedParams,body:{type:'object',additionalProperties:false,required:['reason'],properties:{reason:{type:'string',minLength:1,maxLength:500}}}},
  }, async (request,reply) => {
    try { return {mandate:revokeOpsMandate(request.params.ticketId,request.params.mandateId,request.body.reason,actor(request))}; }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/assignments', {
    schema:{params:ticketParams,body:{type:'object',additionalProperties:false,properties:{
      workerRole:{type:'string',enum:['planner','executor','validator','incident_responder','manual']},
      assignee:{type:'string',maxLength:120},sourceType:{type:'string',enum:['manual','agent-session','agent-plan','agent-task','workflow','batch-job']},
      sourceId:{type:'string',maxLength:160},sessionId:{type:'integer',minimum:1},mandateId:{type:'string',maxLength:160},
      handoffSummary:{type:'string',maxLength:4000},replacesAssignmentId:{type:'string',maxLength:160},idempotencyKey:{type:'string',maxLength:160},
    }}},
  }, async (request,reply) => {
    try { return reply.code(201).send(createOpsAssignment(request.params.ticketId,request.body || {},actor(request))); }
    catch(error) { return failure(reply,error); }
  });

  fastify.patch('/:ticketId/assignments/:assignmentId', {
    schema:{params:assignmentParams,body:{type:'object',additionalProperties:false,properties:{
      status:{type:'string',enum:['assigned','running','waiting','blocked','handed_off','succeeded','failed','outcome_unknown','cancelled']},
      handoffSummary:{type:'string',maxLength:4000},
    }}},
  }, async (request,reply) => {
    try { return {assignment:updateOpsAssignment(request.params.ticketId,request.params.assignmentId,request.body || {},actor(request))}; }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/assignments/:assignmentId/reconcile', {
    schema:{params:assignmentParams,body:{type:'object',additionalProperties:false,required:['outcome','note'],properties:{
      outcome:{type:'string',enum:['succeeded','failed','cancelled']},note:{type:'string',minLength:1,maxLength:2000},
    }}},
  }, async (request,reply) => {
    try { return {assignment:reconcileOpsAssignment(request.params.ticketId,request.params.assignmentId,request.body.outcome,request.body.note,actor(request))}; }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/reports', {
    schema:{params:ticketParams,body:{type:'object',additionalProperties:false,required:['summary'],properties:{
      assignmentId:{type:'string',maxLength:160},reportType:{type:'string',maxLength:40},summary:{type:'string',minLength:1,maxLength:4000},
      findings:{type:'array',maxItems:50,items:{type:'object',additionalProperties:false,properties:{
        title:{type:'string',maxLength:200},severity:{type:'string',enum:['info','warning','danger']},
        detail:{type:'string',maxLength:2000},recommendation:{type:'string',maxLength:1000},
      }}},
      evidence:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,properties:{
        kind:{type:'string',maxLength:40},sourceId:{type:'string',maxLength:240},observedAt:{type:'string',maxLength:80},summary:{type:'string',maxLength:1000},
      }}},
    }}},
  }, async (request,reply) => {
    try { return reply.code(201).send({report:submitOpsReport(request.params.ticketId,request.body || {},actor(request))}); }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/reports/:reportId/decision', {
    schema:{params:reportParams,body:{type:'object',additionalProperties:false,required:['accepted'],properties:{
      accepted:{type:'boolean'},note:{type:'string',maxLength:2000},
    }}},
  }, async (request,reply) => {
    try { return {report:decideOpsReport(request.params.ticketId,request.params.reportId,request.body.accepted,request.body.note || '',actor(request))}; }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/effects', {
    schema:{params:ticketParams,body:{type:'object',additionalProperties:false,required:['effectType'],properties:{
      effectType:{type:'string',minLength:1,maxLength:120},mode:{type:'string',enum:['observe','suggest','execute']},
      risk:{type:'string',enum:['low','medium','high','critical']},target:{type:'object'},payload:{type:'object'},
      assignmentId:{type:'string',maxLength:160},mandateId:{type:'string',maxLength:160},idempotencyKey:{type:'string',maxLength:160},
    }}},
  }, async (request,reply) => {
    try { return reply.code(201).send(proposeOpsEffect(request.params.ticketId,request.body || {},actor(request))); }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/effects/:effectId/approve', { schema:{params:effectParams} }, async (request,reply) => {
    try { return {effect:approveOpsEffect(request.params.ticketId,request.params.effectId,actor(request))}; }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/effects/:effectId/cancel', {
    schema:{params:effectParams,body:{type:'object',additionalProperties:false,properties:{reason:{type:'string',maxLength:1000}}}},
  }, async (request,reply) => {
    try { return {effect:cancelOpsEffect(request.params.ticketId,request.params.effectId,request.body?.reason || '',actor(request))}; }
    catch(error) { return failure(reply,error); }
  });

  fastify.post('/:ticketId/effects/:effectId/reconcile', {
    schema:{params:effectParams,body:{type:'object',additionalProperties:false,required:['outcome','note'],properties:{
      outcome:{type:'string',enum:['succeeded','failed','cancelled']},note:{type:'string',minLength:1,maxLength:2000},
    }}},
  }, async (request,reply) => {
    try { return {effect:reconcileOpsEffect(request.params.ticketId,request.params.effectId,request.body.outcome,request.body.note,actor(request))}; }
    catch(error) { return failure(reply,error); }
  });
}
