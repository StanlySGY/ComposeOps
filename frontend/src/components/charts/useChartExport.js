/**
 * useChartExport.js —— 图表数据导出(CSV / PNG)。
 * 从 InteractiveChart.vue 的 exportToCSV / exportToPNG 拆分。
 */
import { ref } from 'vue';

export function useChartExport() {
  const showExportMenu = ref(false);

  function toggleExportMenu() {
    showExportMenu.value = !showExportMenu.value;
  }

  function exportToCSV({ compareMode, visibleDatasets, visiblePoints }) {
    showExportMenu.value = false;
    let csvContent = '';

    if (compareMode && visibleDatasets.length > 0) {
      // Multi-metric CSV
      const headers = ['时间', ...visibleDatasets.map((ds) => `${ds.label} (${ds.unit})`)];
      csvContent = headers.join(',') + '\n';

      const maxLength = Math.max(...visibleDatasets.map((ds) => ds.visibleData.length));
      for (let i = 0; i < maxLength; i++) {
        const row = [];
        const timestamp = visibleDatasets[0]?.visibleData[i]?.timestamp;
        row.push(timestamp ? new Date(timestamp).toLocaleString('zh-CN') : '');

        visibleDatasets.forEach((ds) => {
          const point = ds.visibleData[i];
          row.push(point ? numberValue(point.value).toFixed(2) : '');
        });

        csvContent += row.join(',') + '\n';
      }
    } else {
      // Single-metric CSV
      csvContent = '时间,值\n';
      visiblePoints.forEach((point) => {
        const time = new Date(point.timestamp).toLocaleString('zh-CN');
        csvContent += `${time},${numberValue(point.value).toFixed(2)}\n`;
      });
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `chart-data-${Date.now()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function exportToPNG({ canvasWrapper, width, height }) {
    showExportMenu.value = false;
    const svgElement = canvasWrapper.value?.querySelector('svg');
    if (!svgElement) throw new Error('图表尚未就绪，请稍后重试');

    // Rasterize a self-contained snapshot under the existing data: image policy.
    const snapshot = svgElement.cloneNode(true);
    snapshot.setAttribute('width', width);
    snapshot.setAttribute('height', height);
    snapshot.style.width = `${width}px`;
    snapshot.style.height = `${height}px`;
    const sources = svgElement.querySelectorAll('line, path, rect, circle, text');
    const copies = snapshot.querySelectorAll('line, path, rect, circle, text');
    const presentation = ['stroke', 'stroke-width', 'stroke-dasharray', 'fill', 'opacity', 'font-size', 'font-family'];
    sources.forEach((source, index) => {
      const style = getComputedStyle(source);
      for (const property of presentation) {
        if (source.hasAttribute(property)) continue;
        const value = style.getPropertyValue(property);
        if (value && !value.includes('url(')) copies[index].setAttribute(property, value);
      }
    });
    const svgData = new XMLSerializer().serializeToString(snapshot);
    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器无法创建图片，请尝试导出 CSV');
    const img = new Image();
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); img.onload = null; img.onerror = null; };
      const timer = setTimeout(() => { cleanup(); reject(new Error('图片生成超时，请重试')); }, 10000);
      img.onload = () => { cleanup(); resolve(); };
      img.onerror = () => { cleanup(); reject(new Error('图片生成失败，请重试或导出 CSV')); };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgData)}`;
    });
    ctx.fillStyle = '#0F131C';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('无法编码 PNG 图片，请重试')), 'image/png');
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `chart-${Date.now()}.png`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    try { link.click(); } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  return { showExportMenu, toggleExportMenu, exportToCSV, exportToPNG };
}

function numberValue(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
