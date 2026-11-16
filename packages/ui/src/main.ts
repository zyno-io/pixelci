import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fortawesome/fontawesome-free/css/all.css';
import '@zyno-io/vue-foundation/dist/vue-foundation.css';
import './openapi-client';
import * as Sentry from '@sentry/vue';
import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './app.vue';
import router from './router';
import { setupVf } from './vf.setup';

const app = createApp(App);

if (import.meta.env.VITE_APP_SENTRY_DSN) {
    Sentry.init({
        app: app,
        dsn: import.meta.env.VITE_APP_SENTRY_DSN,
        environment: import.meta.env.VITE_APP_ENV,
        release: `template-app@${import.meta.env.MODE}-${import.meta.env.VITE_APP_VERSION}`
    });
}

setupVf(app);

const pinia = createPinia();
app.use(pinia);
app.use(router);

// Mount once the first route has resolved: rendering against the router's start location would briefly show the login screen
// on public routes (e.g. /oauth/error), whose provider auto-redirect then navigates away even after the real route renders.
void router.isReady().then(() => app.mount('#app'));
