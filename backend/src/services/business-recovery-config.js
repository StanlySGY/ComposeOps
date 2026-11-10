import { incidentError } from './incident-store.js';
const name = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const service = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const sensitive = /(SECRET|TOKEN|PASSWORD|PASSWD|\bPASS\b|(?:API|PRIVATE|ACCESS|SECRET|AUTH|SIGNING)[_-]?KEY)/i;
const placeholders = ['$DB_HOST', '$DB_PORT', '$DB_USER', '$DB_NAME', '$DB_PASSWORD', '$DB_URL'];
const control = value => [...value].some(char => char.charCodeAt(0) < 32);
const integer = (value, min, max, label) => { if (!Number.isInteger(value) || value < min || value > max) throw incidentError(label + '超出范围', 400); return value; };
export function validateBusinessConfig(input) {
  if (!input || !['postgres', 'mysql', 'mariadb'].includes(input.engine)) throw incidentError('选择 PostgreSQL、MySQL 或 MariaDB', 400);
  for (const key of ['dbService', 'appService']) if (!service.test(input[key] || '')) throw incidentError('数据库或应用服务名无效', 400);
  if (input.dbService === input.appService) throw incidentError('数据库与应用必须是不同服务', 400);
  for (const key of ['database', 'user', 'credentialEnv']) if (!name.test(input[key] || '')) throw incidentError('库名、用户名与凭据环境变量仅允许字母、数字和下划线', 400);
  if (!Array.isArray(input.assertions) || !input.assertions.length || input.assertions.length > 10) throw incidentError('需要 1 至 10 个业务表数据断言', 400);
  const assertions = input.assertions.map(row => {
    if (!row || typeof row.table !== 'string' || row.table.split('.').length > 2 || !row.table.split('.').every(part => name.test(part)) || /^(pg_|information_schema|mysql|sys|performance_schema)/i.test(row.table)) throw incidentError('断言必须指向业务表', 400);
    const assertion = { table: row.table, expectedRows: integer(row.expectedRows, 0, 1e12, '预期记录数') };
    if (row.column) {
      if (!name.test(row.column) || typeof row.equals !== 'string' || row.equals.length > 200 || control(row.equals) || row.equals.includes('\\')) throw incidentError('数据断言字段或比较值无效', 400);
      assertion.column = row.column; assertion.equals = row.equals;
    }
    return assertion;
  });
  const environment = input.appEnvironment || {};
  if (!environment || Array.isArray(environment) || typeof environment !== 'object' || Object.keys(environment).length > 40) throw incidentError('隔离应用环境变量最多 40 个', 400);
  for (const [key, value] of Object.entries(environment)) {
    if (!name.test(key) || typeof value !== 'string' || value.length > 2000 || control(value) || value.includes('$') && !placeholders.includes(value)) throw incidentError('隔离环境变量无效，请使用完整的 $DB_* 占位值', 400);
    if (sensitive.test(key) && !['$DB_PASSWORD', '$DB_URL'].includes(value)) throw incidentError('敏感环境变量只能引用隔离数据库占位值，不能保存明文凭据', 400);
    if (/[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i.test(value)) throw incidentError('环境变量不能包含带凭据的地址，请使用 $DB_URL 隔离占位值', 400);
  }
  if (!Object.values(environment).some(value => ['$DB_HOST', '$DB_URL'].includes(value))) throw incidentError('应用环境必须通过 $DB_HOST 或 $DB_URL 指向隔离数据库', 400);
  const http = input.http || {};
  if (typeof http.path !== 'string' || !/^\/(?!\/)[^\s?#\\]{0,200}$/.test(http.path) || typeof http.bodyContains !== 'string' || !http.bodyContains.trim() || http.bodyContains.length > 500) throw incidentError('业务 HTTP 检查需要相对路径和预期响应文本', 400);
  return { engine: input.engine, dbService: input.dbService, appService: input.appService, database: input.database, user: input.user, credentialEnv: input.credentialEnv,
    assertions, appEnvironment: { ...environment }, http: { path: http.path, bodyContains: http.bodyContains, port: integer(http.port, 1, 65535, '应用端口'), expectedStatus: integer(http.expectedStatus ?? 200, 200, 299, 'HTTP 成功状态') },
    rpoMinutes: integer(input.rpoMinutes ?? 1440, 1, 43200, 'RPO'), rtoMinutes: integer(input.rtoMinutes ?? 15, 1, 60, 'RTO'), scheduleHours: integer(input.scheduleHours ?? 0, 0, 720, '调度间隔') };
}
export function businessAssertionSql(config, assertion) {
  const quote = value => config.engine === 'postgres' ? '"' + value + '"' : '`' + value + '`';
  const table = assertion.table.split('.').map(quote).join('.');
  return `SELECT COUNT(*) FROM ${table}${assertion.column ? ` WHERE ${quote(assertion.column)} = '${assertion.equals.replaceAll("'", "''")}'` : ''}`;
}
export function isolatedEnvironment(config, password) {
  const port = config.engine === 'postgres' ? '5432' : '3306';
  const values = { $DB_HOST: 'recovery-db', $DB_PORT: port, $DB_USER: config.user, $DB_NAME: config.database, $DB_PASSWORD: password,
    $DB_URL: `${config.engine === 'postgres' ? 'postgresql' : 'mysql'}://${encodeURIComponent(config.user)}:${encodeURIComponent(password)}@recovery-db:${port}/${encodeURIComponent(config.database)}` };
  return Object.entries(config.appEnvironment).map(([key, value]) => `${key}=${values[value] ?? value}`);
}
