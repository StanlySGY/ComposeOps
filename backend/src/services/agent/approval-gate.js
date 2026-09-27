/**
 * ApprovalGate:会话级审批门控。
 * 借鉴 EnsoCode src/agent/approval.ts,按 ComposeOps 确认门改造:
 *  - sessionAllowed:本会话内"总是允许"的工具集合(工具名+参数指纹)
 *  - mode 三档:'ask'(默认,逐次确认)/ 'allow_writes'(放行非高危)/ 'full'(仅 critical 仍需确认)
 *  - critical 永远确认(fail-closed):检查顺序上 critical 先于 allowed 集合,
 *    "本会话不再询问"对 critical 工具一律不生效,防止记忆授权越过最高防线。
 *  - 指纹覆盖全部参数(排序序列化):compose.exec 的 command、environment.set 的
 *    key/value 等自由参数必须参与指纹,否则"同参数不再询问"会退化为
 *    "同容器执行任意命令不再询问"。
 *  - 无 sessionId 的直连流不走记忆授权(needsConfirmation 跳过 allowed 集合),
 *    匿名调用之间不共享任何"不再询问"授权。
 */

const MODES = new Set(['ask', 'allow_writes', 'full']);

/** 参数域指纹:全部参数按键名排序序列化,嵌套对象走 JSON,保证同一调用稳定、不同调用可区分。 */
function paramsFingerprint(params = {}) {
  if (!params || typeof params !== 'object') return '';
  const keys = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort();
  if (!keys.length) return '';
  return keys
    .map((key) => {
      const value = params[key];
      const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}=${text}`;
    })
    .join('|');
}

export class ApprovalGate {
  constructor() {
    // sessionId -> { mode, allowed: Set<string> }
    this.sessions = new Map();
  }

  _isAnonymous(sessionId) {
    return sessionId === null || sessionId === undefined || sessionId === '';
  }

  _session(sessionId) {
    const key = this._isAnonymous(sessionId) ? 'default' : String(sessionId);
    if (!this.sessions.has(key)) this.sessions.set(key, { mode: 'ask', allowed: new Set() });
    return this.sessions.get(key);
  }

  getMode(sessionId) { return this._session(sessionId).mode; }

  setMode(sessionId, mode) {
    if (!MODES.has(mode)) return false;
    this._session(sessionId).mode = mode;
    return true;
  }

  /** 是否需要向用户确认。risk 为 assessRisk 的结果(low/medium/high/critical)。 */
  needsConfirmation(sessionId, toolName, params, risk, toolConfirmationRequired) {
    // critical 检查必须在 allowed 集合之前:记忆授权不得越过 critical 防线。
    if (risk === 'critical') return true;
    const session = this._session(sessionId);
    if (!this._isAnonymous(sessionId)) {
      const key = `${toolName}:${paramsFingerprint(params)}`;
      if (session.allowed.has(key) || session.allowed.has(toolName)) return false;
    }
    if (session.mode === 'full') return false;
    if (session.mode === 'allow_writes') return risk === 'high';
    return toolConfirmationRequired || risk === 'high';
  }

  /**
   * 用户选择"本会话不再询问"时调用。scope: 'call'(精确参数) | 'tool'(整个工具)。
   * critical 风险拒绝记忆(与 needsConfirmation 的 fail-closed 顺序双保险);
   * 匿名会话没有稳定的桶,记忆无意义,直接忽略。
   */
  allowForSession(sessionId, toolName, params, scope = 'call', risk = null) {
    if (risk === 'critical' || this._isAnonymous(sessionId)) return false;
    const session = this._session(sessionId);
    session.allowed.add(scope === 'tool' ? toolName : `${toolName}:${paramsFingerprint(params)}`);
    return true;
  }

  clearSession(sessionId) {
    this.sessions.delete(String(sessionId || 'default'));
  }
}

let singleton = null;
export function getApprovalGate() {
  if (!singleton) singleton = new ApprovalGate();
  return singleton;
}
