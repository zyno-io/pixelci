<template>
    <div id="apps">
        <LoaderModal v-if="isLoading" />

        <template v-else>
            <div class="header">
                <h1>Apps</h1>
                <button v-if="store.isAdmin" class="btn primary" @click="showCreateForm">Add App</button>
            </div>

            <div v-if="apps?.length" class="search-bar">
                <i class="fa fa-magnifying-glass" />
                <input class="input" v-model="search" type="text" placeholder="Search apps..." aria-label="Search apps" />
            </div>

            <div class="app-list card">
                <div v-if="!apps?.length" class="empty">
                    <i class="fa fa-cube" />
                    <h2>No apps</h2>
                </div>
                <div v-else-if="!visibleApps.length" class="empty">
                    <i class="fa fa-magnifying-glass" />
                    <h2>No matching apps</h2>
                </div>
                <div
                    v-for="app in visibleApps"
                    :key="app.id"
                    class="app"
                    role="link"
                    tabindex="0"
                    @click="viewApp(app)"
                    @keydown.enter.self="viewApp(app)"
                >
                    <span class="app-name">{{ app.name }}</span>
                    <div class="app-right">
                        <span>{{ app.buildCount || 'No' }} {{ app.buildCount === 1 ? 'build' : 'builds' }}</span>
                        <button
                            v-if="store.isAdmin"
                            type="button"
                            class="btn ghost icon sm app-settings"
                            :aria-label="`Settings for ${app.name}`"
                            @click.stop="openEditModal(app)"
                        >
                            <i class="fa fa-gear" aria-hidden="true" />
                        </button>
                    </div>
                </div>
            </div>
        </template>

        <!-- Create App Modal -->
        <VfModal v-if="showCreate" @close="closeCreateModal">
            <!-- Post-creation CI setup view -->
            <div v-if="createdApp" class="ci-setup">
                <h2>App created!</h2>
                <p class="subtitle">Add this to your <code>.gitlab-ci.yml</code>:</p>

                <div class="ci-snippet-header">
                    <span />
                    <button class="btn" type="button" @click="copyCiSnippet"><i class="fa fa-copy" /> Copy</button>
                </div>
                <pre><code>{{ ciSnippet }}</code></pre>

                <div class="ci-actions">
                    <button type="button" class="btn primary" @click="closeCreateModal">Done</button>
                </div>
            </div>

            <!-- Create form -->
            <div v-else class="form-modal">
                <h2>Add App</h2>

                <form @submit.prevent="submitCreate">
                    <label>
                        VCS Integration
                        <select class="select" v-model="createForm.vcsId" required>
                            <option value="" disabled>Select integration...</option>
                            <option v-for="vcs in vcsIntegrations" :key="vcs.id" :value="vcs.id">
                                {{ vcs.name }}
                            </option>
                        </select>
                    </label>

                    <label>
                        Project
                        <input
                            class="input"
                            v-model="projectSearch"
                            type="text"
                            placeholder="Search by name or paste a GitLab URL..."
                            :disabled="!createForm.vcsId"
                            @input="onProjectSearchInput"
                        />
                        <div v-if="projectResults.length" class="project-results">
                            <div v-for="project in projectResults" :key="project.id" class="project-result" @click="selectProject(project)">
                                <span class="project-name">{{ project.name }}</span>
                                <span class="project-path">{{ project.projectPath }}</span>
                            </div>
                        </div>
                        <div v-if="selectedProject" class="selected-project">
                            <span>{{ selectedProject.projectPath }}</span>
                            <button type="button" class="btn ghost icon sm clear-btn" @click="clearProject">
                                <i class="fa fa-times" />
                            </button>
                        </div>
                    </label>

                    <label>
                        App Name
                        <input class="input" v-model="createForm.name" type="text" required />
                    </label>

                    <label>
                        Default Branch Name
                        <input class="input" v-model="createForm.defaultBranchName" type="text" placeholder="e.g. main" />
                    </label>

                    <div class="form-actions">
                        <button class="btn" type="button" @click="closeCreateModal">Cancel</button>
                        <button type="submit" class="btn primary" :disabled="isSubmitting || !selectedProject">
                            {{ isSubmitting ? 'Creating...' : 'Create App' }}
                        </button>
                    </div>
                </form>
            </div>
        </VfModal>

        <!-- Edit App Modal -->
        <VfModal v-if="editApp" @close="closeEditModal">
            <div class="form-modal">
                <h2>App Settings</h2>

                <form @submit.prevent="submitEdit">
                    <label>
                        App ID
                        <div class="input-with-button">
                            <input class="input" :value="editApp.id" type="text" readonly />
                            <button type="button" class="btn input-button" @click="copyAppId">
                                <i class="fa fa-copy" />
                            </button>
                        </div>
                    </label>

                    <label>
                        App Name
                        <input class="input" v-model="editForm.name" type="text" required />
                    </label>

                    <label>
                        Default Branch
                        <select class="select" v-model="editForm.defaultBranchId">
                            <option value="" disabled>Select branch...</option>
                            <option v-for="branch in editBranches" :key="branch.id" :value="branch.id">
                                {{ branch.name }}
                            </option>
                        </select>
                    </label>

                    <div class="form-actions">
                        <button type="button" class="btn danger" @click="deleteApp">Delete</button>
                        <div class="form-actions-right">
                            <button class="btn" type="button" @click="closeEditModal">Cancel</button>
                            <button type="submit" class="btn primary" :disabled="isSubmitting">
                                {{ isSubmitting ? 'Saving...' : 'Save' }}
                            </button>
                        </div>
                    </div>
                </form>

                <hr />

                <div class="ci-snippet">
                    <div class="ci-snippet-header">
                        <span class="ci-snippet-label">.gitlab-ci.yml</span>
                        <button class="btn" type="button" @click="copyEditCiSnippet"><i class="fa fa-copy" /> Copy</button>
                    </div>
                    <pre><code>{{ editCiSnippet }}</code></pre>
                </div>
            </div>
        </VfModal>
    </div>
</template>

<script lang="ts" setup>
import { dataFrom, dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { handleErrorAndAlert, showConfirm, showToast, VfModal } from '@zyno-io/vue-foundation';
import { debounce } from 'lodash';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
    AppsApi,
    BranchesApi,
    VcsIntegrationsApi,
    type IAppIndexResponse,
    type IAppShowResponse,
    type IBranchResponse,
    type IVcsIntegrationListResponse,
    type IVcsProject
} from '@/openapi-client-generated';
import LoaderModal from '@/shared/components/loader-modal.vue';
import { useStore } from '@/store';

const store = useStore();
const router = useRouter();

const apps = ref<IAppIndexResponse[]>();
const vcsIntegrations = ref<IVcsIntegrationListResponse[]>();
const isLoading = ref(true);
const search = ref('');

const visibleApps = computed(() => {
    const sorted = [...(apps.value ?? [])].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));
    const query = search.value.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter(app => (app.name ?? '').toLowerCase().includes(query));
});
const isSubmitting = ref(false);
// Create form state
const showCreate = ref(false);
const createdApp = ref<IAppIndexResponse | null>(null);
const projectSearch = ref('');
const projectResults = ref<IVcsProject[]>([]);
const selectedProject = ref<IVcsProject | null>(null);
const createForm = reactive({
    vcsId: '',
    name: '',
    defaultBranchName: ''
});

const apiUrl = computed(() => window.location.origin);

function buildCiSnippet(appId: string) {
    return `visual-regression:
  stage: test
  image: ghcr.io/zyno-io/pixelci/cli:latest
  variables:
    PIXELCI_API_URL: ${apiUrl.value}
    PIXELCI_APP_ID: ${appId}
    PIXELCI_IMAGES_PATH: ./path/to/screenshots
  script:
    - pixelci`;
}

const ciSnippet = computed(() => buildCiSnippet(createdApp.value?.id ?? '<app-id>'));
const editCiSnippet = computed(() => buildCiSnippet(editApp.value?.id ?? '<app-id>'));

// Edit form state
const editApp = ref<IAppIndexResponse | null>(null);
const editAppDetail = ref<IAppShowResponse | null>(null);
const editBranches = ref<IBranchResponse[]>([]);
const editForm = reactive({
    name: '',
    defaultBranchId: ''
});

onMounted(load);

async function load() {
    try {
        const appsPromise = AppsApi.getAppsIndex();
        const vcsPromise = store.isAdmin ? VcsIntegrationsApi.getVcsIntegrationsIndex() : undefined;
        const [appsResult, vcsResult] = await Promise.all([appsPromise, vcsPromise]);
        apps.value = dataFrom(appsResult);
        if (vcsResult) {
            vcsIntegrations.value = dataFrom(vcsResult);
        }
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isLoading.value = false;
    }
}

function viewApp(app: IAppIndexResponse) {
    router.push({ path: `/apps/${app.id}` });
}

// --- Create App ---

function showCreateForm() {
    createForm.vcsId = vcsIntegrations.value?.[0]?.id ?? '';
    createForm.name = '';
    createForm.defaultBranchName = '';
    projectSearch.value = '';
    projectResults.value = [];
    selectedProject.value = null;
    createdApp.value = null;
    showCreate.value = true;
}

const URL_REGEX = /^https?:\/\//;

const debouncedSearch = debounce(async (search: string) => {
    if (!createForm.vcsId || search.length < 2) {
        projectResults.value = [];
        return;
    }

    try {
        if (URL_REGEX.test(search)) {
            const project = await dataFromAsync(
                AppsApi.getAppsResolveVcsProject({
                    query: { vcsId: createForm.vcsId, url: search }
                })
            );
            selectProject(project);
            return;
        }

        projectResults.value = await dataFromAsync(
            AppsApi.getAppsSearchVcsProjects({
                query: { vcsId: createForm.vcsId, search }
            })
        );
    } catch {
        projectResults.value = [];
    }
}, 300);

function onProjectSearchInput() {
    if (selectedProject.value) return;
    debouncedSearch(projectSearch.value);
}

function selectProject(project: IVcsProject) {
    selectedProject.value = project;
    projectSearch.value = '';
    projectResults.value = [];
    if (!createForm.name) {
        createForm.name = project.name;
    }
    if (!createForm.defaultBranchName && project.defaultBranch) {
        createForm.defaultBranchName = project.defaultBranch;
    }
}

function clearProject() {
    selectedProject.value = null;
    projectSearch.value = '';
}

async function submitCreate() {
    if (!selectedProject.value) return;
    try {
        isSubmitting.value = true;
        const app = await dataFromAsync(
            AppsApi.postAppsCreate({
                body: {
                    name: createForm.name,
                    vcsId: createForm.vcsId,
                    projectPath: selectedProject.value.projectPath,
                    vcsProjectId: Number(selectedProject.value.id),
                    defaultBranchName: createForm.defaultBranchName || undefined
                }
            })
        );
        createdApp.value = app;
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isSubmitting.value = false;
    }
}

function closeCreateModal() {
    const shouldReload = !!createdApp.value;
    showCreate.value = false;
    createdApp.value = null;
    if (shouldReload) {
        isLoading.value = true;
        load();
    }
}

async function copyCiSnippet() {
    await navigator.clipboard.writeText(ciSnippet.value);
    showToast({ message: 'Copied to clipboard', durationSecs: 2, disableClose: true });
}

async function copyEditCiSnippet() {
    await navigator.clipboard.writeText(editCiSnippet.value);
    showToast({ message: 'Copied to clipboard', durationSecs: 2, disableClose: true });
}

async function copyAppId() {
    if (editApp.value?.id) {
        await navigator.clipboard.writeText(editApp.value.id);
        showToast({ message: 'Copied to clipboard', durationSecs: 2, disableClose: true });
    }
}

// --- Edit App ---

async function openEditModal(app: IAppIndexResponse) {
    editApp.value = app;
    editForm.name = app.name ?? '';
    editForm.defaultBranchId = app.defaultBranchId ?? '';

    try {
        const [detail, branches] = await Promise.all([
            dataFromAsync(AppsApi.getAppsShow({ path: { id: app.id! } })),
            dataFromAsync(BranchesApi.getBranchesIndex({ path: { appId: app.id! } }))
        ]);
        editAppDetail.value = detail;
        editBranches.value = branches;
    } catch (err) {
        handleErrorAndAlert(err);
    }
}

function closeEditModal() {
    editApp.value = null;
    editAppDetail.value = null;
    editBranches.value = [];
}

async function submitEdit() {
    if (!editApp.value) return;
    try {
        isSubmitting.value = true;
        const updated = await dataFromAsync(
            AppsApi.putAppsUpdate({
                path: { id: editApp.value.id! },
                body: {
                    name: editForm.name,
                    defaultBranchId: editForm.defaultBranchId || undefined
                }
            })
        );
        const idx = apps.value?.findIndex(a => a.id === editApp.value!.id);
        if (idx !== undefined && idx >= 0 && apps.value) {
            apps.value[idx] = updated;
        }
        closeEditModal();
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isSubmitting.value = false;
    }
}

// --- Delete App ---

async function deleteApp() {
    if (!editApp.value) return;
    const ok = await showConfirm(`Delete "${editApp.value.name}"? This cannot be undone.`);
    if (!ok) return;

    try {
        await dataFromAsync(AppsApi.deleteAppsDelete({ path: { id: editApp.value.id! } }));
        apps.value = apps.value?.filter(a => a.id !== editApp.value!.id);
        closeEditModal();
    } catch (err) {
        handleErrorAndAlert(err);
    }
}
</script>

<style lang="scss" scoped>
#apps {
    .search-bar {
        display: flex;
        align-items: center;
        gap: 9px;
        max-width: 360px;
        margin-bottom: 16px;
        padding: 0 10px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius);
        background: var(--surface);
        color: var(--text-3);
        box-shadow: var(--shadow-sm);
    }
    .search-bar:focus-within {
        border-color: var(--focus);
        box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .search-bar .input {
        flex: 1;
        min-width: 0;
        padding: 0;
        border: 0;
        background: transparent;
        box-shadow: none;
    }
    .app-list {
        overflow: hidden;
    }
    .app {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 60px;
        padding: 14px 18px;
        color: var(--text);
        cursor: pointer;
        text-decoration: none;
        transition: background-color 0.12s;
    }
    .app + .app {
        border-top: 1px solid var(--border);
    }
    .app:hover {
        background: var(--surface-hover);
    }
    .app-name {
        min-width: 0;
        overflow-wrap: anywhere;
        font-weight: 600;
    }
    .app-right {
        display: flex;
        align-items: center;
        gap: 12px;
        color: var(--text-3);
        font-size: 12px;
        white-space: nowrap;
    }
}
.project-results {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 10;
    max-height: 240px;
    overflow-y: auto;
    margin-top: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow-md);
}
.project-result {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    cursor: pointer;
}
.project-result:hover {
    background: var(--surface-hover);
}
.project-path {
    color: var(--text-3);
    font-size: 12px;
}
.selected-project {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    overflow-wrap: anywhere;
}
.input-with-button {
    display: flex;
}
.input-with-button .input {
    flex: 1;
    min-width: 0;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
}
.input-button {
    border-left: 0;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
}
</style>
