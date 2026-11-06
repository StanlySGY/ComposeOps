import { onBeforeUnmount, watch } from 'vue';
import { useRoute } from 'vue-router';

/**
 * 轻量 Esc 关闭栈。
 *
 * 各活动弹层按层级权重(modal > drawer > event > command)登记进全局栈;
 * 按下 Esc 时只关闭当前最顶层面板,不会一次全部关闭,与 z-index 视觉层级一致。
 * 路由切换时自动清场,避免切换页面后残留弹层或 body 滚动锁。
 */
const LAYER_WEIGHT = { modal: 40, drawer: 30, event: 20, command: 10 };
const layerStack = []; // 元素: { close, weight },按 weight 降序,同层后开在前
let bodyLockCount = 0;

/**
 * @param {object} opts
 * @param {import('vue').Ref<boolean>} opts.active    弹层是否可见
 * @param {() => void} opts.onClose                   关闭回调,通常置 active=false
 * @param {import('vue').Ref<boolean>} [opts.enabled] 附加开启条件
 * @param {string} [opts.layer='modal']               分层语义:modal | drawer | event | command
 * @param {boolean} [opts.lockBody=false]             打开期间锁定 body 滚动
 */
export function useEscapeKey({ active, onClose, enabled, layer = 'modal', lockBody = false }) {
  const route = useRoute();

  watch(
    active,
    (isOpen) => {
      if (isOpen && (!enabled || enabled.value)) pushLayer();
      else removeLayer();
    },
    { immediate: true }
  );

  function pushLayer() {
    removeLayer(); // 防重
    const weight = LAYER_WEIGHT[layer] ?? 0;
    const entry = { close: onClose, weight };
    // 从栈底到栈顶按 weight 递增;栈顶(last)为当前最应响应的面板
    const index = layerStack.findIndex((item) => item.weight > weight);
    if (index === -1) layerStack.push(entry);
    else layerStack.splice(index, 0, entry);
    if (lockBody) lockBodyScroll(true);
  }
  function removeLayer() {
    const index = layerStack.findIndex((item) => item.close === onClose);
    if (index < 0) return;
    layerStack.splice(index, 1);
    if (lockBody) lockBodyScroll(false);
  }

  function onKeydown(event) {
    if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || !layerStack.length) return;
    const top = layerStack[layerStack.length - 1];
    if (top.close !== onClose) return; // 只处理栈顶
    event.preventDefault();
    onClose();
  }
  window.addEventListener('keydown', onKeydown);

  watch(
    // route 在无 router 上下文(纯函数式调用/单测)时为 undefined,防御性可选
    () => route?.fullPath,
    () => {
      if (active.value) onClose();
      else removeLayer();
    }
  );

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
    removeLayer();
  });
}

/** 锁定/解锁 body 滚动;计数方式支持多弹层叠加,全部关闭后才恢复。 */
function lockBodyScroll(lock) {
  bodyLockCount = Math.max(0, bodyLockCount + (lock ? 1 : -1));
  document.body.style.overflow = bodyLockCount > 0 ? 'hidden' : '';
}
