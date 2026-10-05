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

app.mount('#app');
