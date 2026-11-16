import * as Sentry from '@sentry/vue';
import { OpenApiError } from '@zyno-io/openapi-client-codegen';
import { configureVfOpenApiClient, UserError } from '@zyno-io/vue-foundation';

import { client } from './openapi-client-generated/client.gen';
import { useStore } from './store';

export const LOCAL_STORAGE_AUTH_KEY = 'pixelci:jwt';

client.setConfig({
    baseUrl: import.meta.env.VITE_APP_API_URL
});

configureVfOpenApiClient(client, {
    headers() {
        const jwt = localStorage.getItem(LOCAL_STORAGE_AUTH_KEY);
        const authHeader = jwt ? { Authorization: `Bearer ${jwt}` } : {};

        return {
            ...authHeader
            // more headers here
        };
    },

    onError(err) {
        if (err instanceof OpenApiError) {
            if (
                err.response?.status === 400 &&
                err.body &&
                typeof err.body === 'object' &&
                'message' in err.body &&
                typeof err.body.message === 'string' &&
                err.body.message.includes('phoneNumber(invalidPhone)')
            ) {
                return new UserError('The phone number provided is invalid.');
            }

            // a build link that matches no live build + app: an expected miss, login.vue falls back to the picker
            if ((err.response?.status === 400 || err.response?.status === 404) && err.response.url.includes('/api/session/build-provider')) {
                return err;
            }

            if (err.response?.status === 401) {
                localStorage.removeItem(LOCAL_STORAGE_AUTH_KEY);
                useStore().sessionUser = null;
                return err;
            }
        }

        if (!(err instanceof UserError)) {
            Sentry.captureException(err);
        }
    }
});
