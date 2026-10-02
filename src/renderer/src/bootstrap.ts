import { createApp, type Component } from 'vue';
import { createPinia } from 'pinia';
import { tooltipPlugin } from './components/common/tooltip';
import { installGlobalErrorHandling } from './services/errors';
import './styles/theme.css';
import './styles/base.css';
import './styles/controls.css';
import './styles/utilities.css';

/** Shared renderer entry setup (index.html and testbed.html): global styles, Pinia, v-tooltip, error handling, mount. */
export function mountApp(root: Component): void {
  const app = createApp(root);
  app.use(createPinia());
  app.use(tooltipPlugin);
  installGlobalErrorHandling(app);
  app.mount('#app');
}
