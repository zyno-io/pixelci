<template>
    <div id="app">
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
import { OverlayContainer } from '@zyno-io/vue-foundation';
import { onMounted, ref } from 'vue';

import { dataFrom } from '@zyno-io/openapi-client-codegen';
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
        const { isOnboarded: status } = dataFrom(await SessionApi.getSessionGetOnboardingStatus());
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
@use './shared/styles/base.scss' as *;
@reference "tailwindcss";

#app {
    @apply flex-1 flex;
}

#global-error {
    @apply flex-1 flex justify-center items-center bg-gray-800 text-2xl text-red-300;
}
</style>
