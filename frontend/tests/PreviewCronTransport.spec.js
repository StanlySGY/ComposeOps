import { beforeEach, describe, expect, it, vi } from 'vitest';

let previewFetch;
beforeEach(async () => {
  vi.resetModules();
  ({ previewFetch } = await import('../preview/transport.js'));
});
async function request(path = '/cron', method = 'GET', body) {
  const response = await previewFetch(new URL('/api/v1' + path, location.href).href, {
    method, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
async function create(extra = {}) {
  return (await request('/cron', 'POST', { name: '演示任务', type: 'images-check', cron: '0 3 * * *', ...extra })).data;
}

describe('预览定时任务沿用真实 API 的读写约定', () => {
  it('创建返回完整任务与默认启用状态，停用时没有下次时间', async () => {
    const enabled = await create();
    expect(enabled).toMatchObject({ name: '演示任务', enabled: true, typeLabel: '镜像更新检查' });
    expect(enabled.nextRunAt).toBeGreaterThan(Date.now());
    expect(await create({ enabled: false })).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('开关返回确认后的任务，编辑其它字段不改变启用状态', async () => {
    const job = await create({ enabled: false });
    const result = await request('/cron/' + job.id, 'PUT', { enabled: true });
    expect(result.data).toMatchObject({ id: job.id, enabled: true, typeLabel: job.typeLabel });
    const edited = await request('/cron/' + job.id, 'PUT', { name: '修改后的任务', cron: '*/15 * * * *', type: 'db-backup' });
    expect(edited.data).toMatchObject({ id: job.id, enabled: true, name: '修改后的任务', cron: '*/15 * * * *', typeLabel: '数据库自动备份' });
    expect((await request()).data.jobs).toEqual([edited.data]);
  });

  it('无效计划或任务类型拒绝整次修改，已有任务可继续编辑', async () => {
    const job = await create();
    expect((await request('/cron/' + job.id, 'PUT', { name: '不应写入', cron: '60 * * * *' })).status).toBe(400);
    expect((await request('/cron/' + job.id, 'PUT', { name: '也不应写入', type: 'unknown' })).status).toBe(400);
    expect((await request()).data.jobs[0]).toMatchObject(job);
  });

  it('编辑不覆盖身份与创建时间，删除后不能再次修改', async () => {
    const job = await create();
    expect((await request('/cron/' + job.id, 'PUT', { id: 'forged', createdAt: 0, name: '保留身份' })).data).toMatchObject({ id: job.id, createdAt: job.createdAt });
    expect((await request('/cron/' + job.id, 'DELETE')).data).toEqual({ ok: true });
    expect((await request('/cron/' + job.id, 'PUT', { enabled: false })).status).toBe(404);
    expect((await request()).data.jobs).toEqual([]);
  });
});
