import assert from 'node:assert/strict';
import test from 'node:test';
import { validateComposeSemantics, previewComposeChange } from '../src/services/compose-validator.js';

test('compose-validator: 捕获 depends_on 引用不存在服务', () => {
  const issues = validateComposeSemantics(`
services:
  web:
    image: nginx
    depends_on:
      - cache
  db:
    image: postgres
`);
  assert.ok(issues.some((issue) => issue.level === 'error' && /depends_on/.test(issue.message)));
});

test('compose-validator: 健康 compose 无错误', () => {
  const issues = validateComposeSemantics(`
services:
  web:
    image: nginx
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres
`);
  assert.equal(issues.filter((issue) => issue.level === 'error').length, 0);
});

test('compose-validator: 端口冲突检测', () => {
  const issues = validateComposeSemantics(`
services:
  a:
    image: nginx
    ports: ["8080:80"]
  b:
    image: httpd
    ports: ["8080:80"]
`);
  assert.ok(issues.some((issue) => issue.level === 'error' && /端口映射/.test(issue.message)));
});

test('compose-validator: 缺 image/build 警告', () => {
  const issues = validateComposeSemantics(`
services:
  web:
    command: sleep 1
`);
  assert.ok(issues.some((issue) => issue.level === 'warn' && /未声明 image/.test(issue.message)));
});

test('compose-validator: 非法 YAML 返回解析错误', () => {
  const issues = validateComposeSemantics('services:\n  web: [unclosed');
  assert.ok(issues.some((issue) => issue.level === 'error' && /YAML 解析失败/.test(issue.message)));
});

test('compose-preview: 区分新增/变更/移除服务', () => {
  const project = {
    containers: [
      { name: 'app-web-1', state: 'running', image: 'nginx' },
      { name: 'app-db-1', state: 'running', image: 'postgres' },
    ],
  };
  const newContent = `
services:
  web:
    image: nginx:alpine
    environment:
      FOO: bar
  db:
    image: postgres
  redis:
    image: redis
`;
  const preview = previewComposeChange(newContent, project);
  assert.deepEqual(preview.added.map((item) => item.service), ['redis']);
  assert.ok(preview.changed.some((item) => item.service === 'web'));
  assert.ok(preview.removed.length === 0);
  assert.ok(!preview.changed.some((item) => item.service === 'db'));
});

test('compose-preview: 相同配置和仅格式变化不误报重建', () => {
  const before = 'services:\n  web:\n    image: nginx:alpine\n    environment:\n      MODE: production\n    ports: ["8080:80"]\n';
  const after = 'services: { web: { ports: ["8080:80"], environment: { MODE: production }, image: nginx:alpine } }';
  const preview = previewComposeChange(after, { containers: [{ service: 'web', name: 'custom-name', state: 'running' }] }, before);
  assert.equal(preview.basis, 'saved-file');
  assert.deepEqual(preview.changed, []);
  assert.deepEqual(preview.restarted, []);
  assert.deepEqual(preview.added, []);
  assert.deepEqual(preview.removed, []);
});

test('compose-preview: 只报告真实变化的字段，使用 Compose service 标签关联自定义容器名', () => {
  const before = 'services:\n  api:\n    image: nginx:alpine\n    environment: { MODE: production }\n    ports: ["8080:80"]\n';
  const after = before.replace('production', 'development');
  const preview = previewComposeChange(after, { projectName: 'my-app', containers: [{ service: 'api', name: 'custom-api', state: 'running' }] }, before);
  assert.deepEqual(preview.changed, [{ service: 'api', reasons: ['环境变量'], container: 'custom-api', state: 'running' }]);
});

test('compose-preview: override 文件省略其他文件的服务不等于删除', () => {
  const before = 'services: { web: { environment: { MODE: production } } }';
  const project = { containers: [{ service: 'web', name: 'site-web-1' }, { service: 'db', name: 'site-db-1' }] };
  const preview = previewComposeChange(before.replace('production', 'development'), project, before);
  assert.deepEqual(preview.removed, []);
  assert.deepEqual(preview.added, []);
  assert.deepEqual(preview.changed.map(item => item.service), ['web']);
});

test('compose-preview: 未运行服务的删除和字段移除仍被检测', () => {
  const before = 'services: { web: { image: nginx, restart: always }, db: { image: postgres } }';
  const after = 'services: { web: { image: nginx } }';
  const preview = previewComposeChange(after, { containers: [] }, before);
  assert.deepEqual(preview.removed.map(item => item.service), ['db']);
  assert.deepEqual(preview.changed[0].reasons, ['重启策略']);
  assert.deepEqual(preview.restarted, []);
});

test('compose-preview: 含连字符的项目名不会把现有服务误认成新增', () => {
  const project = { projectName: 'my-test-app', containers: [{ name: 'my-test-app-api-worker-1', image: 'node:22', state: 'running' }] };
  const preview = previewComposeChange('services: { api-worker: { image: "node:22" } }', project);
  assert.deepEqual(preview.added, []);
  assert.deepEqual(preview.removed, []);
  assert.deepEqual(preview.changed, []);
});

test('compose-preview: 无效 YAML 不得伪装成无变化的成功预览', () => {
  assert.throws(() => previewComposeChange('services: [broken', { containers: [] }, 'services: {}'));
});
