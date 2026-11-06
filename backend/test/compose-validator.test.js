import assert from 'node:assert/strict';
import test from 'node:test';
import { validateComposeSemantics, previewComposeChange, createComposeChangePreview } from '../src/services/compose-validator.js';

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

test('compose-preview: service label 优先识别带连字符项目前缀,相同配置不产生伪 diff', () => {
  const project = {
    projectName: 'composeops-ux-demo',
    containers: [
      { name: 'composeops-ux-demo-web-1', service: 'web', state: 'running' },
      { name: 'composeops-ux-demo-cache-1', service: 'cache', state: 'running' },
    ],
  };
  const content = `
services:
  web:
    image: nginx:1.27
  cache:
    image: redis:7
`;
  const preview = previewComposeChange(content, project, { currentContent: content, occupiedPorts: [] });
  assert.deepEqual(preview.added, []);
  assert.deepEqual(preview.removed, []);
  assert.deepEqual(preview.changed, []);
  assert.deepEqual(preview.restarted, []);
  assert.equal(preview.changeAnalysisKnown, true);
  assert.equal(preview.portConflictsKnown, true);
});

test('compose-preview: 仅报告真实 Compose 字段差异、孤儿服务和宿主已占用端口', () => {
  const project = {
    projectName: 'composeops-ux-demo',
    containers: [
      { name: 'composeops-ux-demo-web-1', service: 'web', state: 'running' },
      { name: 'composeops-ux-demo-db-1', service: 'db', state: 'running' },
      { name: 'composeops-ux-demo-old-cache-1', service: 'old-cache', state: 'running' },
    ],
  };
  const currentContent = `
services:
  web:
    image: nginx:1.27
    environment: { FOO: bar }
    ports: ["8080:80"]
  db:
    image: postgres:16
  old-cache:
    image: redis:7
`;
  const newContent = `
services:
  web:
    image: nginx:1.28
    environment: { FOO: baz }
    ports: ["8081:80"]
  db:
    image: postgres:16
  cache:
    image: redis:7
`;
  const preview = previewComposeChange(newContent, project, {
    currentContent,
    occupiedPorts: [{ port: 8081, ip: '0.0.0.0', protocol: 'tcp', name: 'other-api' }],
  });
  assert.deepEqual(preview.added.map((item) => item.service), ['cache']);
  assert.deepEqual(preview.removed.map((item) => item.service), ['old-cache']);
  assert.deepEqual(preview.changed.map((item) => item.service), ['web']);
  assert.deepEqual(preview.changed[0].reasons, ['镜像', '环境变量', '端口映射']);
  assert.deepEqual(preview.restarted.map((item) => item.service), ['web']);
  assert.deepEqual(preview.portConflicts.map((item) => [item.service, item.port, item.holder]), [['web', 8081, 'other-api']]);
});

test('compose-preview: 宿主端口清单不可用时明确标记未知,不声称无冲突', () => {
  const preview = previewComposeChange('services:\n  web:\n    image: nginx', {
    projectName: 'app', containers: [{ name: 'app-web-1', state: 'running' }],
  });
  assert.equal(preview.portConflictsKnown, false);
  assert.equal(preview.changeAnalysisKnown, false);
  assert.deepEqual(preview.portConflicts, []);
  assert.deepEqual(preview.changed, []);
});

test('compose-preview: 宿主端口检测排除目标 Compose 项目自身的已发布端口', async () => {
  const content = 'services:\n  web:\n    image: nginx:1.27\n    ports: ["8080:80"]';
  const preview = await createComposeChangePreview(content, {
    projectName: 'demo', workingDir: '/srv/demo', containers: [],
  }, content, {
    async listContainers() {
      return [
        { Id: 'own-container-id', Labels: { 'com.docker.compose.project': 'demo', 'com.docker.compose.project.working_dir': '/srv/demo' }, Ports: [{ PublicPort: 8080, IP: '0.0.0.0', Type: 'tcp' }] },
        { Id: 'other-container-id', Labels: { 'com.docker.compose.project': 'other' }, Names: ['/other-api'], Ports: [{ PublicPort: 8080, IP: '0.0.0.0', Type: 'tcp' }] },
      ];
    },
  });
  assert.deepEqual(preview.portConflicts.map((item) => item.holder), ['other-api']);
});
