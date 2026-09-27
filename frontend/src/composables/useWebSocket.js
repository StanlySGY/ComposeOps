import { getCurrentInstance, isRef, onUnmounted, ref } from 'vue';

/**
 * WebSocket 连接管理 hook,带指数退避自动重连。
 *
 * url 支持 string / ref / getter:传 getter 时可在 setup 阶段创建一次实例,
 * 之后参数(项目、容器、tail)变化直接调用 connect() 复用同一实例。
 *
 * @param {string|import('vue').Ref<string>|(() => string)} url
 * @param {Object} options
 * @param {Function} options.onMessage - 消息回调
 * @param {Function} options.onOpen - 连接建立回调,收到 { resumed } 标记是否为重连恢复
 * @param {Function} options.onError - 错误回调
 * @param {Function} options.onClose - 被动关闭回调(主动 close() 不触发)
 * @param {string} options.binaryType - 二进制帧类型,如 'arraybuffer'
 * @param {number} options.reconnectDelay - 首次重连延迟(ms),默认 2000,逐次翻倍
 * @param {number} options.maxReconnectDelay - 重连延迟上限(ms),默认 15000
 * @param {number} options.maxReconnectAttempts - 最大重连次数,默认 5,设为 0 禁用重连
 */
export function useWebSocket(url, options = {}) {
  const {
    onMessage,
    onOpen,
    onError,
    onClose,
    binaryType,
    reconnectDelay = 2000,
    maxReconnectDelay = 15000,
    maxReconnectAttempts = 5,
  } = options;

  const ws = ref(null);
  const connected = ref(false);
  const reconnecting = ref(false);
  const reconnectAttempts = ref(0);
  let reconnectTimer = null;
  let intentionallyClosed = false;
  let activeErrorHandler = typeof onError === 'function' ? onError : null;

  function setErrorHandler(handler) {
    activeErrorHandler = typeof handler === 'function' ? handler : null;
  }

  function resolveUrl() {
    if (typeof url === 'function') return url();
    if (isRef(url)) return url.value;
    return url;
  }

  function clearTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function open() {
    const target = resolveUrl();
    if (!target) return;
    let socket;
    try {
      socket = new WebSocket(target);
    } catch (error) {
      if (activeErrorHandler) activeErrorHandler(error);
      return;
    }
    ws.value = socket;
    if (binaryType) socket.binaryType = binaryType;

    socket.onopen = () => {
      connected.value = true;
      reconnecting.value = false;
      const resumed = reconnectAttempts.value > 0;
      reconnectAttempts.value = 0;
      if (onOpen) onOpen({ resumed });
    };

    socket.onmessage = (event) => {
      if (onMessage) onMessage(event);
    };

    socket.onerror = () => {
      if (activeErrorHandler) activeErrorHandler(new Error('WebSocket 连接错误'));
    };

    socket.onclose = (event) => {
      if (ws.value === socket) ws.value = null;
      connected.value = false;
      if (onClose) onClose(event);

      if (intentionallyClosed || maxReconnectAttempts <= 0) {
        reconnecting.value = false;
        return;
      }
      if (reconnectAttempts.value >= maxReconnectAttempts) {
        reconnecting.value = false;
        if (activeErrorHandler) activeErrorHandler(new Error(`连接已断开,重连 ${maxReconnectAttempts} 次仍未成功`));
        return;
      }
      // 指数退避:2s → 4s → 8s …,避免服务端重启期间高频重试
      const delay = Math.min(reconnectDelay * 2 ** reconnectAttempts.value, maxReconnectDelay);
      reconnecting.value = true;
      reconnectAttempts.value += 1;
      clearTimer();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        open();
      }, delay);
    };
  }

  function connect() {
    if (ws.value?.readyState === WebSocket.OPEN || ws.value?.readyState === WebSocket.CONNECTING) return;
    intentionallyClosed = false;
    clearTimer();
    reconnectAttempts.value = 0;
    reconnecting.value = false;
    open();
  }

  function close() {
    intentionallyClosed = true;
    clearTimer();
    reconnecting.value = false;
    reconnectAttempts.value = 0;
    const socket = ws.value;
    ws.value = null;
    connected.value = false;
    if (socket) {
      // 主动关闭不应触发重连
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // 主动关闭阶段 Socket 可能已经由浏览器清理,无需向 UI 报错。
      }
    }
  }

  function send(payload) {
    if (ws.value?.readyState !== WebSocket.OPEN) return false;
    ws.value.send(payload);
    return true;
  }

  // 仅在 setup 上下文中自动清理;函数式调用时由调用方负责 close()
  if (getCurrentInstance()) onUnmounted(close);

  return { ws, connected, reconnecting, reconnectAttempts, setErrorHandler, connect, close, send };
}
