<template>
    <div id="builds">
        <LoaderModal v-if="isLoading" />

        <template v-else>
            <div v-if="app" class="header">
                <div class="flex gap-4 items-center">
                    <RouterLink :to="`/apps`" class="btn back" aria-label="Back to apps">
                        <i class="fa fa-arrow-left" aria-hidden="true" />
                    </RouterLink>
                    <h1>{{ app.name }}</h1>
                </div>
                <select class="select" v-model="selectedBranchId" aria-label="Branch">
                    <option value="">All Branches</option>
                    <option v-for="branch in branches" :key="branch.id" :value="branch.id">{{ branch.name }}</option>
                </select>
            </div>

            <div class="build-list card">
                <LoaderModal v-if="isLoadingBuilds" />
                <div v-else-if="!builds.length" class="empty">
                    <i class="fa fa-magnifying-glass" />
                    <h2>No builds found{{ selectedBranchId && ' for this branch' }}</h2>
                </div>
                <div
                    v-for="build in builds"
                    :key="build.id"
                    class="build"
                    role="link"
                    tabindex="0"
                    @click="viewBuild(build)"
                    @keydown.enter.self="viewBuild(build)"
                >
                    <div>
                        <label><i class="fa fa-code-branch fa-sm fa-fw" /></label>
                        <span>{{ build.branchName }}</span>
                    </div>
                    <a
                        v-if="app?.commitUrlBase && build.commitHash"
                        class="pr-6 commit-link"
                        :href="`${app.commitUrlBase}/${build.commitHash}`"
                        target="_blank"
                        v-tooltip="build.commitSubject"
                        @click.stop
                    >
                        <label><i class="fa fa-code-commit fa-sm fa-fw" /></label>
                        <div class="flex flex-col w-full">
                            <span class="font-mono">{{ build.commitHash?.substring(0, 8) }}</span>
                            <span class="truncate">{{ build.commitSubject }}</span>
                        </div>
                    </a>
                    <div v-else class="pr-6" v-tooltip="build.commitSubject">
                        <label><i class="fa fa-code-commit fa-sm fa-fw" /></label>
                        <div class="flex flex-col w-full">
                            <span class="font-mono">{{ build.commitHash?.substring(0, 8) }}</span>
                            <span class="truncate">{{ build.commitSubject }}</span>
                        </div>
                    </div>
                    <div>
                        <label><i class="fa fa-user fa-sm fa-fw" /></label>
                        <span>{{ build.commitAuthor.replace(/<.*?>/, '') }}</span>
                    </div>
                    <div>
                        <label><i class="fa fa-calendar-days fa-sm fa-fw" /></label>
                        <div class="flex flex-col">
                            <span class="build-date">{{ $filters.dateTime(build.createdAt, 'M/d/yy H:mm') }}</span>
                        </div>
                    </div>
                    <div class="justify-end">
                        <div class="status tag" :class="getStatusStyle(build.status)">
                            <div class="flex items-center gap-2">
                                <!-- approved -->
                                <i class="fa fa-check fa-sm fa-fw" v-if="build.status === 'changes approved'" />
                                <!-- processing -->
                                <i class="fa fa-stopwatch fa-sm fa-fw" v-if="build.status === 'processing'" />
                                <!-- needs review -->
                                <i class="fa fa-magnifying-glass fa-sm fa-fw text-inherit" v-if="build.status === 'needs review'" />
                                <!-- draft -->
                                <i class="fa fa-pen-to-square fa-sm fa-fw" v-if="build.status === 'draft'" />
                                <!-- no changes -->
                                <i class="fa fa-check fa-sm fa-fw" v-if="build.status === 'no changes'" />
                                <!-- failed -->
                                <i class="fa fa-xmark fa-sm fa-fw" v-if="build.status === 'failed'" />
                                <!-- rejected -->
                                <i class="fa fa-xmark fa-sm fa-fw" v-if="build.status === 'changes rejected'" />
                                <span>{{ getStatusText(build.status) }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </template>
    </div>
</template>

<script lang="ts" setup>
import { dataFrom } from '@zyno-io/openapi-client-codegen';
import { handleErrorAndAlert } from '@zyno-io/vue-foundation';
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { AppsApi, BranchesApi, BuildsApi, type IAppShowResponse, type IBranchResponse, type IBuildResponse } from '@/openapi-client-generated';
import LoaderModal from '@/shared/components/loader-modal.vue';
import { useStore } from '@/store';

const route = useRoute();
const router = useRouter();
const store = useStore();

const app = ref<IAppShowResponse>();
const branches = ref<IBranchResponse[]>();
const selectedBranchId = ref<string>('');

const builds = ref<IBuildResponse[]>([]);
const isLoading = ref(true);
const isLoadingBuilds = ref(true);

onMounted(() => {
    if (store.selectedBranchId) selectedBranchId.value = store.selectedBranchId;
    loadBranches();
    loadBuilds();
});

watch(selectedBranchId, () => {
    store.selectedBranchId = selectedBranchId.value;
    loadBuilds();
});

async function loadBranches() {
    try {
        const branchesResponse = await BranchesApi.getBranchesIndex({ path: { appId: String(route.params.id) } });
        branches.value = dataFrom(branchesResponse);
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isLoading.value = false;
    }
}

async function loadBuilds() {
    try {
        isLoadingBuilds.value = true;

        const appResponse = await AppsApi.getAppsShow({ path: { id: String(route.params.id) } });
        app.value = dataFrom(appResponse);
        const buildsResponse = await BuildsApi.getBuildsIndex({
            path: { appId: String(route.params.id) },
            query: { branchId: selectedBranchId.value || undefined }
        });
        builds.value = dataFrom(buildsResponse);
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isLoadingBuilds.value = false;
    }
}

function viewBuild(build: IBuildResponse) {
    router.push({ path: `/apps/${app.value!.id}/builds/${build.id}` });
}

function getStatusStyle(status: IBuildResponse['status']) {
    switch (status) {
        case 'changes approved':
            return 'success';
        case 'processing':
            return 'warning';
        case 'needs review':
            return 'warning';
        case 'draft':
            return '';
        case 'no changes':
            return 'info';
        case 'failed':
        case 'changes rejected':
            return 'danger';
        default:
            return '';
    }
}

function getStatusText(status: IBuildResponse['status']) {
    switch (status) {
        case 'changes approved':
            return 'Approved';
        case 'processing':
            return 'Processing';
        case 'needs review':
            return 'Needs Review';
        case 'draft':
            return 'Draft';
        case 'no changes':
            return 'No Changes';
        case 'failed':
            return 'Failed';
        case 'changes rejected':
            return 'Rejected';
        default:
            return status;
    }
}
</script>

<style lang="scss" scoped>
#builds {
    .build-list {
        overflow: hidden;
    }
    .build {
        display: grid;
        grid-template-columns: minmax(100px, 0.8fr) minmax(0, 1.8fr) minmax(100px, 1fr) 130px 110px;
        align-items: center;
        gap: 16px;
        min-height: 72px;
        padding: 14px 18px;
        cursor: pointer;
        transition: background-color 0.12s;
    }
    .build + .build {
        border-top: 1px solid var(--border);
    }
    .build:hover {
        background: var(--surface-hover);
    }
    .build > div,
    .build > a {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
    }
    .build span.truncate {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-2);
        font-size: 12px;
    }
    .build label {
        color: var(--text-3);
    }
    .commit-link {
        color: inherit;
        text-decoration: none;
    }
    .commit-link:hover {
        color: var(--link);
    }
    .build-date {
        color: var(--text-3);
        font-size: 12px;
    }
    .status {
        height: 24px;
    }
}
@media (max-width: 900px) {
    #builds .build {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
        gap: 12px;
    }
    #builds .build > :last-child {
        grid-column: 2;
        grid-row: 1;
    }
    #builds .build > :nth-child(2) {
        grid-column: 1 / -1;
    }
}
</style>
