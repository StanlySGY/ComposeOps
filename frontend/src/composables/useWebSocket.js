import { getCurrentInstance, isRef, onUnmounted, ref, shallowRef } from 'vue';

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
 * @param {Function} options.prepareUrl - 真正建连前补充动态参数,不改变连接身份
 * @param {string} options.binaryType - 二进制帧类型,如 'arraybuffer'
 * @param {number} options.reconnectDelay - 首次重连延迟(ms),默认 2000,逐次翻倍
 * @param {number} options.maxReconnectDelay - 重连延迟上限(ms),默认 15000
 * @param {number} options.connectTimeout - 握手超时(ms),默认 10000
 * @param {boolean} options.watchNetwork - 监听离线/上线事件,仅需自动恢复的只读流启用
 * @param {number} options.heartbeatInterval - JSON ping/pong 间隔(ms),仅支持该协议的流启用
 * @param {number} options.maxReconnectAttempts - 最大重连次数,默认 5,设为 0 禁用重连
 */
export function useWebSocket(url, options = {}) {
  const {
    onMessage,
    onOpen,
    onError,
    onClose,
    prepareUrl,
    binaryType,
    reconnectDelay = 2000,
    maxReconnectDelay = 15000,
    maxReconnectAttempts = 5,
    connectTimeout = 10000,
    watchNetwork = false,
    heartbeatInterval = 0,
    heartbeatTimeout = 10000,
  } = options;

  const ws = shallowRef(null);
  const connected = ref(false);
  const reconnecting = ref(false);
  const connecting = ref(false);
  const offline = ref(false);
  const reconnectAttempts = ref(0);
  let reconnectTimer = null;
  let connectionTimer = null;
  let heartbeatTimer = null;
  let heartbeatDeadline = null;
  let currentUrl = '';
  let listening = false;
  let intentionallyClosed = false;
  let disposed = false;
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

  function clearConnectionTimer() {
    clearTimeout(connectionTimer);
    connectionTimer = null;
  }
  function clearHeartbeat() {
    clearTimeout(heartbeatTimer);
    clearTimeout(heartbeatDeadline);
    heartbeatTimer = heartbeatDeadline = null;
  }
  function scheduleHeartbeat(socket) {
    if (!heartbeatInterval || ws.value !== socket) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (ws.value !== socket) return;
      heartbeatDeadline = setTimeout(() => {
        if (ws.value !== socket) return;
        detachSocket();
        activeErrorHandler?.(new Error('日志连接无响应，正在重新连接'));
        scheduleReconnect();
      }, heartbeatTimeout);
      try { socket.send(JSON.stringify({ type: 'ping' })); }
      catch {
        detachSocket();
        scheduleReconnect();
      }
    }, heartbeatInterval);
  }

  function detachSocket() {
    clearConnectionTimer();
    clearHeartbeat();
    const socket = ws.value;
    ws.value = null;
    connected.value = false;
    connecting.value = false;
    if (!socket) return;
    socket.onclose = socket.onerror = socket.onopen = socket.onmessage = null;
    try { socket.close(); } catch { /* Already closed by the browser. */ }
  }

  function scheduleReconnect() {
    if (disposed || intentionallyClosed || maxReconnectAttempts <= 0) {
      reconnecting.value = false;
      return;
    }
    if (offline.value) { reconnecting.value = true; return; }
    if (reconnectAttempts.value >= maxReconnectAttempts) {
      reconnecting.value = false;
      activeErrorHandler?.(new Error(`连接已断开,重连 ${maxReconnectAttempts} 次仍未成功，请点击连接重试`));
      return;
    }
    const delay = Math.min(reconnectDelay * 2 ** reconnectAttempts.value, maxReconnectDelay);
    reconnecting.value = true;
    reconnectAttempts.value += 1;
    clearTimer();
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, delay);
  }

  function open() {
    if (disposed || intentionallyClosed) return;
    const target = resolveUrl();
    if (!target) { connecting.value = reconnecting.value = false; return; }
    if (watchNetwork && globalThis.navigator?.onLine === false) {
      offline.value = true;
      connecting.value = false;
      reconnecting.value = maxReconnectAttempts > 0;
      return;
    }
    let socket;
    connecting.value = true;
    currentUrl = target;
    try { socket = new WebSocket(prepareUrl ? prepareUrl(target) : target); }
    catch (error) {
      connecting.value = false;
      activeErrorHandler?.(error);
      scheduleReconnect();
      return;
    }
    ws.value = socket;
    if (binaryType) socket.binaryType = binaryType;
    if (connectTimeout > 0) connectionTimer = setTimeout(() => {
      if (ws.value !== socket) return;
      detachSocket();
      activeErrorHandler?.(new Error('连接超时，请检查网络或服务状态'));
      scheduleReconnect();
    }, connectTimeout);

    socket.onopen = () => {
      if (ws.value !== socket) return;
      clearConnectionTimer();
      connected.value = true;
      connecting.value = reconnecting.value = offline.value = false;
      const resumed = reconnectAttempts.value > 0;
      reconnectAttempts.value = 0;
      scheduleHeartbeat(socket);
      onOpen?.({ resumed });
    };
    socket.onmessage = (event) => {
      if (ws.value !== socket) return;
      if (heartbeatInterval && typeof event.data === 'string') {
        try {
          if (JSON.parse(event.data).type === 'pong') {
            clearHeartbeat();
            scheduleHeartbeat(socket);
            return;
          }
        } catch { /* Ordinary non-JSON frames remain available to the consumer. */ }
      }
      onMessage?.(event);
    };
    socket.onerror = () => {
      if (ws.value === socket) activeErrorHandler?.(new Error('WebSocket 连接错误'));
    };
    socket.onclose = (event) => {
      if (ws.value !== socket) return;
      clearConnectionTimer();
      clearHeartbeat();
      ws.value = null;
      connected.value = connecting.value = false;
      onClose?.(event);
      // onClose may deliberately stop or replace the connection.
      if (!ws.value) scheduleReconnect();
    };
  }

  function onOffline() {
    if (intentionallyClosed || disposed) return;
    offline.value = true;
    clearTimer();
    detachSocket();
    reconnecting.value = maxReconnectAttempts > 0;
  }
  function onOnline() {
    if (intentionallyClosed || disposed || !offline.value) return;
    offline.value = false;
    if (maxReconnectAttempts <= 0) return;
    clearTimer();
    reconnectAttempts.value = 1;
    reconnecting.value = true;
    open();
  }
  function listenNetwork() {
    if (!watchNetwork || listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
  }

  function connect() {
    if (disposed) return;
    const target = resolveUrl();
    if (target === currentUrl && (ws.value?.readyState === WebSocket.OPEN || ws.value?.readyState === WebSocket.CONNECTING)) return;
    detachSocket();
    intentionallyClosed = false;
    listenNetwork();
    clearTimer();
    reconnectAttempts.value = 0;
    reconnecting.value = false;
    offline.value = false;
    open();
  }

  function close() {
    intentionallyClosed = true;
    clearTimer();
    detachSocket();
    reconnecting.value = offline.value = false;
    reconnectAttempts.value = 0;
    if (listening) {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      listening = false;
    }
  }

  function send(payload) {
    if (ws.value?.readyState !== WebSocket.OPEN) return false;
    ws.value.send(payload);
    return true;
  }

  // 仅在 setup 上下文中自动清理;函数式调用时由调用方负责 close()
  if (getCurrentInstance()) onUnmounted(() => { disposed = true; close(); });

  return { ws, connected, connecting, offline, reconnecting, reconnectAttempts, setErrorHandler, connect, close, send };
}
