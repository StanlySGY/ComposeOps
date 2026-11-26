import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router.js';
import './style.css';
import { initializeTheme } from './lib/theme.js';

initializeTheme();

const app = createApp(App);
app.use(createPinia());
app.use(router);

// 全局未捕获错误:避免静默失败,统一走 toast/控制台
app.config.errorHandler = (error, _instance, info) => {
  console.error('[ComposeOps]', info, error);
  window.dispatchEvent(new CustomEvent('composeops:runtime-error', { detail: { message: error?.message || String(error) } }));
};

app.mount('#app');
