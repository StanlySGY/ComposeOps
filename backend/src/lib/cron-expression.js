/** 解析单个 cron 字段 → 匹配函数(纯函数,便于单测)。 */
export function parseField(value, min, max) {
  if (value === '*' || value.trim() === '') return () => true;
  const matchers = [];
  for (const part of String(value).split(',')) {
    const trimmed = part.trim();
    if (!/^(?:\*|\d+(?:-\d+)?)(?:\/[1-9]\d*)?$/.test(trimmed)) throw new Error(`无效的 cron 字段 "${trimmed}"`);
    if (trimmed === '*') { matchers.push(() => true); continue; }
    const stepMatch = /^(.+?)\/(\d+)$/.exec(trimmed);
    let range = trimmed;
    let step = 1;
    if (stepMatch) { range = stepMatch[1]; step = Number(stepMatch[2]); }
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : lo;
    }
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || !Number.isSafeInteger(step) || lo < min || hi > max || lo > hi || step < 1) {
      throw new Error(`无效的 cron 字段 "${trimmed}"`);
    }
    matchers.push((value) => value >= lo && value <= hi && (value - lo) % step === 0);
  }
  return (value) => matchers.some((match) => match(value));
}

/** 校验并解析 5 段 cron 表达式 → { minute, hour, day, month, weekday }(纯函数)。 */
export function parseCron(expr = '') {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 表达式需要 5 段(分 时 日 月 周)');
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    day: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    weekday: parseField(parts[4], 0, 7),
  };
}

/** 校验 cron 表达式,合法返回 true,否则抛错(纯函数)。 */
export function validateCron(expr) {
  try {
    parseCron(expr);
    return true;
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }
}

/** 计算下一次执行时间(从 from 开始向后找,最远扫描 5 年)(纯函数)。 */
export function nextRunTime(expr, from = new Date()) {
  const cron = parseCron(expr);
  const cursor = new Date(from.getTime());
  cursor.setMilliseconds(0);
  cursor.setSeconds(0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const deadline = from.getTime() + 5 * 365 * 24 * 3600 * 1000;
  while (cursor.getTime() <= deadline) {
    if (
      cron.minute(cursor.getMinutes()) &&
      cron.hour(cursor.getHours()) &&
      cron.day(cursor.getDate()) &&
      cron.month(cursor.getMonth() + 1) &&
      // weekday 字段合法范围是 0..7(7 = 周日,部分 cron 方言),而 getDay() 只返回
      // 0-6:周日额外按 7 再测一次,否则写 7 的任务永不执行。
      (cron.weekday(cursor.getDay()) || (cursor.getDay() === 0 && cron.weekday(7)))
    ) {
      return cursor;
    }
    // 前进 1 分钟;命中失败时按 1 小时/1 天加速,避免超高迭代
    if (!cron.minute(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1);
    } else if (!cron.hour(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1);
      cursor.setMinutes(0);
    } else {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0);
      cursor.setMinutes(0);
    }
  }
  return null;
}

/** 预览与调度使用相同的解析器和服务器时区。 */
export function previewSchedule(expr, from = new Date()) {
  validateCron(expr);
  const nextRuns = [];
  let cursor = from;
  for (let index = 0; index < 3; index++) {
    cursor = nextRunTime(expr, cursor);
    if (!cursor) break;
    nextRuns.push(cursor.toISOString());
  }
  if (!nextRuns.length) throw Object.assign(new Error('未来五年内没有匹配时间，请检查日期与星期条件'), { statusCode: 400 });
  return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, nextRuns };
}
