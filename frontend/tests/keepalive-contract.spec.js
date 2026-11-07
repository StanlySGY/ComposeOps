import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
it('缓存页面必须显式管理激活与失活，或通过 keepAlive 刷新订阅管理', () => {
  const app = readFileSync(resolve('src/App.vue'), 'utf8');
  const names = [...app.match(/const keepAliveViews = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  for (const name of names) {
    const code = readFileSync(resolve('src/views', name + '.vue'), 'utf8');
    expect(/onActivated\(/.test(code) && /onDeactivated\(/.test(code) || /usePullRefresh\([\s\S]*?keepAlive:\s*true/.test(code), name).toBe(true);
  }
});
