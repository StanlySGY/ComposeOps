import { defineStore } from 'pinia';
import { userError } from '../lib/user-error.js';

let seq = 0;
const MAX_VISIBLE = 3;
const MAX_ITEMS = 50;

export const useToastStore = defineStore('toast', {
  state: () => ({
    items: [],
    _timers: new Map(),
    _hidden: false,
    _visibleLimit: MAX_VISIBLE,
  }),
  getters: {
    visible: (state) => state.items.slice(0, state._visibleLimit),
    queuedCount: (state) => Math.max(0, state.items.length - state._visibleLimit),
  },
  actions: {
    push(type, message, duration = 3500) {
      const id = ++seq;
      const localized = type === 'error' ? userError(message) : null;
      const details = localized?.details || '';
      message = localized?.message || String(message);
      if (type === 'error' && duration === 3500) duration = 8000;
      const lifetime = Number.isFinite(duration) && duration >= 0 ? duration : 3500;
      // Only visible messages consume their reading time. Keep the focused/hovered
      // messages in place even if a burst of operations fills the waiting queue.
      if (this.items.length >= MAX_ITEMS) this.dismiss(this.items[this._visibleLimit].id);
      this.items.push({ id, type, message, details, duration: lifetime, remaining: lifetime, displayDuration: lifetime, displayId: 0, shown: false, startedAt: null, pauses: [], paused: false });
      this._syncTimers();
      return id;
    },
    success(message, duration) { return this.push('success', message, duration); },
    error(message, duration = 8000) { return this.push('error', message, duration); },
    info(message, duration) { return this.push('info', message, duration); },
    warning(message, duration = 5000) { return this.push('warning', message, duration); },
    _stopTimer(item) {
      clearTimeout(this._timers.get(item.id));
      this._timers.delete(item.id);
      if (item.startedAt !== null) item.remaining = Math.max(0, item.remaining - (Date.now() - item.startedAt));
      item.startedAt = null;
    },
    _syncTimers() {
      for (const [index, item] of this.items.entries()) {
        if (index >= this._visibleLimit) {
          this._stopTimer(item);
          item.shown = false;
          item.pauses = item.pauses.filter(reason => reason === 'details');
          continue;
        }
        if (!item.shown) {
          item.displayDuration = item.remaining;
          item.displayId += 1;
          item.shown = true;
        }
        item.paused = this._hidden || item.pauses.length > 0;
        if (item.paused) this._stopTimer(item);
        else if (item.duration > 0 && !this._timers.has(item.id)) {
          item.startedAt = Date.now();
          this._timers.set(item.id, setTimeout(() => this.dismiss(item.id), item.remaining));
        }
      }
    },
    pause(id, reason = 'hover') {
      const item = this.items.find(t => t.id === id);
      if (!item || item.pauses.includes(reason)) return;
      item.pauses.push(reason);
      this._syncTimers();
    },
    resume(id, reason = 'hover') {
      const item = this.items.find(t => t.id === id);
      if (!item) return;
      item.pauses = item.pauses.filter(value => value !== reason);
      this._syncTimers();
    },
    setHidden(hidden) {
      this._hidden = hidden;
      this._syncTimers();
    },
    setVisibleLimit(limit) {
      // Preserve a keyboard user's focused message when narrowing the window.
      if (limit === 1) {
        const focused = this.visible.find(item => item.pauses.includes('focus'));
        if (focused) this.items = [focused, ...this.items.filter(item => item.id !== focused.id)];
      }
      this._visibleLimit = limit === 1 ? 1 : MAX_VISIBLE;
      this._syncTimers();
    },
    dismiss(id) {
      const item = this.items.find((t) => t.id === id);
      if (!item) return;
      this._stopTimer(item);
      // TransitionGroup owns the leaving animation; no delayed removal timer
      // can restart or dismiss a newly promoted message.
      this.items = this.items.filter(t => t.id !== id);
      this._syncTimers();
    },
    clear() {
      for (const item of this.items) this._stopTimer(item);
      this.items = [];
    },
  },
});
