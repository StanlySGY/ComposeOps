// 在样式与 Vue 加载前设置主题；外部脚本兼容默认 CSP，避免刷新时闪过暗色。
(() => {
  let preference = 'dark';
  try { preference = localStorage.getItem('composeops:theme') || 'dark'; } catch { /* 浏览器可能禁止存储 */ }
  if (!['light', 'dark', 'system'].includes(preference)) preference = 'dark';
  const dark = preference === 'dark' || (preference === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = root.dataset.theme;
  root.classList.toggle('dark', !!dark);
})();
