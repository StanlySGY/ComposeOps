import { computed, readonly, ref } from 'vue';

const STORAGE_KEY = 'composeops:theme';
const normalize = value => ['light', 'dark', 'system'].includes(value) ? value : 'dark';
const preference = ref('dark');
const resolvedTheme = ref('dark');
let media;
let stop;

function readPreference() {
  try { return normalize(localStorage.getItem(STORAGE_KEY)); } catch { return 'dark'; }
}

function applyTheme() {
  resolvedTheme.value = preference.value === 'system' ? (media?.matches ? 'dark' : 'light') : preference.value;
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme.value;
  root.style.colorScheme = resolvedTheme.value;
  root.classList.toggle('dark', resolvedTheme.value === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolvedTheme.value === 'dark' ? '#101319' : '#f3f6fa');
}

export function initializeTheme() {
  if (stop) return stop;
  media = window.matchMedia?.('(prefers-color-scheme: dark)');
  preference.value = readPreference();
  applyTheme();
  const onSystemChange = () => { if (preference.value === 'system') applyTheme(); };
  const onStorage = event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    preference.value = readPreference();
    applyTheme();
  };
  media?.addEventListener('change', onSystemChange);
  window.addEventListener('storage', onStorage);
  stop = () => {
    media?.removeEventListener('change', onSystemChange);
    window.removeEventListener('storage', onStorage);
    media = undefined;
    stop = undefined;
  };
  return stop;
}

export function setTheme(value) {
  initializeTheme();
  preference.value = normalize(value);
  // 即使隐私模式禁用持久化，本次切换仍然生效。
  try { localStorage.setItem(STORAGE_KEY, preference.value); } catch { /* best effort */ }
  applyTheme();
}

export function useTheme() {
  initializeTheme();
  return { themePreference: readonly(preference), resolvedTheme: readonly(resolvedTheme), setTheme };
}

const terminalPalettes = {
  light: {
    background: '#ffffff', foreground: '#1e293b', cursor: '#1d4ed8', cursorAccent: '#ffffff', selectionBackground: '#bfdbfe',
    black: '#1e293b', red: '#b91c1c', green: '#047857', yellow: '#92400e', blue: '#1d4ed8', magenta: '#7e22ce', cyan: '#0e7490', white: '#64748b',
    brightBlack: '#526277', brightRed: '#b91c1c', brightGreen: '#047857', brightYellow: '#92400e', brightBlue: '#1d4ed8', brightMagenta: '#7e22ce', brightCyan: '#0e7490', brightWhite: '#334155',
  },
  dark: {
    background: '#0b0d10', foreground: '#e5e7eb', cursor: '#38bdf8', cursorAccent: '#0b0d10', selectionBackground: '#334155',
    black: '#0f131c', red: '#ef4444', green: '#6ee7b7', yellow: '#e9a568', blue: '#38bdf8', magenta: '#a78bfa', cyan: '#22d3ee', white: '#f3f4f6',
    brightBlack: '#94a3b8', brightRed: '#f87171', brightGreen: '#86efac', brightYellow: '#fcd34d', brightBlue: '#60a5fa', brightMagenta: '#c4b5fd', brightCyan: '#67e8f9', brightWhite: '#ffffff',
  },
};

export function useTerminalTheme() {
  const { resolvedTheme } = useTheme();
  return computed(() => ({ ...terminalPalettes[resolvedTheme.value] }));
}
