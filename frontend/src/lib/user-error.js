const CODES = {
  project_not_found: '项目已不存在，请刷新项目列表后重试。',
  host_not_found: '节点已不存在，请重新选择节点。',
  project_not_managed: '请先在设置中纳管这个项目，再执行操作。',
  host_changed: '节点已切换，请重新打开目标项目后操作。',
  operation_in_progress: '项目正在执行其他操作，请等待完成后重试。',
  invalid_password: '密码不正确，请重新输入。',
  unauthorized: '登录已过期，请重新登录。',
  forbidden: '当前操作未获授权，请检查设置与项目权限。',
};
const HTTP = {
  400: '请求内容有误，请检查表单后重试。',
  401: CODES.unauthorized,
  403: CODES.forbidden,
  404: '目标资源已不存在，请刷新列表后重试。',
  409: '数据已变更或操作正在进行，请刷新状态后重试。',
  422: '配置未通过校验，请检查填写内容。',
  429: '请求过于频繁，请稍后重试。',
  502: '上游服务暂不可用，请检查节点连接后重试。',
  503: '服务暂不可用，请稍后重试。',
  504: '请求超时，请检查节点连接或稍后重试。',
};

export function userError(cause, { status, code } = {}) {
  if (cause?.localized || cause?.name === 'AbortError') return cause;
  const raw = String(cause?.message || cause || '');
  const http = status || cause?.status;
  const key = code || cause?.code || raw;
  let message = CODES[key];
  if (!message && /Failed to fetch|NetworkError|Load failed|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(raw)) message = '无法连接服务，请检查网络连接后重试。';
  if (!message && /timeout|timed out/i.test(raw)) message = HTTP[504];
  if (!message && /[\u4e00-\u9fff]/.test(raw) && raw.length <= 300) message = raw;
  if (!message) message = HTTP[http] || '操作未完成，请稍后重试；可展开详情查看原因。';
  const error = new Error(message);
  error.localized = true;
  error.status = http;
  error.code = key;
  error.details = [http ? `HTTP ${http}` : '', raw !== message ? raw.slice(0, 4000) : ''].filter(Boolean).join('\n');
  return error;
}
