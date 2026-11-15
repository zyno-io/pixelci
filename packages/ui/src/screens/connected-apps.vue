<template>
    <div id="connected-apps">
        <LoaderModal v-if="isLoading" />

        <template v-else>
            <div class="header">
                <h1>Connected apps</h1>
            </div>

            <p class="intro">
                Apps you've allowed to read PixelCI on your behalf, such as an AI assistant. They see only what you can see, and can't make changes.
            </p>

            <div v-if="loadFailed" class="notice danger" role="alert">
                <i class="fa fa-triangle-exclamation" aria-hidden="true" />
                <div class="notice-body">Your connected apps couldn't be loaded.</div>
                <div class="notice-actions">
                    <button type="button" class="btn" @click="load">Try again</button>
                </div>
            </div>

            <div v-else class="card apps-card">
                <div v-if="!apps.length" class="empty">
                    <i class="fa fa-plug" aria-hidden="true" />
                    <h2>No connected apps</h2>
                    <p>Add PixelCI as an MCP connector in your AI assistant and approve the request to see it here.</p>
                </div>

                <div v-else class="table-wrap">
                    <table class="apps-table">
                        <caption class="sr-only">
                            Connected apps
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">App</th>
                                <th scope="col">Returns to</th>
                                <th scope="col">Connected</th>
                                <th scope="col">Last used</th>
                                <th scope="col"><span class="sr-only">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="app in apps" :key="app.id" data-testid="connected-app">
                                <th scope="row" class="app-name">{{ app.clientName }}</th>
                                <td>{{ app.redirectDisplay }}</td>
                                <td class="nowrap">{{ $filters.dateTime(app.createdAt, 'M/d/yy H:mm') }}</td>
                                <td class="nowrap">{{ app.lastUsedAt ? $filters.dateTime(app.lastUsedAt, 'M/d/yy H:mm') : 'Never' }}</td>
                                <td class="actions">
                                    <button
                                        type="button"
                                        class="btn sm danger"
                                        :disabled="revokingId === app.id"
                                        :aria-label="`Revoke ${app.clientName}`"
                                        @click="revoke(app)"
                                    >
                                        Revoke
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </template>
    </div>
</template>

<script lang="ts" setup>
import { dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { handleErrorAndAlert, showConfirm, showToast } from '@zyno-io/vue-foundation';
import { onMounted, ref } from 'vue';

import { ConnectedAppsApi, type IConnectedApp } from '@/openapi-client-generated';
import LoaderModal from '@/shared/components/loader-modal.vue';

const apps = ref<IConnectedApp[]>([]);
const isLoading = ref(true);
const loadFailed = ref(false);
const revokingId = ref<string>();

onMounted(load);

async function load() {
    loadFailed.value = false;
    try {
        apps.value = await dataFromAsync(ConnectedAppsApi.getConnectedAppsIndex());
    } catch {
        loadFailed.value = true;
    } finally {
        isLoading.value = false;
    }
}

async function revoke(app: IConnectedApp) {
    const ok = await showConfirm(`Revoke access for "${app.clientName}"? It will stop working immediately, and you'd have to approve it again.`);
    if (!ok) return;

    revokingId.value = app.id;
    try {
        await dataFromAsync(ConnectedAppsApi.deleteConnectedAppsRevoke({ path: { id: app.id } }));
        apps.value = apps.value.filter(a => a.id !== app.id);
        showToast({ message: `Revoked ${app.clientName}`, durationSecs: 3, disableClose: true });
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        revokingId.value = undefined;
    }
}
</script>

<style lang="scss" scoped>
.intro {
    margin-bottom: 16px;
    color: var(--text-2);
    font-size: 13px;
}

.apps-card {
    overflow: hidden;
}

.table-wrap {
    overflow-x: auto;
}

.apps-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;

    th,
    td {
        padding: 12px 18px;
        border-top: 1px solid var(--border);
        text-align: left;
        vertical-align: middle;
    }

    thead th {
        border-top: 0;
        background: var(--surface-2);
        color: var(--text-3);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.045em;
        text-transform: uppercase;
    }

    .app-name {
        font-weight: 600;
        overflow-wrap: anywhere;
    }

    .actions {
        text-align: right;
    }
}
</style>
