import { installPreviewTransport } from './transport.js';
import '../src/style.css';
import './preview.css';

installPreviewTransport();
const oldRoutes = { '#overview': '/dashboard', '#services': '/services', '#agent': '/agent', '#backups': '/resources' };
if (oldRoutes[location.hash]) location.replace('#' + oldRoutes[location.hash]);
// Load the production application only after installing the offline transport.
const [{ createApp }, { createPinia }, { default: router }, { default: PreviewApp }] = await Promise.all([
  import('vue'), import('pinia'), import('../src/router.js'), import('./PreviewApp.vue'),
]);
const app = createApp(PreviewApp);
app.use(createPinia());
app.use(router);
app.config.errorHandler = (error, _instance, info) => {
  console.error('[ComposeOps preview]', info, error);
  window.dispatchEvent(new CustomEvent('composeops:runtime-error', { detail: { message: error.message } }));
};
app.mount('#app');
