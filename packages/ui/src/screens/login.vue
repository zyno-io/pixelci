<template>
    <div id="login" class="auth-page">
        <div class="theme-corner"><ThemeMenu /></div>
        <div class="card auth-card">
            <span class="auth-mark" aria-hidden="true"><i class="fa-solid fa-border-all" /></span>
            <h1>PixelCI</h1>
            <p class="subtitle">Sign in to review your visual tests.</p>

            <div v-if="errorMessage" class="notice danger" role="alert">
                <i class="fa-solid fa-circle-exclamation" aria-hidden="true" />
                <div class="notice-body">{{ errorMessage }}</div>
            </div>

            <label v-if="needsSetupToken" class="setup-token">
                Setup token (optional)
                <input class="input" v-model="setupTokenInput" type="password" autocomplete="off" />
                <small>No admin exists yet. Enter the server's SETUP_TOKEN to become the first admin.</small>
            </label>

            <button v-for="provider in providers" :key="provider.id" class="btn primary" @click="login(provider)">
                <i :class="providerIcon(provider)" aria-hidden="true" />
                Login via {{ provider.name }}
            </button>
        </div>
    </div>

    <LoaderModal v-if="isLoading" size="2xl" />
</template>

<script lang="ts" setup>
import { dataFrom, dataFromAsync, OpenApiError } from '@zyno-io/openapi-client-codegen';
import { handleErrorAndAlert } from '@zyno-io/vue-foundation';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { LOCAL_STORAGE_AUTH_KEY } from '@/openapi-client';
import { type ISessionProvider, SessionApi } from '@/openapi-client-generated';
import { clearSetupToken, SETUP_TOKEN_STORAGE_KEY } from '@/setup-token';
import LoaderModal from '@/shared/components/loader-modal.vue';
import ThemeMenu from '@/shared/components/theme-menu.vue';
import { useStore } from '@/store';

const OAUTH_STATE_STORAGE_KEY = 'pixelci:oauthState';

const store = useStore();
const route = useRoute();
const router = useRouter();
const isLoading = ref(true);
const providers = ref<ISessionProvider[]>();
const targetPath = ref<string>();
const errorMessage = ref<string>();
// true while setup is enabled but no admin exists yet: the user may type the SETUP_TOKEN to claim the first admin role
const needsSetupToken = ref(false);
const setupTokenInput = ref('');
// set when arriving with an error or a failed callback, so we show the picker instead of redirecting again
const suppressAutoLogin = ref(false);

function providerIcon(provider: ISessionProvider) {
    return provider.platform === 'github' ? 'fa-brands fa-github' : 'fa-brands fa-gitlab';
}

async function login(provider: ISessionProvider) {
    try {
        isLoading.value = true;

        if (setupTokenInput.value) {
            try {
                // survives the provider redirect; processCode sends it with the login and clears it
                sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, setupTokenInput.value);
            } catch {
                // sessionStorage unavailable
            }
        } else {
            // an emptied (or hidden) field must not leave a stale token to be sent with this login
            clearSetupToken();
        }

        const { url, state } = await dataFromAsync(
            SessionApi.getSessionGetProviderLoginUrl({
                path: { id: provider.id },
                query: { returnTo: location.pathname + location.search }
            })
        );

        // Ties the callback to this browser: processCode refuses a state that wasn't issued here (login CSRF).
        try {
            sessionStorage.setItem(OAUTH_STATE_STORAGE_KEY, state);
        } catch {
            // sessionStorage unavailable; processCode will refuse the callback
        }

        location.href = url;
    } catch (err) {
        handleErrorAndAlert(err);
        isLoading.value = false;
    }
}

function readStoredState(): string | undefined {
    try {
        return sessionStorage.getItem(OAUTH_STATE_STORAGE_KEY) ?? undefined;
    } catch {
        return undefined;
    }
}

function clearStoredState() {
    try {
        sessionStorage.removeItem(OAUTH_STATE_STORAGE_KEY);
    } catch {
        // sessionStorage unavailable
    }
}

async function processCode(code: string) {
    try {
        const callbackState = typeof route.query.state === 'string' ? route.query.state : undefined;
        const storedState = readStoredState();

        router.replace({ path: '/login', query: {} });

        if (!callbackState || !storedState || callbackState !== storedState) {
            // No state (e.g. GitHub install-time authorization) or one this browser never issued: never exchange the code.
            clearStoredState();
            suppressAutoLogin.value = true;
            errorMessage.value = callbackState ? 'Sign-in could not be verified. Please try again.' : 'GitHub App installed — sign in to continue.';
            return loadSession();
        }

        let setupToken: string | undefined;
        try {
            setupToken = sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY) ?? undefined;
        } catch {
            // sessionStorage unavailable
        }
        const { jwt, returnTo } = await dataFromAsync(
            SessionApi.postSessionLogin({
                body: {
                    code,
                    setupToken,
                    state: callbackState
                }
            })
        );
        clearStoredState();
        clearSetupToken();
        targetPath.value = returnTo;
        localStorage.setItem(LOCAL_STORAGE_AUTH_KEY, jwt);
        loadSession();
    } catch (err) {
        handleErrorAndAlert(err);
        clearStoredState();
        // Don't auto-redirect back to the provider (it would loop straight back into the same failure);
        // show the provider buttons so the user can retry deliberately.
        suppressAutoLogin.value = true;
        errorMessage.value = 'Sign-in failed. Please try again.';
        return loadSession();
    }
}

async function load() {
    const queryError = route.query.error;
    if (queryError) {
        const description = route.query.error_description;
        errorMessage.value = (typeof description === 'string' && description) || (typeof queryError === 'string' ? queryError : 'Login failed.');
        suppressAutoLogin.value = true;
        router.replace({ path: '/login', query: {} });
        return loadSession();
    }

    if (route.query.code) {
        return processCode(route.query.code as string);
    }

    return loadSession();
}

async function loadSession() {
    try {
        const identityResponse = await SessionApi.getSessionGetIdentity();
        store.sessionUser = dataFrom(identityResponse);
        store.showProviderPicker = false;
        if (route.path === '/login') {
            router.replace(targetPath.value ?? '/');
        }
        return;
    } catch (err) {
        if (!(err instanceof OpenApiError && err.response?.status === 401)) {
            return handleErrorAndAlert(err);
        }
    }

    try {
        providers.value = await dataFromAsync(SessionApi.getSessionGetProviders());
    } catch (err) {
        return handleErrorAndAlert(err);
    }

    try {
        const status = await dataFromAsync(SessionApi.getSessionGetOnboardingStatus());
        needsSetupToken.value = status.setupEnabled && !status.hasAdmin;
        if (needsSetupToken.value) {
            try {
                setupTokenInput.value = sessionStorage.getItem(SETUP_TOKEN_STORAGE_KEY) ?? '';
            } catch {
                // sessionStorage unavailable
            }
        }
    } catch {
        // the field is optional; carry on without it
    }

    // with a single provider, skip the picker and go straight to it (unless the setup token may need to be typed first)
    if (providers.value.length === 1 && !suppressAutoLogin.value && !needsSetupToken.value && !store.showProviderPicker) {
        return login(providers.value[0]);
    }

    isLoading.value = false;
}

onMounted(() => {
    router.isReady().then(load);
});
</script>
