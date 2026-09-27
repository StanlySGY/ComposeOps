import { onBeforeUnmount, onMounted } from 'vue';

/**
 * 全局 Vim 风格键盘流。
 * - 仅在「服务列表」主页面启用方向键导航;
 * - 按 ? 打开快捷键速查表;
 * - 在 Input / Textarea / contenteditable / Monaco 聚焦时自动禁用全部快捷键。
 */
const ACTIVE_TAG = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * @param {object} opts
 * @param {import('vue').Ref<boolean>} opts.enabled 页面级开关(通常为所在路由名 === 'services')
 * @param {() => void} [opts.onCheatSheet] 按 ? 的回调
 * @param {() => string[]} opts.getProjectIds 当前可见项目 id 列表(升序顺序即导航顺序)
 * @param {(id: string) => void} opts.onMove 移动选中(滚动到卡片)
 * @param {(action: string) => void} opts.onAction 按键动作:expand | logs | env | compose | webui | restart
 */
export function useKeyboardNavigation({ enabled, onCheatSheet, getProjectIds, onMove, onAction }) {
  let selected = '';
  let lastAction = 0;

  function isTyping(target) {
    if (!target || !target.tagName) return true;
    if (ACTIVE_TAG.has(target.tagName)) return true;
    if (target.isContentEditable || target.getAttribute?.('contenteditable') === 'true') return true;
    if (target.closest?.('.monaco-editor')) return true;
    return false;
  }

  function matchProject(key) {
    const ids = getProjectIds();
    if (!ids.length) return null;
    const index = ids.indexOf(selected);
    if (key !== 'j' && key !== 'ArrowDown' && key !== 'k' && key !== 'ArrowUp') return null;
    // 初始化(未选中任何项目)默认选中第一个;j/↓ 下移,k/↑ 上移
    const targetIndex = index < 0 ? 0 : key === 'j' || key === 'ArrowDown'
      ? Math.min(index + 1, ids.length - 1)
      : Math.max(index - 1, 0);
    selected = ids[targetIndex] || '';
    return selected;
  }

  function onKeydown(event) {
    const key = event.key;
    if (enabled.value !== true) return;
    if (isTyping(event.target)) return;

    if (key === '?') {
      event.preventDefault();
      onCheatSheet?.();
      return;
    }

    // 组合键保护:cmd/ctrl/alt + 其他不拦截
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const ids = getProjectIds();
    if (!ids.length) return;

    if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(key)) {
      event.preventDefault();
      const target = matchProject(key);
      if (target) onMove?.(target);
      return;
    }

    if (['Enter', 'o'].includes(key)) {
      if (!selected) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastAction < 500) return; // 防抖:避免长按 Enter 反复触发
      lastAction = now;
      onAction?.('expand');
      return;
    }

    if (['l', 'e', 'c', 'r', 'w'].includes(key)) {
      if (!selected) return;
      event.preventDefault();
      onAction?.(key);
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown, { capture: true }));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, { capture: true }));

  return {
    reset: () => { selected = ''; },
    get: () => selected,
  };
}
