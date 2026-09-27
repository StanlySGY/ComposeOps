import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composeops-marketplace-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { createCustomTemplate, updateCustomTemplate, getCustomTemplates } = await import('../src/services/marketplace.js');

test('marketplace: 拒绝非法 YAML、缺少 services 与 Compose 语义错误', async () => {
  await assert.rejects(
    createCustomTemplate({ name: 'bad-yaml', defaultCompose: 'services:\n  web: [' }),
    (error) => error.code === 'YAML_PARSE_ERROR',
  );
  await assert.rejects(
    createCustomTemplate({ name: 'no-services', defaultCompose: 'name: only' }),
    (error) => error.statusCode === 422 && /services/.test(error.message),
  );
  await assert.rejects(
    createCustomTemplate({ name: 'bad-depends', defaultCompose: 'services:\n  web:\n    image: nginx\n    depends_on: [missing]' }),
    (error) => error.statusCode === 422 && /depends_on/.test(error.message),
  );
});

test('marketplace: 创建与更新都执行同一套模板校验', async () => {
  const template = await createCustomTemplate({
    name: 'valid-template',
    category: 'Tools',
    defaultCompose: 'services:\n  web:\n    image: nginx:alpine',
  });
  assert.equal(template.author, 'user');
  await assert.rejects(
    updateCustomTemplate(template.id, { defaultCompose: 'services:\n  web:\n    image: nginx\n    links: [missing]' }),
    (error) => error.statusCode === 422,
  );
  const stored = await getCustomTemplates();
  assert.equal(stored.find((item) => item.id === template.id).defaultCompose, template.defaultCompose);
});
