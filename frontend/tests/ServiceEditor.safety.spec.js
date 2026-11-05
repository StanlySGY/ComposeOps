import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ServiceEditor from '../src/components/compose/ServiceEditor.vue';

let wrapper;
afterEach(() => { wrapper?.unmount(); wrapper = null; });
const fixture = () => ({
  name: 'web', image: 'node:22', command: ['node', 'server.js'],
  healthcheck: { test: ['CMD', 'node', 'health.js'], interval: '30s' },
  deploy: { resources: { limits: { memory: '512M' } } },
  ports: ['127.0.0.1:8080:80/tcp', 8081],
  volumes: ['/srv/data:/data:ro', '/cache'],
  environment: { MODE: 'production', INHERITED: null, BOOLEAN: false },
  depends_on: { db: { condition: 'service_healthy', restart: true } },
  networks: { internal: { aliases: ['web-api'], ipv4_address: '172.30.0.5' } },
});
function open(value = fixture(), isNew = false) {
  wrapper = mount(ServiceEditor, { props: { modelValue: value, isNew } });
}
async function save() {
  await wrapper.get('button.btn-primary').trigger('click');
  return wrapper.emitted('save')?.at(-1)?.[0]?.service;
}
const serviceOnly = ({ name: _name, ...service }) => service;

describe('可视化编辑保留 Compose 语义', () => {
  it('未修改直接保存完整往返，不补写重启策略也不丢掉高级字段', async () => {
    const original = fixture(); open(original);
    expect(await save()).toEqual(serviceOnly(original));
  });

  it('只改一个环境变量时保留命令、健康检查、依赖条件、网络和其他变量类型', async () => {
    const original = fixture(); open(original);
    await wrapper.get('input[aria-label="第 1 行环境变量值"]').setValue('development');
    const expected = serviceOnly(original);
    expected.environment = { ...expected.environment, MODE: 'development' };
    expect(await save()).toEqual(expected);
    expect(original.environment.MODE).toBe('production');
  });

  it('修改简单映射时保留地址、协议、只读模式和其他原始行', async () => {
    const original = fixture(); open(original);
    expect(wrapper.get('input[aria-label="第 1 行端口映射 · 宿主机端口"]').element.value).toBe('127.0.0.1:8080');
    await wrapper.get('input[aria-label="第 1 行端口映射 · 宿主机端口"]').setValue('127.0.0.1:9090');
    const result = await save();
    expect(result.ports).toEqual(['127.0.0.1:9090:80/tcp', 8081]);
    expect(result.volumes).toEqual(original.volumes);
  });

  it('长语法端口和卷使用明确只读提示，修改其他字段后完整保留', async () => {
    const original = { ...fixture(), ports: [{ target: 80, published: '8080', host_ip: '127.0.0.1', protocol: 'udp' }], volumes: [{ type: 'bind', source: '/data', target: '/app', read_only: true }] };
    open(original);
    expect(wrapper.text()).toContain('包含高级端口配置');
    expect(wrapper.text()).toContain('包含高级卷配置');
    await wrapper.get('#compose-service-image').setValue('node:24');
    expect(await save()).toEqual({ ...serviceOnly(original), image: 'node:24' });
  });

  it('依赖和网络增加名称时保留已有对象的健康条件和别名', async () => {
    const original = fixture(); open(original);
    expect(wrapper.get('#compose-service-depends-on').element.value).toBe('db');
    await wrapper.get('#compose-service-depends-on').setValue('db, cache');
    await wrapper.get('#compose-service-networks').setValue('internal, frontend');
    const result = await save();
    expect(result.depends_on).toEqual({ ...original.depends_on, cache: { condition: 'service_started' } });
    expect(result.networks).toEqual({ ...original.networks, frontend: null });
  });

  it('数组环境变量保持无等号继承语义和包含等号的值', async () => {
    open({ name: 'web', image: 'node:22', environment: ['INHERITED', 'URL=a=b', 'MODE=production'] });
    await wrapper.get('input[aria-label="第 3 行环境变量值"]').setValue('development');
    expect((await save()).environment).toEqual(['INHERITED', 'URL=a=b', 'MODE=development']);
  });

  it('从已有服务切换到新增时清除旧字段，空名称提交会被阻止', async () => {
    open();
    await wrapper.setProps({ modelValue: null, isNew: true });
    expect(wrapper.get('#compose-service-image').element.value).toBe('');
    expect(await save()).toBeUndefined();
    expect(wrapper.get('[role="alert"]').text()).toContain('服务名称');
    await wrapper.get('#compose-service-name').setValue('new-service');
    await wrapper.get('#compose-service-image').setValue('nginx:alpine');
    expect(await save()).toEqual({ image: 'nginx:alpine', restart: 'unless-stopped' });
  });
});
