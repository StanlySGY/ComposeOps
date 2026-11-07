import { afterEach, expect, it, vi } from 'vitest';
import { clearRecentPages, readRecentPages, rememberPage } from '../src/lib/command-history.js';

const allowed = ['/services', '/logs', '/settings', '/compose', '/events', '/monitor'];
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('最近页面按使用顺序去重，刷新恢复且最多五个', () => {
  let ids = [];
  for (const id of allowed) ids = rememberPage(ids, id, allowed);
  ids = rememberPage(ids, '/logs', allowed);
  expect(ids).toEqual(['/logs', '/monitor', '/events', '/compose', '/settings']);
  expect(readRecentPages(allowed)).toEqual(ids);
  clearRecentPages();
  expect(readRecentPages(allowed)).toEqual([]);
});

it('损坏数据和未知、动态或操作命令不会进入最近页面', () => {
  localStorage.setItem('composeops:recent-pages', '{broken');
  expect(readRecentPages(allowed)).toEqual([]);
  localStorage.setItem('composeops:recent-pages', JSON.stringify(['/logs', '/logs', null, {}, 'run-project-up', '/logs?projectId=private', 'https://example.com']));
  expect(readRecentPages(allowed)).toEqual(['/logs']);
  expect(rememberPage(['/logs'], 'run-project-up', allowed)).toEqual(['/logs']);
});

it('浏览器禁用存储时仍保留本次会话的快捷记录', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(readRecentPages(allowed)).toEqual([]);
  expect(rememberPage([], '/logs', allowed)).toEqual(['/logs']);
  expect(clearRecentPages()).toEqual([]);
});
