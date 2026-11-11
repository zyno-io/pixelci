<template>
    <div id="builds">
        <LoaderModal v-if="isLoading" />

        <div v-else-if="!app && !isLoadingBuilds" class="load-error">
            <div class="notice danger" role="alert">
                <i class="fa fa-triangle-exclamation" aria-hidden="true" />
                <div class="notice-body">
                    {{ accessDenied ?? "This app couldn't be loaded. It may have been removed, or you may not have access." }}
                </div>
                <div class="notice-actions">
                    <button v-if="accessDenied" type="button" class="btn" data-testid="switch-account" @click="signOut">
                        Sign in with a different account
                    </button>
                    <RouterLink to="/apps" class="btn">Back to Apps</RouterLink>
                </div>
            </div>
        </div>

        <template v-else>
            <div v-if="app" class="header">
                <div class="flex gap-4 items-center">
                    <RouterLink :to="`/apps`" class="btn back" aria-label="Back to apps">
                        <i class="fa fa-arrow-left" aria-hidden="true" />
                    </RouterLink>
                    <h1>{{ app.name }}</h1>
                </div>
                <div class="flex gap-4 items-center">
                    <span v-if="branchesFailed" class="muted branches-failed" role="alert">Branches couldn't be loaded.</span>
                    <select class="select" v-model="selectedBranchId" aria-label="Branch">
                        <option value="">All Branches</option>
                        <option v-for="branch in branches" :key="branch.id" :value="branch.id">{{ branch.name }}</option>
                    </select>
                </div>
            </div>

            <div class="build-list card">
                <LoaderModal v-if="isLoadingBuilds" />
                <div v-else-if="buildsFailed" class="notice danger" role="alert">
                    <i class="fa fa-triangle-exclamation" aria-hidden="true" />
                    <div class="notice-body">Builds couldn't be loaded. Try again, or pick another branch.</div>
                </div>
                <div v-else-if="!builds.length" class="empty">
                    <i class="fa fa-magnifying-glass" aria-hidden="true" />
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
                        <i class="fa fa-code-branch fa-sm fa-fw meta-icon" aria-hidden="true" />
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
                        <i class="fa fa-code-commit fa-sm fa-fw meta-icon" aria-hidden="true" />
                        <div class="flex flex-col w-full">
                            <span class="font-mono">{{ build.commitHash?.substring(0, 8) }}</span>
                            <span class="truncate">{{ build.commitSubject }}</span>
                        </div>
                    </a>
                    <div v-else class="pr-6" v-tooltip="build.commitSubject">
                        <i class="fa fa-code-commit fa-sm fa-fw meta-icon" aria-hidden="true" />
                        <div class="flex flex-col w-full">
                            <span class="font-mono">{{ build.commitHash?.substring(0, 8) }}</span>
                            <span class="truncate">{{ build.commitSubject }}</span>
                        </div>
                    </div>
                    <div>
                        <i class="fa fa-user fa-sm fa-fw meta-icon" aria-hidden="true" />
                        <span>{{ build.commitAuthor.replace(/<.*?>/, '') }}</span>
                    </div>
                    <div>
                        <i class="fa fa-calendar-days fa-sm fa-fw meta-icon" aria-hidden="true" />
                        <div class="flex flex-col">
                            <span class="build-date">{{ $filters.dateTime(build.createdAt, 'M/d/yy H:mm') }}</span>
                        </div>
                    </div>
                    <div class="justify-end">
                        <div class="status tag" :class="getStatusStyle(build.status)">
                            <div class="flex items-center gap-2">
                                <!-- approved -->
                                <i class="fa fa-check fa-sm fa-fw" v-if="build.status === 'changes approved'" aria-hidden="true" />
                                <!-- processing -->
                                <i class="fa fa-stopwatch fa-sm fa-fw" v-if="build.status === 'processing'" aria-hidden="true" />
                                <!-- needs review -->
                                <i
                                    class="fa fa-magnifying-glass fa-sm fa-fw text-inherit"
                                    v-if="build.status === 'needs review'"
                                    aria-hidden="true"
                                />
                                <!-- draft -->
                                <i class="fa fa-pen-to-square fa-sm fa-fw" v-if="build.status === 'draft'" aria-hidden="true" />
                                <!-- no changes -->
                                <i class="fa fa-check fa-sm fa-fw" v-if="build.status === 'no changes'" aria-hidden="true" />
                                <!-- failed -->
                                <i class="fa fa-xmark fa-sm fa-fw" v-if="build.status === 'failed'" aria-hidden="true" />
                                <!-- rejected -->
                                <i class="fa fa-xmark fa-sm fa-fw" v-if="build.status === 'changes rejected'" aria-hidden="true" />
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
import { handleError } from '@zyno-io/vue-foundation';
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { AppsApi, BranchesApi, BuildsApi, type IAppShowResponse, type IBranchResponse, type IBuildResponse } from '@/openapi-client-generated';
import { accessDeniedMessage, signOut } from '@/shared/access-error';
import LoaderModal from '@/shared/components/loader-modal.vue';
import { useStore } from '@/store';

const route = useRoute();
const router = useRouter();
const store = useStore();

const app = ref<IAppShowResponse>();
const branches = ref<IBranchResponse[]>();
const branchesFailed = ref(false);
const selectedBranchId = ref<string>('');

const builds = ref<IBuildResponse[]>([]);
const isLoading = ref(true);
const isLoadingBuilds = ref(true);
const buildsFailed = ref(false);
const accessDenied = ref<string | null>(null);

onMounted(() => {
    if (store.selectedBranchId) selectedBranchId.value = store.selectedBranchId;
    loadBranches();
    loadBuilds();
});

watch(
    () => app.value?.name,
    name => {
        if (name) document.title = `${name} · PixelCI`;
    }
);

watch(selectedBranchId, () => {
    store.selectedBranchId = selectedBranchId.value;
    loadBuilds();
});

async function loadBranches() {
    try {
        const branchesResponse = await BranchesApi.getBranchesIndex({ path: { appId: String(route.params.id) } });
        branches.value = dataFrom(branchesResponse);
    } catch (err) {
        handleError(err);
        branchesFailed.value = true;
    } finally {
        isLoading.value = false;
    }
}

async function loadBuilds() {
    try {
        isLoadingBuilds.value = true;
        buildsFailed.value = false;

        const appResponse = await AppsApi.getAppsShow({ path: { id: String(route.params.id) } });
        app.value = dataFrom(appResponse);
        const buildsResponse = await BuildsApi.getBuildsIndex({
            path: { appId: String(route.params.id) },
            query: { branchId: selectedBranchId.value || undefined }
        });
        builds.value = dataFrom(buildsResponse);
    } catch (err) {
        handleError(err);
        accessDenied.value = accessDeniedMessage(err);
        buildsFailed.value = true;
        builds.value = [];
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
            return 'Changes Approved';
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
            return 'Changes Rejected';
        case 'canceled':
            return 'Canceled';
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
        grid-template-columns: minmax(100px, 0.8fr) minmax(0, 1.8fr) minmax(100px, 1fr) 130px 140px;
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
    .build:focus-visible {
        outline-offset: -2px;
    }
    .load-error .notice {
        align-items: center;
    }
    .branches-failed {
        font-size: 12px;
    }
    .build-list > .notice {
        margin: 16px;
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
    .build .meta-icon {
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
