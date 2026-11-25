import path from 'node:path';

/** 父目录可位于宿主机任意普通文件系统；内核伪文件系统不是项目位置。 */
export function normalizeHostDirectory(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw Object.assign(new Error('请选择有效的宿主机绝对目录'), { statusCode: 400 });
  }
  const normalized = path.posix.normalize(value).replace(/\/$/, '') || '/';
  if (/^\/(proc|sys|dev)(\/|$)/.test(normalized)) {
    throw Object.assign(new Error('不能在内核设备或系统状态目录中创建项目'), { statusCode: 403 });
  }
  return normalized;
}

// 在只读挂载 /host 内逐段解析链接。绝对链接必须仍从宿主根目录解析，
// 不能让 fs.realpath 跳到 helper 自己的 /home 或 /etc。
export function hostDirectoryInspector() {
  const fs = require('node:fs');
  const path = require('node:path').posix;
  const [requested, resolveOnly, allowMissing, after = ''] = process.argv.slice(1);
  const blocked = p => /^\/(proc|sys|dev)(\/|$)/.test(p);
  function resolve(input, missing = false) {
    let parts = path.normalize(input).split('/').filter(Boolean);
    let current = '/', links = 0;
    while (parts.length) {
      const next = path.join(current, parts.shift());
      if (blocked(next)) throw Object.assign(new Error('不支持内核目录'), { code: 'EACCES' });
      let stat;
      try { stat = fs.lstatSync('/host' + next); }
      catch (error) {
        if (missing && error.code === 'ENOENT') return { path: path.join(next, ...parts), exists: false };
        throw error;
      }
      if (stat.isSymbolicLink()) {
        if (++links > 40) throw Object.assign(new Error('目录链接循环'), { code: 'ELOOP' });
        const target = path.resolve(current, fs.readlinkSync('/host' + next));
        parts = [...target.split('/').filter(Boolean), ...parts];
        current = '/';
      } else {
        if (!stat.isDirectory()) throw Object.assign(new Error('目标不是目录'), { code: 'ENOTDIR' });
        current = next;
      }
    }
    return { path: current, exists: true };
  }
  try {
    const result = resolve(requested, allowMissing === '1');
    const entries = resolveOnly === '1' || !result.exists ? [] : fs.readdirSync('/host' + result.path, { withFileTypes: true })
      .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !/[\0\r\n]/.test(entry.name) && !blocked(path.join(result.path, entry.name)))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .filter(entry => entry.name > after);
    const page = entries.slice(0, 500);
    process.stdout.write(JSON.stringify({ ...result, entries: page.map(entry => ({ name: entry.name, path: path.join(result.path, entry.name), symlink: entry.isSymbolicLink() })), next: entries.length > 500 ? page.at(-1).name : '' }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.code || 'DIRECTORY_ERROR' }));
    process.exitCode = 1;
  }
}
