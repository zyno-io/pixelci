<template>
    <div id="onboarding" class="auth-page">
        <div class="theme-corner"><ThemeMenu /></div>
        <div class="card auth-card">
            <span class="auth-mark" aria-hidden="true"><i class="fa-solid fa-border-all" /></span>
            <h1>Welcome to PixelCI</h1>
            <p class="subtitle">Let's set up your first VCS integration to get started.</p>

            <form @submit.prevent="submit">
                <label>
                    Integration Name
                    <input class="input" v-model="form.name" type="text" placeholder="e.g. My GitLab" required />
                </label>

                <label>
                    Platform
                    <select class="select" v-model="form.platform" required>
                        <option value="gitlab">GitLab</option>
                    </select>
                </label>

                <label>
                    GitLab URL
                    <input class="input" v-model="form.url" type="url" placeholder="https://gitlab.example.com" required />
                </label>

                <label>
                    Client ID
                    <input class="input" v-model="form.clientId" type="text" required />
                </label>

                <label>
                    Client Secret
                    <input class="input" v-model="form.clientSecret" type="text" required />
                </label>

                <div class="redirect-url">
                    <span class="redirect-label">OAuth Redirect URI</span>
                    <code>{{ redirectUrl }}</code>
                    <button type="button" class="btn copy-btn" @click="copyRedirectUrl"><i class="fa fa-copy" /> Copy</button>
                    <p class="hint">Use this URL as the redirect URI when configuring your GitLab OAuth application.</p>
                </div>

                <button type="submit" class="btn primary" :disabled="isSubmitting">
                    {{ isSubmitting ? 'Creating...' : 'Create Integration' }}
                </button>
            </form>
        </div>
    </div>
</template>

<script lang="ts" setup>
import { dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { handleErrorAndAlert } from '@zyno-io/vue-foundation';
import { computed, reactive, ref } from 'vue';

import { SessionApi } from '@/openapi-client-generated';
import ThemeMenu from '@/shared/components/theme-menu.vue';

const emit = defineEmits<{ complete: [] }>();

const form = reactive({
    name: '',
    platform: 'gitlab' as const,
    url: '',
    clientId: '',
    clientSecret: ''
});

const isSubmitting = ref(false);

const redirectUrl = computed(() => `${window.location.origin}/login`);

async function copyRedirectUrl() {
    await navigator.clipboard.writeText(redirectUrl.value);
}

async function submit() {
    try {
        isSubmitting.value = true;
        await dataFromAsync(
            SessionApi.postSessionCreateOnboardingVcsIntegration({
                body: {
                    name: form.name,
                    platform: form.platform,
                    config: {
                        url: form.url,
                        clientId: form.clientId,
                        clientSecret: form.clientSecret
                    }
                }
            })
        );
        emit('complete');
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isSubmitting.value = false;
    }
}
</script>

<style lang="scss" scoped>
#onboarding .auth-card {
    max-width: 480px;
}
</style>
