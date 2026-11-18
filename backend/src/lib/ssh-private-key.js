import ssh2 from 'ssh2';

/** Validate key material without ever including the key or passphrase in an error. */
export function inspectSshPrivateKey(value, passphrase = '') {
  const key = String(value || '').trim();
  if (!key) return { ok: true, kind: 'none' };

  if (!key.includes('-----BEGIN ') && !key.startsWith('PuTTY-User-Key-File-')) {
    const looksLikePath = key.startsWith('/') || key.startsWith('~/') || key.startsWith('./') || key.startsWith('../') || /^[A-Za-z]:[\\/]/.test(key);
    return {
      ok: false,
      code: looksLikePath ? 'ssh_private_key_path' : 'ssh_private_key_format',
      message: looksLikePath
        ? 'SSH 私钥字段需要完整私钥内容；当前输入看起来像文件路径，请粘贴私钥文本，而不是路径。'
        : '无法识别 SSH 私钥格式，请使用完整的 OpenSSH 或 PEM 私钥内容。',
    };
  }

  let parsed;
  try {
    parsed = ssh2.utils.parseKey(key, passphrase || undefined);
  } catch {
    return { ok: false, code: 'ssh_private_key_format', message: 'SSH 私钥无法解析，请确认粘贴的是完整且受支持的 OpenSSH/PEM 私钥内容。' };
  }
  if (parsed instanceof Error || (Array.isArray(parsed) && parsed.some((item) => item instanceof Error))) {
    const reason = parsed instanceof Error ? parsed.message : parsed.find((item) => item instanceof Error)?.message || '';
    if (/passphrase|bad passphrase|integrity check/i.test(reason)) {
      return { ok: false, code: 'ssh_private_key_passphrase', message: 'SSH 私钥已加密或私钥口令不正确；请在“SSH 密码 / 私钥口令”栏填写正确口令。' };
    }
    return { ok: false, code: 'ssh_private_key_format', message: 'SSH 私钥无法解析，请确认粘贴的是完整且受支持的 OpenSSH/PEM 私钥内容。' };
  }
  return { ok: true, kind: 'parsed' };
}

export function assertSshPrivateKey(value, passphrase = '') {
  const result = inspectSshPrivateKey(value, passphrase);
  if (!result.ok) throw Object.assign(new Error(result.message), { statusCode: 400, code: result.code });
}
