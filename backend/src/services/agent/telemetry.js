import { randomBytes } from 'node:crypto';
import { redactSecretValue } from '../../lib/secret-redactor.js';

const hex = (bytes) => randomBytes(bytes).toString('hex');
const nowNs = () => (BigInt(Date.now()) * 1_000_000n).toString();
const safeAttribute = (value) => {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) return { doubleValue: value };
  return { stringValue: String(redactSecretValue(String(value ?? ''))).slice(0, 240) };
};
const attributes = (values = {}) => Object.entries(values)
  .filter(([key, value]) => /^[a-zA-Z0-9_.-]{1,128}$/.test(key) && !/(prompt|completion|messages|arguments|password|secret|api.?key|authorization|cookie)/i.test(key) && value !== undefined && value !== null)
  .slice(0, 40)
  .map(([key, value]) => ({ key, value: safeAttribute(value) }));

function exporterUrl() {
  const explicit = String(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || '').trim();
  const base = String(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim();
  if (explicit) return explicit;
  if (!base) return '';
  const normalized = base.replace(/\/+$/, '');
  return normalized.endsWith('/v1/traces') ? normalized : normalized + '/v1/traces';
}

function exporterHeaders() {
  const result = { 'Content-Type': 'application/json' };
  const raw = String(process.env.OTEL_EXPORTER_OTLP_HEADERS || '');
  for (const item of raw.split(',')) {
    const index = item.indexOf('=');
    if (index <= 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (/^[a-zA-Z0-9-]{1,64}$/.test(key) && value && value.length <= 2048) result[key] = value;
  }
  return result;
}

/** Dependency-free OTLP/HTTP JSON exporter for GenAI spans. Never records prompts or tool arguments. */
export function createAgentTrace({ role = 'auto', planId = '', endpoint = exporterUrl(), fetchImpl = (...args) => fetch(...args) } = {}) {
  const traceId = hex(16);
  const spans = [];
  let rootSpanId = '';
  let flushed = false;

  function startSpan(name, values = {}, parentSpanId = rootSpanId) {
    const spanId = hex(8);
    const startTimeUnixNano = nowNs();
    let ended = false;
    const span = {
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: String(name).slice(0, 120),
      kind: 1,
      startTimeUnixNano,
      endTimeUnixNano: startTimeUnixNano,
      attributes: attributes(values),
      status: { code: 1 },
    };
    spans.push(span);
    return {
      spanId,
      end({ ok = true, values: extra = {} } = {}) {
        if (ended) return;
        ended = true;
        span.endTimeUnixNano = nowNs();
        if (!ok) span.status = { code: 2 };
        if (Object.keys(extra).length) span.attributes.push(...attributes(extra));
      },
    };
  }

  const root = startSpan('invoke_agent', {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': 'ComposeOps',
    'composeops.agent.role': role,
    'composeops.plan.id': planId,
  }, '');
  rootSpanId = root.spanId;

  return {
    traceId,
    startSpan,
    root,
    async flush() {
      if (flushed) return;
      flushed = true;
      root.end();
      if (!endpoint || !spans.length) return;
      const resource = attributes({
        'service.name': process.env.OTEL_SERVICE_NAME || 'composeops',
        'service.version': process.env.COMPOSEOPS_VERSION || 'unknown',
      });
      const payload = {
        resourceSpans: [{
          resource: { attributes: resource },
          scopeSpans: [{
            scope: { name: 'composeops.agent', version: '1.0.0' },
            spans,
          }],
        }],
      };
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: exporterHeaders(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(1200),
        });
        if (!response?.ok) process.emitWarning('ComposeOps OTLP trace export returned HTTP ' + String(response?.status || 'unknown'));
      } catch (error) {
        process.emitWarning('ComposeOps OTLP trace export skipped (' + (error?.name || 'network error') + ')');
      }
    },
  };
}
