/**
 * Docker 节点表单校验与凭据掩码工具(纯函数,便于 Vitest 单测)。
 */

const MASK_PREFIX = '••••';

/** 校验节点表单,返回错误数组(空数组表示通过)。 */
export function validateHostForm(input = {}) {
  const errors = [];
  if (!input.name || !String(input.name).trim()) errors.push('节点名称不能为空');
  if (input.type !== 'local' && !input.host?.trim()) errors.push('请填写主机地址');
  if (input.type === 'ssh') {
    const port = Number(input.port) || 0;
    if (!(port >= 1 && port <= 65535)) errors.push('SSH 端口需在 1-65535 之间');
  }
  if (input.type === 'tcp') {
    const port = Number(input.port) || 0;
    if (!(port >= 1 && port <= 65535)) errors.push('TCP 端口需在 1-65535 之间');
  }
  return errors;
}

/** 是否为掩码占位(表示保留旧值)。 */
export function isMasked(value) {
  return typeof value === 'string' && value.startsWith(MASK_PREFIX);
}

/** 根据表单输入构造提交 payload(掩码字段不覆盖已有安全值)。 */
export function buildHostPayload(editor = {}) {
  const payload = {
    name: String(editor.name || '').trim(),
    type: editor.type === 'ssh' ? 'ssh' : 'tcp',
    host: editor.type === 'local' ? '' : String(editor.host || '').trim(),
    port: Number(editor.port) || (editor.type === 'ssh' ? 22 : 2375),
    username: String(editor.username || 'root').trim(),
  };
  if (editor.type === 'ssh') {
    if (!isMasked(editor.password)) payload.password = editor.password || '';
    if (!isMasked(editor.privateKey)) payload.privateKey = editor.privateKey || '';
  }
  return payload;
}

/** 构建容器指标行的 DOCKER_HOST(dockerode/docker-modem 可读)。 */
export function buildDockerHostEnv(host = {}) {
  if (host.type === 'local') return '';
  if (host.type === 'ssh') {
    return `ssh://${host.username || 'root'}@${host.host}:${host.port || 22}`;
  }
  return `tcp://${host.host}:${host.port || 2375}`;
}
