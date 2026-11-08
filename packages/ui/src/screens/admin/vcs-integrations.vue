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
                        <input
                            class="input"
                            v-model="form.name"
                            type="text"
                            :placeholder="form.platform === 'github' ? 'e.g. My GitHub' : 'e.g. My GitLab'"
                            required
                        />
                    </label>

                    <label v-if="!editingId">
                        Platform
                        <select class="select" v-model="form.platform" required>
                            <option value="gitlab">GitLab</option>
                            <option value="github">GitHub</option>
                        </select>
                    </label>

                    <VcsIntegrationFields v-model="config" :platform="form.platform" :is-edit="!!editingId" :has-private-key="hasPrivateKey" />

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
import { onMounted, reactive, ref } from 'vue';

import { VcsIntegrationsApi, type IVcsIntegrationListResponse } from '@/openapi-client-generated';
import LoaderModal from '@/shared/components/loader-modal.vue';
import VcsIntegrationFields, { buildVcsCreateBody, buildVcsUpdateBody, emptyVcsConfig } from '@/shared/components/vcs-integration-fields.vue';

const integrations = ref<IVcsIntegrationListResponse[]>();
const isLoading = ref(true);
const showForm = ref(false);
const isSubmitting = ref(false);
const editingId = ref<string | null>(null);

const form = reactive({
    name: '',
    platform: 'gitlab' as 'gitlab' | 'github'
});
const config = ref(emptyVcsConfig());
const hasPrivateKey = ref(false);

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
    config.value = emptyVcsConfig();
    hasPrivateKey.value = false;
    showForm.value = true;
}

async function editIntegration(integration: IVcsIntegrationListResponse) {
    try {
        const detailResponse = await VcsIntegrationsApi.getVcsIntegrationsShow({ path: { id: integration.id } });
        const detail = dataFrom(detailResponse);
        editingId.value = integration.id;
        form.name = detail.name;
        form.platform = detail.platform;
        const next = emptyVcsConfig();
        next.url = detail.config.url ?? '';
        next.clientId = detail.config.clientId;
        if (detail.platform === 'github') {
            next.appId = detail.config.appId ?? '';
            next.oidcAudience = detail.config.oidcAudience;
            hasPrivateKey.value = detail.config.hasPrivateKey;
        } else {
            hasPrivateKey.value = false;
        }
        config.value = next;
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
        if (editingId.value) {
            await dataFromAsync(
                VcsIntegrationsApi.putVcsIntegrationsUpdate({
                    path: { id: editingId.value },
                    body: buildVcsUpdateBody(form.name, form.platform, config.value)
                })
            );
        } else {
            await dataFromAsync(
                VcsIntegrationsApi.postVcsIntegrationsCreate({
                    body: buildVcsCreateBody(form.name, form.platform, config.value)
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
