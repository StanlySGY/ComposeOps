import { describe, expect, it } from 'vitest';
import { QUERY_SYNTAX, matchLogQuery, parseLogQuery } from '../src/lib/log-query.js';

/** 后端 parseLogLine 产出的行形状:ts 带显式偏移,data 已剥掉时间戳。 */
const line = (overrides = {}) => ({
  type: 'stdout',
  data: 'serving request',
  ts: '2026-10-12T09:40:00.000Z',
  level: 'info',
  containerName: 'web',
  ...overrides,
});

const hits = (query, lines) => lines.filter((l) => matchLogQuery(parseLogQuery(query), l));

describe('日志查询解析 parseLogQuery', () => {
  it('空查询不激活过滤,全部日志通过', () => {
    expect(parseLogQuery('')).toEqual({ branches: [], error: '', active: false });
    expect(parseLogQuery('   ')).toEqual({ branches: [], error: '', active: false });
    expect(matchLogQuery(parseLogQuery(''), line())).toBe(true);
  });

  it('字段别名归一到同一字段', () => {
    for (const token of ['level:error', 'lv:error', 'lvl:error']) {
      expect(parseLogQuery(token).branches[0][0]).toMatchObject({ kind: 'level', level: 'error' });
    }
    for (const token of ['container:web', 'service:web', 'name:web', 'svc:web']) {
      expect(parseLogQuery(token).branches[0][0]).toMatchObject({ kind: 'container', value: 'web' });
    }
    for (const token of ['stream:stderr', 'type:stderr', 'io:stderr']) {
      expect(parseLogQuery(token).branches[0][0]).toMatchObject({ kind: 'stream', stream: 'stderr' });
    }
    for (const token of ['after:09:30', 'since:09:30', 'from:09:30']) {
      expect(parseLogQuery(token).branches[0][0]).toMatchObject({ kind: 'time', mode: 'after' });
    }
    for (const token of ['before:09:30', 'until:09:30', 'to:09:30']) {
      expect(parseLogQuery(token).branches[0][0]).toMatchObject({ kind: 'time', mode: 'before' });
    }
  });

  it('级别与输出流接受常见缩写,未知取值报错而不是静默失配', () => {
    expect(parseLogQuery('level:err').branches[0][0].level).toBe('error');
    expect(parseLogQuery('level:warning').branches[0][0].level).toBe('warn');
    expect(parseLogQuery('level:fatal').branches[0][0].level).toBe('error');
    expect(parseLogQuery('level:nope').error).toContain('级别 "nope" 不存在');
    expect(parseLogQuery('stream:err').error).toContain('输出流 "err" 不存在');
  });

  it('正则字面量是一个整体:内部的 | 不当成“或”,标志位不丢', () => {
    const parsed = parseLogQuery('/retry|timeout/i');
    expect(parsed.error).toBe('');
    expect(parsed.branches).toHaveLength(1);
    expect(parsed.branches[0]).toHaveLength(1);
    expect(parsed.branches[0][0].kind).toBe('regex');
    expect(matchLogQuery(parsed, line({ data: 'ETIMEDOUT retry after connect' }))).toBe(true);
    expect(matchLogQuery(parsed, line({ data: 'serving request' }))).toBe(false);
  });

  it('正则里的转义斜杠不闭合字面量', () => {
    const parsed = parseLogQuery('/a\\/b|c/gi');
    expect(parsed.error).toBe('');
    expect(parsed.branches[0]).toHaveLength(1);
    expect(matchLogQuery(parsed, line({ data: 'x a/b y' }))).toBe(true);
    // 两个分支是 `a/b` 与 `c`,都不命中才算未命中。
    expect(matchLogQuery(parsed, line({ data: 'x ay y' }))).toBe(false);
  });

  it('非法正则报错,不静默当成文本', () => {
    expect(parseLogQuery('/(/').error).toContain('正则表达式无效');
  });

  it('正文里的斜杠与冒号按普通文本处理,不误判成语法错误', () => {
    for (const token of ['/var/log/app', 'http://example.com/health', '/foo/bar']) {
      const parsed = parseLogQuery(token);
      expect(parsed.error).toBe('');
      expect(parsed.branches[0][0].kind).toBe('text');
    }
    expect(matchLogQuery(parseLogQuery('http://example.com/health'), line({ data: 'GET http://example.com/health 200' }))).toBe(true);
  });

  it('语法表里的每个写法都必须能解析,避免文档与实现漂移', () => {
    for (const row of QUERY_SYNTAX) {
      expect(parseLogQuery(row.token).error, `语法表写法 ${row.token}`).toBe('');
    }
  });

  it('语法错误只返回 error,由调用方保留上一批日志', () => {
    const cases = [
      ['level:', '字段 level: 缺少取值'],
      ['!', '取反符 `!` 后面缺少条件'],
      ['a "unclosed', '引号没有闭合'],
      ["a 'unclosed", '引号没有闭合'],
      ['after:99:99', '时间 "99:99" 无法解析'],
      ['after:昨天', '时间 "昨天" 无法解析'],
    ];
    for (const [query, needle] of cases) {
      const parsed = parseLogQuery(query);
      expect(parsed.error, query).toContain(needle);
      expect(parsed.branches, query).toEqual([]);
      expect(parsed.active, query).toBe(true);
    }
  });

  it('多余空白与空的或分支不报错', () => {
    expect(parseLogQuery('a  b').branches[0]).toHaveLength(2);
    expect(parseLogQuery('a |').branches).toHaveLength(1);
    expect(parseLogQuery('a | b').branches).toHaveLength(2);
  });
});

describe('日志查询命中 matchLogQuery', () => {
  const rows = [
    line({ level: 'error', data: 'connection reset by peer', containerName: 'api', type: 'stderr' }),
    line({ level: 'warn', data: 'health check slow', containerName: 'api', type: 'stdout' }),
    line({ level: 'info', data: 'GET /health 200', containerName: 'web', ts: '2026-10-12T10:05:00.000Z' }),
    line({ level: 'info', data: 'ETIMEDOUT retry after connect', containerName: 'web', type: 'stderr' }),
    // 聚合流之外的单容器帧没有 containerName。
    line({ containerName: undefined }),
  ];

  it('空格即“与”,必须同时命中', () => {
    expect(hits('level:error container:api', rows).map((r) => r.data)).toEqual(['connection reset by peer']);
  });

  it('`|` 即“或”,任一分支命中即可', () => {
    expect(hits('"connection reset" | /ETIMEDOUT/i', rows).map((r) => r.data))
      .toEqual(['connection reset by peer', 'ETIMEDOUT retry after connect']);
  });

  it('引号短语整串匹配,含空格也能命中', () => {
    expect(hits('"reset by peer"', rows).map((r) => r.data)).toEqual(['connection reset by peer']);
    expect(hits('"peer reset"', rows)).toEqual([]);
  });

  it('`!` 取反任意条件', () => {
    expect(hits('container:api !health', rows).map((r) => r.data)).toEqual(['connection reset by peer']);
    expect(hits('!level:error', rows).map((r) => r.data)).toEqual([
      'health check slow',
      'GET /health 200',
      'ETIMEDOUT retry after connect',
      'serving request',
    ]);
  });

  it('stream 按输出流匹配,缺省视为 stdout', () => {
    expect(hits('stream:stderr', rows).map((r) => r.data))
      .toEqual(['connection reset by peer', 'ETIMEDOUT retry after connect']);
    expect(hits('stream:stdout', rows)).toHaveLength(3);
  });

  it('level 缺省视为 info', () => {
    expect(hits('level:info', rows).map((r) => r.data))
      .toEqual(['GET /health 200', 'ETIMEDOUT retry after connect', 'serving request']);
  });

  it('container 按容器名子串匹配,缺失 containerName 的行不命中', () => {
    expect(hits('container:web', rows).map((r) => r.data))
      .toEqual(['GET /health 200', 'ETIMEDOUT retry after connect']);
    expect(hits('container:api web', rows)).toEqual([]);
  });

  it('HH:MM 时间窗按时间戳自身的时刻比较,与行首显示一致', () => {
    expect(hits('after:09:30 before:10:00', rows).map((r) => r.data))
      .toEqual(['connection reset by peer', 'health check slow', 'ETIMEDOUT retry after connect', 'serving request']);
    expect(hits('after:10:00', rows).map((r) => r.data)).toEqual(['GET /health 200']);
    expect(hits('after:09:40:00 before:09:40:00', rows).map((r) => r.data))
      .toEqual(['connection reset by peer', 'health check slow', 'ETIMEDOUT retry after connect', 'serving request']);
  });

  it('完整 RFC3339 时间窗按绝对时刻比较', () => {
    expect(hits('after:2026-10-12T10:00:00Z', rows).map((r) => r.data)).toEqual(['GET /health 200']);
    expect(hits('before:2026-10-12T09:40:00Z', rows)).toHaveLength(4);
  });

  it('没有服务端时间戳的行不落在时间窗内', () => {
    const noTs = [line({ ts: null, data: 'no timestamp' })];
    expect(hits('after:00:00', noTs)).toEqual([]);
    expect(hits('before:23:59', noTs)).toEqual([]);
    expect(hits('!after:00:00', noTs).map((r) => r.data)).toEqual(['no timestamp']);
  });

  it('无有效条件时全部通过,空分支不吞掉结果', () => {
    expect(hits('', rows)).toHaveLength(5);
    expect(hits('level:error | ', rows).map((r) => r.data)).toEqual(['connection reset by peer']);
  });
});
