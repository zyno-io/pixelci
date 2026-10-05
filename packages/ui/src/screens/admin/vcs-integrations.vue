<template>
    <div id="admin-vcs-integrations">
        <LoaderModal v-if="isLoading" />

        <template v-else>
            <div class="header">
                <h1>VCS Integrations</h1>
                <button class="btn primary" @click="showCreateForm">Add Integration</button>
            </div>

            <div class="list card admin-list">
                <div v-if="!integrations?.length" class="empty">
                    <i class="fa fa-plug" />
                    <h2>No VCS integrations</h2>
                </div>
                <div v-for="integration in integrations" :key="integration.id" class="item">
                    <div class="item-info">
                        <span class="name">{{ integration.name }}</span>
                        <span class="platform tag">{{ integration.platform }}</span>
                    </div>
                    <div class="item-actions">
                        <button class="btn" @click="editIntegration(integration)">Edit</button>
                        <button class="btn danger" @click="deleteIntegration(integration)">Delete</button>
                    </div>
                </div>
            </div>
        </template>

        <VfModal v-if="showForm" @close="closeForm">
            <div class="form-modal">
                <h2>{{ editingId ? 'Edit' : 'Add' }} VCS Integration</h2>

                <form @submit.prevent="submitForm">
                    <label>
                        Name
                        <input class="input" v-model="form.name" type="text" required />
                    </label>

                    <label v-if="!editingId">
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
                        <p class="hint">Configure this as the redirect URI in your GitLab OAuth application.</p>
                    </div>

                    <div class="form-actions">
                        <button class="btn" type="button" @click="closeForm">Cancel</button>
                        <button type="submit" class="btn primary" :disabled="isSubmitting">
                            {{ isSubmitting ? 'Saving...' : 'Save' }}
                        </button>
                    </div>
                </form>
            </div>
        </VfModal>
    </div>
</template>

<script lang="ts" setup>
import { dataFrom, dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { handleErrorAndAlert, showConfirm, VfModal } from '@zyno-io/vue-foundation';
import { computed, onMounted, reactive, ref } from 'vue';

import { VcsIntegrationsApi, type IVcsIntegrationListResponse } from '@/openapi-client-generated';
import LoaderModal from '@/shared/components/loader-modal.vue';

const integrations = ref<IVcsIntegrationListResponse[]>();
const isLoading = ref(true);
const showForm = ref(false);
const isSubmitting = ref(false);
const editingId = ref<string | null>(null);

const form = reactive({
    name: '',
    platform: 'gitlab' as 'gitlab' | 'github',
    url: '',
    clientId: '',
    clientSecret: ''
});

const redirectUrl = computed(() => `${window.location.origin}/login`);

onMounted(load);

async function load() {
    try {
        const integrationsResponse = await VcsIntegrationsApi.getVcsIntegrationsIndex();
        integrations.value = dataFrom(integrationsResponse);
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isLoading.value = false;
    }
}

function showCreateForm() {
    editingId.value = null;
    form.name = '';
    form.platform = 'gitlab';
    form.url = '';
    form.clientId = '';
    form.clientSecret = '';
    showForm.value = true;
}

async function editIntegration(integration: IVcsIntegrationListResponse) {
    try {
        const detailResponse = await VcsIntegrationsApi.getVcsIntegrationsShow({ path: { id: integration.id } });
        const detail = dataFrom(detailResponse);
        editingId.value = integration.id;
        form.name = detail.name;
        form.platform = detail.platform;
        const config = detail.config as { url: string; clientId: string; clientSecret: string };
        form.url = config.url;
        form.clientId = config.clientId;
        form.clientSecret = config.clientSecret;
        showForm.value = true;
    } catch (err) {
        handleErrorAndAlert(err);
    }
}

async function deleteIntegration(integration: IVcsIntegrationListResponse) {
    const ok = await showConfirm(`Delete "${integration.name}"?`);
    if (!ok) return;
    try {
        await dataFromAsync(VcsIntegrationsApi.deleteVcsIntegrationsDelete({ path: { id: integration.id } }));
        integrations.value = integrations.value?.filter(i => i.id !== integration.id);
    } catch (err) {
        handleErrorAndAlert(err);
    }
}

function closeForm() {
    showForm.value = false;
    editingId.value = null;
}

async function submitForm() {
    try {
        isSubmitting.value = true;
        const config = {
            url: form.url,
            clientId: form.clientId,
            clientSecret: form.clientSecret
        };

        if (editingId.value) {
            await dataFromAsync(
                VcsIntegrationsApi.putVcsIntegrationsUpdate({
                    path: { id: editingId.value },
                    body: { name: form.name, config }
                })
            );
        } else {
            await dataFromAsync(
                VcsIntegrationsApi.postVcsIntegrationsCreate({
                    body: { name: form.name, platform: form.platform, config }
                })
            );
        }

        closeForm();
        isLoading.value = true;
        await load();
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isSubmitting.value = false;
    }
}
</script>
