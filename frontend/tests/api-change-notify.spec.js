import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/api/client.js';
import { DATA_CHANGED_EVENT } from '../src/lib/data-changes.js';

let changed;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })));
  changed = vi.fn(); window.addEventListener(DATA_CHANGED_EVENT, changed);
});
afterEach(() => { window.removeEventListener(DATA_CHANGED_EVENT, changed); vi.unstubAllGlobals(); });

it.each(['preview-production', 'check-database', 'test-environment', 'validate-service', 'anomalies-dashboard', 'ping-exporter'])('资源名 %s 不会把真实写入误当成只读预览', async id => {
  await api.saveProjectPreference(id, { note: 'fixture' });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].detail.path).toBe(`/projects/${id}/preferences`);
});

it('带 preview 前缀的持久任务恢复会立即通知状态面板', async () => {
  await api.resumeAgentRun('preview-run-1', 3);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('检查与校验端点继续保持只读，不广播写入成功', async () => {
  await api.checkUpdates(); await api.pingHost('local'); await api.validateCompose('project', 0, 'services: {}');
  expect(changed).not.toHaveBeenCalled();
});
