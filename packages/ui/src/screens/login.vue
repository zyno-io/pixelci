<template>
    <div id="login" class="auth-page">
        <div class="theme-corner"><ThemeMenu /></div>
        <div class="card auth-card">
            <span class="auth-mark" aria-hidden="true"><i class="fa-solid fa-border-all" /></span>
            <h1>PixelCI</h1>
            <p class="subtitle">Sign in to review your visual tests.</p>

            <button v-for="provider in providers" :key="provider.id" class="btn primary" @click="login(provider)">
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
import LoaderModal from '@/shared/components/loader-modal.vue';
import ThemeMenu from '@/shared/components/theme-menu.vue';
import { useStore } from '@/store';

const store = useStore();
const route = useRoute();
const router = useRouter();
const isLoading = ref(true);
const providers = ref<ISessionProvider[]>();
const targetPath = ref<string>();

async function login(provider: ISessionProvider) {
    try {
        isLoading.value = true;

        const { url } = await dataFromAsync(
            SessionApi.getSessionGetProviderLoginUrl({
                path: { id: provider.id },
                query: {
                    redirectUri: `${window.location.origin}/login`,
                    state: btoa(JSON.stringify({ path: location.pathname, providerId: provider.id }))
                }
            })
        );

        location.href = url;
    } catch (err) {
        handleErrorAndAlert(err);
        isLoading.value = false;
    }
}

async function processCode(code: string) {
    try {
        const state = JSON.parse(atob(route.query.state as string));

        router.replace({ path: '/login', query: {} });

        const { jwt } = await dataFromAsync(
            SessionApi.postSessionLogin({
                body: {
                    code,
                    providerId: state.providerId,
                    redirectUri: `${window.location.origin}/login`
                }
            })
        );
        targetPath.value = state.path;
        localStorage.setItem(LOCAL_STORAGE_AUTH_KEY, jwt);
        loadSession();
    } catch (err) {
        handleErrorAndAlert(err);
        isLoading.value = false;
    }
}

async function load() {
    if (route.query.code) {
        return processCode(route.query.code as string);
    }

    return loadSession();
}

async function loadSession() {
    try {
        const identityResponse = await SessionApi.getSessionGetIdentity();
        store.sessionUser = dataFrom(identityResponse);
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

    // with a single provider, skip the picker and go straight to it
    if (providers.value.length === 1) {
        return login(providers.value[0]);
    }

    isLoading.value = false;
}

onMounted(() => {
    router.isReady().then(load);
});
</script>
