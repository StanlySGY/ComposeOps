import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChartExport } from '../src/components/charts/useChartExport.js';

function target() {
  const container = document.createElement('div');
  container.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300"><path d="M0,0 L800,300" stroke="blue" /></svg>';
  document.body.append(container);
  return { canvasWrapper: { value: container }, width: 800, height: 300 };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('图表导出的失败反馈', () => {
  it('不支持 Canvas 时明确拒绝，而不是静默等待下载', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(useChartExport().exportToPNG(target())).rejects.toThrow('无法创建图片');
  });
  it('图片解析错误能结束 Promise 并提示替代导出', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({});
    vi.stubGlobal('Image', class { set src(_) { queueMicrotask(() => this.onerror?.()); } });
    await expect(useChartExport().exportToPNG(target())).rejects.toThrow('图片生成失败');
  });
  it('编码返回空数据时给出明确错误，不生成虚假的下载链接', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect() {}, drawImage() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(null));
    vi.stubGlobal('Image', class { set src(_) { queueMicrotask(() => this.onload?.()); } });
    await expect(useChartExport().exportToPNG(target())).rejects.toThrow('无法编码 PNG');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
