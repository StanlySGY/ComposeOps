/** Small JSON Schema subset used at every Agent execution boundary. No coercion. */
export function validateToolValue(schema = {}, value, path = '参数') {
  const fail = message => { throw Object.assign(new Error(`${path} ${message}`), { statusCode: 400 }); };
  if (schema.anyOf) {
    if (!schema.anyOf.some(candidate => { try { validateToolValue(candidate, value, path); return true; } catch { return false; } })) fail('不符合允许的类型或取值');
    return;
  }
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) fail(`类型必须是 ${schema.type}`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) fail('不是要求的确认值');
  if (schema.enum && !schema.enum.includes(value)) fail('的值不在允许范围内');
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`长度不能小于 ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`长度不能超过 ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('格式无效');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`不能小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`不能大于 ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`至少需要 ${schema.minItems} 项`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`最多允许 ${schema.maxItems} 项`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('不能包含重复项');
    if (schema.items) value.forEach((item, index) => validateToolValue(schema.items, item, `${path}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key) || value[key] === undefined) fail(`缺少必填参数 ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('包含不支持的属性');
      const definition = schema.properties?.[key];
      if (definition) validateToolValue(definition, item, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`不支持的参数 ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateToolValue(schema.additionalProperties, item, `${path}.${key}`);
    }
  }
}
