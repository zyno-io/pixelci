<template>
    <div id="onboarding" class="auth-page">
        <div class="theme-corner"><ThemeMenu /></div>
        <div class="card auth-card">
            <span class="auth-mark" aria-hidden="true"><i class="fa-solid fa-border-all" /></span>
            <h1>Welcome to PixelCI</h1>
            <p class="subtitle">Let's set up your first VCS integration to get started.</p>

            <p v-if="!setupEnabled" class="subtitle" role="alert">
                First-run setup is disabled. Set the
                <code>SETUP_TOKEN</code> environment variable (at least 16 characters) on the PixelCI server and restart it.
            </p>

            <form @submit.prevent="submit">
                <label>
                    Setup Token
                    <input
                        class="input"
                        v-model="form.setupToken"
                        type="password"
                        autocomplete="off"
                        :disabled="!setupEnabled"
                        placeholder="The SETUP_TOKEN configured on the server"
                        required
                    />
                </label>

                <label>
                    Integration Name
                    <input
                        class="input"
                        v-model="form.name"
                        type="text"
                        :placeholder="form.platform === 'github' ? 'e.g. My GitHub' : 'e.g. My GitLab'"
                        required
                    />
                </label>

                <label>
                    Platform
                    <select class="select" v-model="form.platform" required>
                        <option value="gitlab">GitLab</option>
                        <option value="github">GitHub</option>
                    </select>
                </label>

                <VcsIntegrationFields v-model="config" :platform="form.platform" />

                <button type="submit" class="btn primary" :disabled="isSubmitting || !setupEnabled">
                    {{ isSubmitting ? 'Creating...' : 'Create Integration' }}
                </button>
            </form>
        </div>
    </div>
</template>

<script lang="ts" setup>
import { dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { handleErrorAndAlert } from '@zyno-io/vue-foundation';
import { reactive, ref } from 'vue';

import { SessionApi } from '@/openapi-client-generated';
import { SETUP_TOKEN_STORAGE_KEY } from '@/setup-token';
import ThemeMenu from '@/shared/components/theme-menu.vue';
import VcsIntegrationFields, { buildVcsCreateBody, emptyVcsConfig } from '@/shared/components/vcs-integration-fields.vue';

defineProps<{ setupEnabled: boolean }>();
const emit = defineEmits<{ complete: [] }>();

const form = reactive({
    setupToken: '',
    name: '',
    platform: 'gitlab' as 'gitlab' | 'github'
});
const config = ref(emptyVcsConfig());

const isSubmitting = ref(false);

async function submit() {
    try {
        isSubmitting.value = true;
        await dataFromAsync(
            SessionApi.postSessionCreateOnboardingVcsIntegration({
                body: {
                    setupToken: form.setupToken,
                    integration: buildVcsCreateBody(form.name, form.platform, config.value)
                }
            })
        );
        // The first login needs the token again to claim the admin role; login.vue sends and clears it.
        try {
            sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, form.setupToken);
        } catch {
            // sessionStorage unavailable: the user can promote themselves later via another admin
        }
        form.setupToken = '';
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
