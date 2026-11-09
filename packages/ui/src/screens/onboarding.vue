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
import { reactive, ref } from 'vue';

import { SessionApi } from '@/openapi-client-generated';
import ThemeMenu from '@/shared/components/theme-menu.vue';
import VcsIntegrationFields, { buildVcsCreateBody, emptyVcsConfig } from '@/shared/components/vcs-integration-fields.vue';

const emit = defineEmits<{ complete: [] }>();

const form = reactive({
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
                body: buildVcsCreateBody(form.name, form.platform, config.value)
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
