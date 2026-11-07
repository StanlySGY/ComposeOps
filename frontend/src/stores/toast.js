import { defineStore } from 'pinia';
import { userError } from '../lib/user-error.js';

let seq = 0;
const MAX_VISIBLE = 3;

export const useToastStore = defineStore('toast', {
  state: () => ({
    items: [],
    _timers: new Map(),
  }),
  getters: {
    visible: (state) => state.items.slice(0, MAX_VISIBLE),
  },
  actions: {
    push(type, message, duration = 3500) {
      const id = ++seq;
      const localized = type === 'error' ? userError(message) : null;
      const details = localized?.details || '';
      message = localized?.message || String(message);
      if (type === 'error' && duration === 3500) duration = 8000;
      this.items.push({ id, type, message, details, duration, leaving: false });
      if (this.items.length > MAX_VISIBLE + 2) this.items.shift();
      this._scheduleDismiss(id, duration);
      return id;
    },
    success(message, duration) { return this.push('success', message, duration); },
    error(message, duration) { return this.push('error', message, duration); },
    info(message, duration) { return this.push('info', message, duration); },
    warning(message, duration) { return this.push('warning', message, duration); },
    _scheduleDismiss(id, duration) {
      clearTimeout(this._timers.get(id));
      const timer = setTimeout(() => this.dismiss(id), duration);
      this._timers.set(id, timer);
    },
    pause(id) { clearTimeout(this._timers.get(id)); },
    resume(id, duration = 3500) { this._scheduleDismiss(id, duration); },
    dismiss(id) {
      const item = this.items.find((t) => t.id === id);
      if (!item) return;
      clearTimeout(this._timers.get(id));
      this._timers.delete(id);
      item.leaving = true;
      // 离场动画结束后才真正移除；无动画时兜底立即移除
      setTimeout(() => { this.items = this.items.filter((t) => t.id !== id); }, 200);
    },
  },
});