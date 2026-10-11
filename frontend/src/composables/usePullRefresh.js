import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue';

/** App.vue 在移动端下拉到阈值时派发的全局刷新事件名。 */
export const PULL_REFRESH_EVENT = 'composeops:refresh';

function isEnabled(enabled) {
  if (enabled == null) return true;
  if (typeof enabled === 'function') return !!enabled();
  return !!enabled.value;
}

/**
 * 下拉刷新订阅器。
 *
 * App.vue 的 <main> 监听触屏下拉并在松手时派发 PULL_REFRESH_EVENT,
 * 各页面在这里登记自己的 loader,并在卸载/失活时摘掉监听,避免残留回调泄漏。
 * keep-alive 页面必须传 keepAlive:true —— 这类页面切走时不会 unmount,
 * 只在 onActivated/onDeactivated 之间来回,监听需要跟着重新登记。
 *
 * @param {() => void | Promise<void>} handler               页面自己的加载函数
 * @param {object} [opts]
 * @param {boolean | import('vue').Ref<boolean> | (() => boolean)} [opts.enabled] 附加条件,如"编辑器有未保存改动时不刷新"
 * @param {boolean} [opts.keepAlive=false]                  页面是否在 App.vue 的 keep-alive 白名单内
 */
export function usePullRefresh(handler, { enabled, keepAlive = false } = {}) {
  let active = false;

  function onPullRefresh() {
    if (!active || !isEnabled(enabled)) return;
    try {
      const result = handler();
      // loader 抛错不应影响同页其它监听,也不留下未处理的 rejection。
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* 单个页面的刷新失败由页面自身的错误提示兜底 */
    }
  }

  function subscribe() {
    if (active) return;
    active = true;
    window.addEventListener(PULL_REFRESH_EVENT, onPullRefresh);
  }

  function unsubscribe() {
    if (!active) return;
    active = false;
    window.removeEventListener(PULL_REFRESH_EVENT, onPullRefresh);
  }

  onMounted(subscribe);
  onBeforeUnmount(unsubscribe);
  if (keepAlive) {
    onActivated(subscribe);
    onDeactivated(unsubscribe);
  }

  return { subscribe, unsubscribe };
}
