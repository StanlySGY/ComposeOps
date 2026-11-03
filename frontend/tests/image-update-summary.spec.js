import { describe, expect, it } from 'vitest';
import { buildImageUpdateSummary } from '../src/lib/image-update-summary.js';

describe('buildImageUpdateSummary', () => {
  it('does not report needs_policy services as unreachable registries', () => {
    const summary = buildImageUpdateSummary([
      { projectName: 'composeops', hasUpdate: false, images: [{ service: 'app', status: 'needs_policy', reachable: false }] },
      { projectName: 'content-factory', hasUpdate: true, images: [{ service: 'postgres', status: 'updated', hasUpdate: true, reachable: true }] },
      { projectName: 'axonhub', hasUpdate: false, images: [{ service: 'api', status: 'current', reachable: true }] },
      { projectName: 'wechat-ai', hasUpdate: true, images: [
        { service: 'redis', status: 'updated', hasUpdate: true, reachable: true },
        { service: 'app', status: 'needs_policy', reachable: false },
        { service: 'tools', status: 'needs_policy', reachable: false },
      ] },
    ]);
    expect(summary).toBe('镜像检查完成：4 个项目，2 个项目有更新，3 个服务需明确设置 pull_policy');
    expect(summary).not.toContain('仓库探测失败');
  });

  it('reports registry and compose configuration failures separately', () => {
    const summary = buildImageUpdateSummary([
      { hasUpdate: false, images: [
        { service: 'db', status: 'failed', registry: 'docker.io', error: 'timeout' },
        { service: 'Compose 文件', status: 'failed', error: 'invalid yaml' },
        { service: 'templated', status: 'unresolved' },
      ] },
    ]);
    expect(summary).toContain('1 个仓库探测失败');
    expect(summary).toContain('1 项配置检查失败');
    expect(summary).toContain('1 个镜像引用需人工确认');
  });

  it('handles empty or malformed results without throwing', () => {
    expect(buildImageUpdateSummary()).toBe('镜像检查完成：0 个项目，0 个项目有更新');
    expect(buildImageUpdateSummary([{ hasUpdate: true, images: null }]))
      .toBe('镜像检查完成：1 个项目，1 个项目有更新');
  });
});
