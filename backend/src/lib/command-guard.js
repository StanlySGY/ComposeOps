/**
 * 输出侧命令护栏:LLM 生成(或用户粘贴)的命令在进入容器执行前做最后一道静态检查。
 *
 * 输入侧已有四道闸(权限门/确认门/只读白名单/ENABLE_SHELL 开关),这里补齐输出侧:
 * 只拦截"灾难性且几乎不可能是合法排障"的模式,误杀率优先让位于不拦截正常命令。
 * 命中即拒绝执行,并把原因回传给调用方(Agent 会把原因再喂回 LLM 重新决策)。
 */

const CATASTROPHIC_PATTERNS = [
  { re: /\brm\s+(?:-{1,2}[\w-]+\s+)*\/(?:\s|$|[;&|#$])/i, reason: '递归删除根目录(rm -rf /)' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+--no-preserve-root/i, reason: 'rm --no-preserve-root' },
  { re: /\brm\s+--no-preserve-root\b/i, reason: 'rm --no-preserve-root' },
  { re: /\bmkfs(?:\.\w+)?\b/i, reason: '格式化文件系统(mkfs)' },
  { re: /\bdd\s+[^;&|]*of=\/dev\/(?:sd|vd|nvme|hd|mmcblk)/i, reason: 'dd 直写块设备' },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, reason: 'fork 炸弹' },
  { re: /\bchmod\s+(?:-[a-z]+\s+)*777\s+\/(?:\s|$|[;&|#$])/i, reason: '对根目录开放写权限(chmod 777 /)' },
  { re: /\b(?:shutdown|halt|poweroff)\b/i, reason: '关机/停机命令' },
  { re: /\breboot\b/i, reason: '重启命令' },
  { re: /\binit\s+[06]\b/, reason: 'init 0/6 切换运行级' },
  { re: /\b(?:curl|wget)\b[^;&|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, reason: '下载脚本直接管道执行(curl|sh)' },
  { re: />\s*\/dev\/(?:sd|vd|nvme|hd)[a-z]/i, reason: '重定向直写块设备' },
];

/**
 * 静态检查一条命令是否允许在容器内执行。
 * @param {string} command
 * @returns {{ allowed: boolean, reason?: string, matched?: string }}
 */
export function inspectCommand(command) {
  const text = String(command || '');
  if (!text.trim()) return { allowed: false, reason: '命令为空' };
  for (const { re, reason } of CATASTROPHIC_PATTERNS) {
    const matched = re.exec(text);
    if (matched) return { allowed: false, reason, matched: matched[0].slice(0, 80) };
  }
  return { allowed: true };
}

/** 便捷断言:不允许时抛出带 statusCode 的错误,由上层转成 400/工具错误。 */
export function assertCommandAllowed(command) {
  const verdict = inspectCommand(command);
  if (!verdict.allowed) {
    throw Object.assign(
      new Error(`命令被输出护栏拦截:${verdict.reason}`),
      { statusCode: 400, code: 'command_guarded' }
    );
  }
  return true;
}
