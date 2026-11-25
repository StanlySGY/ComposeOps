import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredComposeProjectRoots, safeProjectMountPath } from '../src/services/mount-plan.js';

test('默认创建根目录只有 /projects', () => {
  assert.deepEqual(configuredComposeProjectRoots(''), ['/projects']);
  assert.deepEqual(configuredComposeProjectRoots(undefined), ['/projects']);
});

test('创建根目录白名单只接受去重后的安全绝对路径', () => {
  assert.deepEqual(
    configuredComposeProjectRoots('/projects,/opt/composeops,/opt/composeops,/home/alice/apps'),
    ['/projects', '/opt/composeops', '/home/alice/apps'],
  );
  assert.deepEqual(configuredComposeProjectRoots('/,/home,/root,/srv,/projects'), ['/projects']);
  assert.equal(safeProjectMountPath('/opt/composeops'), '/opt/composeops');
  assert.equal(safeProjectMountPath('/'), null);
  assert.equal(safeProjectMountPath('/home/alice'), null);
});
