/**
 * Agent 编排引擎聚合出口(兼容导入点)。
 *
 * 实现已拆为:
 *  - ./agent/engine.js —— OperationsAgent 类、AGENT_ROLES、getAgent() 单例、RISK_LEVELS re-export
 *  - ./agent/planning.js —— resolveToolContext/assertPermission/validateParams
 * 本文件仅做 re-export,防止既有 import { … } from 'services/agent.js' 断链。
 */
export {
  AGENT_ROLES,
  listAgentRoles,
  resolveAgentRole,
  OperationsAgent,
  getAgent,
  RISK_LEVELS,
} from './agent/engine.js';
export {
  resolveToolContext,
  assertPermission,
  validateParams,
} from './agent/planning.js';
