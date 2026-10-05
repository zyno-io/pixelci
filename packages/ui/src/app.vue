<template>
    <div class="app-content">
        <div v-if="globalError" id="global-error" v-text="globalError" />

        <Onboarding v-else-if="isOnboarded === false" @complete="isOnboarded = true" />

        <login v-else-if="!store.sessionUser || $route.path === '/login'" />

        <layout v-else>
            <router-view />
        </layout>

        <OverlayContainer />
    </div>
</template>

<script lang="ts" setup>
import { dataFrom } from '@zyno-io/openapi-client-codegen';
import { OverlayContainer } from '@zyno-io/vue-foundation';
import { onMounted, ref } from 'vue';

import { SessionApi } from './openapi-client-generated';
import Login from './screens/login.vue';
import Onboarding from './screens/onboarding.vue';
import Layout from './shared/components/layout.vue';
import { setupStore, useStore } from './store';

const store = useStore();
const { globalError } = store;

const isOnboarded = ref<boolean | null>(null);

setupStore();

onMounted(async () => {
    try {
        const response = await SessionApi.getSessionGetOnboardingStatus();
        const { isOnboarded: status } = dataFrom(response);
        isOnboarded.value = status;
    } catch {
        isOnboarded.value = true;
    }
});
</script>

<style>
@import 'tailwindcss';
@custom-variant dark (&:where(.dark, .dark *));
</style>

<style lang="scss">
@use './shared/styles/base.scss';
@use './shared/styles/pixelci.scss';

.app-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
}

#global-error {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 18px;
}
</style>
