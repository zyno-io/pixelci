<template>
    <div id="screens" class="full" :class="{ 'single-view': !showChanges }">
        <LoaderModal v-if="isLoading" />

        <template v-else>
            <div class="header">
                <div class="flex gap-4 items-center">
                    <RouterLink :to="`/apps/${route.params.id}`" class="btn back" aria-label="Back to builds">
                        <i class="fa fa-arrow-left" aria-hidden="true" />
                    </RouterLink>

                    <h1>Screens</h1>
                </div>

                <div class="header-center">
                    <span class="screen-count tag">{{ totalScreens }} {{ totalScreens === 1 ? 'screen' : 'screens' }}</span>

                    <a v-if="build && commitUrl" class="commit-info" :href="commitUrl" target="_blank" v-tooltip="build.commitSubject">
                        <i class="fa fa-code-commit fa-sm" />
                        <span class="font-mono">{{ build.commitHash?.substring(0, 8) }}</span>
                        <span class="truncate">{{ build.commitSubject }}</span>
                    </a>
                    <div v-else-if="build" class="commit-info">
                        <i class="fa fa-code-commit fa-sm" />
                        <span class="font-mono">{{ build.commitHash?.substring(0, 8) }}</span>
                        <span class="truncate">{{ build.commitSubject }}</span>
                    </div>
                </div>

                <div class="flex gap-4 items-center">
                    <label v-if="showChanges">
                        <input type="checkbox" v-model="showDiff" data-testid="diff-check" />
                        Show Diff
                    </label>

                    <label>
                        <input type="checkbox" v-model="showChanges" data-testid="changes-check" />
                        Show Changes
                    </label>

                    <select v-model="zoomLevel" class="select zoom-select" data-testid="zoom-select" aria-label="Screenshot zoom">
                        <option v-for="opt in zoomOptions" :key="opt" :value="opt">{{ opt }}%</option>
                    </select>
                </div>
            </div>

            <div class="screen-list" :style="{ '--zoom': zoomLevel + '%' }">
                <div
                    v-for="(screen, index) in displayScreens"
                    :key="screen.screenId"
                    :ref="el => setScreenRef(screen.screenId, el as HTMLElement | null)"
                    class="screen"
                >
                    <div class="screen-meta">
                        <div class="flex items-center gap-3 min-w-0">
                            <button
                                v-if="needsReview(screen) && screen.currentBuildScreen?.reviewStatus"
                                class="btn ghost collapse-toggle"
                                v-tooltip="isCollapsed(screen) ? 'Expand' : 'Collapse'"
                                :aria-label="`${isCollapsed(screen) ? 'Expand' : 'Collapse'} ${screen.name}`"
                                :aria-expanded="!isCollapsed(screen)"
                                @click="toggleExpanded(screen)"
                            >
                                <i class="fa" :class="isCollapsed(screen) ? 'fa-chevron-right' : 'fa-chevron-down'" />
                            </button>

                            <span class="screen-number tag">{{ index + 1 }}</span>

                            <span class="screen-name">{{ screen.name }}</span>

                            <span
                                v-if="screen.currentBuildScreen?.reviewStatus"
                                class="review-badge tag"
                                :class="screen.currentBuildScreen.reviewStatus === 'approved' ? 'success' : 'danger'"
                            >
                                <i class="fa" :class="screen.currentBuildScreen.reviewStatus === 'approved' ? 'fa-check' : 'fa-xmark'" />
                                {{ screen.currentBuildScreen.reviewStatus === 'approved' ? 'Approved' : 'Rejected' }}
                            </span>
                        </div>

                        <span v-if="showChanges" class="screen-status tag" :class="getStatusStyle(screen.currentBuildScreen?.status)">{{
                            screen.currentBuildScreen ? getStatusText(screen.currentBuildScreen.status) : 'Removed'
                        }}</span>
                    </div>

                    <div
                        v-if="
                            !showChanges ||
                            !screen.currentBuildScreen ||
                            !screen.referenceBuildScreen ||
                            screen.currentBuildScreen.status !== 'no changes'
                        "
                        v-show="!isCollapsed(screen)"
                        class="image-wrapper-outer"
                        :class="{ single: !showChanges }"
                    >
                        <div v-if="showChanges" class="labels">
                            <span>Reference Build</span>
                            <span>New Build</span>
                        </div>

                        <div class="scroll-frame">
                            <div class="images">
                                <div v-if="showChanges" class="image-wrapper left">
                                    <div v-if="!screen.referenceBuildScreen" class="placeholder">
                                        <span>Screen does not exist in reference build</span>
                                    </div>
                                    <div v-else-if="screen.referenceBuildScreen?.imageSrc === false" class="error" />
                                    <Loader v-else-if="!screen.referenceBuildScreen?.imageSrc" class="loading" />
                                    <img
                                        v-else
                                        :src="screen.referenceBuildScreen?.imageSrc"
                                        :alt="`Reference screenshot: ${screen.name}`"
                                        @load="setNaturalWidth"
                                    />
                                </div>

                                <div
                                    class="image-wrapper right"
                                    :class="{ 'diff-toggleable': showChanges && screen.referenceBuildScreen }"
                                    @click="onImageShiftClick($event)"
                                >
                                    <span v-if="showChanges && screen.referenceBuildScreen" class="diff-hint">
                                        <i class="fa fa-layer-group fa-sm" />
                                        Shift+click to {{ diffShown ? 'hide' : 'show' }} all diffs
                                    </span>

                                    <div v-if="!screen.currentBuildScreen" class="placeholder">
                                        <span>Screen has been removed</span>
                                    </div>

                                    <template v-else>
                                        <div class="image-wrapper-inner" :class="{ 'opacity-0': diffShown }">
                                            <div v-if="screen.currentBuildScreen?.imageSrc === false" class="error" />
                                            <Loader v-else-if="!screen.currentBuildScreen?.imageSrc" class="loading" />
                                            <img
                                                v-else
                                                :src="screen.currentBuildScreen.imageSrc"
                                                :alt="`New build screenshot: ${screen.name}`"
                                                @load="setNaturalWidth"
                                            />
                                        </div>

                                        <div v-if="diffShown" class="image-wrapper-inner diff">
                                            <div v-if="!screen.referenceBuildScreen" class="placeholder">
                                                <span>No diff available since this screen is new</span>
                                            </div>
                                            <div v-else-if="screen.diffImageSrc === false" class="error" />
                                            <Loader v-else-if="!screen.diffImageSrc" class="loading" />
                                            <img v-else :src="screen.diffImageSrc" :alt="`Visual diff: ${screen.name}`" @load="setNaturalWidth" />
                                        </div>
                                    </template>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div v-if="!isCollapsed(screen) && showChanges && needsReview(screen)" class="review-bar">
                        <textarea
                            v-model="screen.reviewCommentDraft"
                            class="input review-comment"
                            rows="1"
                            placeholder="Leave a comment (optional)"
                            :disabled="screen.reviewSubmitting"
                        />

                        <div class="review-actions">
                            <button
                                class="btn approve"
                                :class="{ active: screen.currentBuildScreen?.reviewStatus === 'approved' }"
                                :disabled="screen.reviewSubmitting"
                                @click="submitReview(screen, 'approved')"
                            >
                                Approve
                            </button>
                            <button
                                class="btn reject"
                                :class="{ active: screen.currentBuildScreen?.reviewStatus === 'rejected' }"
                                :disabled="screen.reviewSubmitting"
                                @click="submitReview(screen, 'rejected')"
                            >
                                Reject
                            </button>
                        </div>
                    </div>

                    <div v-if="isCollapsed(screen)" class="collapsed-summary" @click="toggleExpanded(screen)">
                        <span v-if="screen.currentBuildScreen?.reviewComment" class="comment-preview">
                            <i class="fa fa-comment fa-sm" />
                            {{ screen.currentBuildScreen.reviewComment }}
                        </span>
                        <span v-else class="comment-preview empty">No comment</span>

                        <span class="expand-hint">
                            <i class="fa fa-chevron-right fa-sm" />
                            Expand
                        </span>
                    </div>
                </div>
            </div>

            <div v-if="hasPendingChanges" class="button-wrapper">
                <button class="btn primary" @click="submitBuild">{{ submitLabel }}</button>
            </div>
        </template>
    </div>
</template>

<script lang="ts" setup>
import { dataFrom, dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { formatError, handleError, handleErrorAndAlert, showAlert, showConfirm } from '@zyno-io/vue-foundation';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import {
    AppsApi,
    BuildScreensApi,
    BuildsApi,
    type IAppShowResponse,
    type IBuildResponse,
    type IBuildScreenResponse
} from '@/openapi-client-generated';
import LoaderModal from '@/shared/components/loader-modal.vue';
import Loader from '@/shared/components/loader.vue';

const route = useRoute();

interface IScreen extends IBuildScreenResponse {
    diffImageSrc?: string | false;
    reviewCommentDraft?: string;
    reviewExpanded?: boolean;
    reviewSubmitting?: boolean;
    currentBuildScreen?: IBuildScreenResponse['currentBuildScreen'] & {
        imageSrc?: string | false;
    };
    referenceBuildScreen?: IBuildScreenResponse['referenceBuildScreen'] & {
        imageSrc?: string | false;
    };
}

const isLoading = ref(true);

const app = ref<IAppShowResponse>();
const build = ref<IBuildResponse>();
const screens = ref<IScreen[]>();
const loadError = ref<string>();
const showChanges = ref(true);
const showDiff = ref(false);
const zoomOptions = [25, 50, 75, 100];

const zoomStorageKey = `pixelci:zoom:${route.params.id}`;
const savedZoom = Number(localStorage.getItem(zoomStorageKey));
const zoomLevel = ref(zoomOptions.includes(savedZoom) ? savedZoom : 100);
watch(zoomLevel, v => localStorage.setItem(zoomStorageKey, String(v)));

const displayScreens = computed(() => {
    if (showChanges.value) return screens.value;
    return screens.value?.filter(screen => screen.currentBuildScreen);
});

const totalScreens = computed(() => displayScreens.value?.length ?? 0);

// Diffs are shown/hidden globally; shift+clicking any screenshot toggles this just like the header checkbox.
const diffShown = computed(() => showChanges.value && showDiff.value);

const commitUrl = computed(() => {
    if (app.value?.commitUrlBase && build.value?.commitHash) {
        return `${app.value.commitUrlBase}/${build.value.commitHash}`;
    }
    return null;
});

const hasPendingChanges = computed(() =>
    screens.value?.some(screen => screen.currentBuildScreen?.status === 'new' || screen.currentBuildScreen?.status === 'needs review')
);

const reviewableScreens = computed(() => screens.value?.filter(needsReview) ?? []);
const approvedScreenCount = computed(() => reviewableScreens.value.filter(s => s.currentBuildScreen?.reviewStatus === 'approved').length);
const rejectedScreenCount = computed(() => reviewableScreens.value.filter(s => s.currentBuildScreen?.reviewStatus === 'rejected').length);
const unreviewedScreenCount = computed(() => reviewableScreens.value.filter(s => !s.currentBuildScreen?.reviewStatus).length);

// Submit auto-approves any unreviewed screens; the label spells out the resulting approvals/rejections.
const submitLabel = computed(() => {
    const approvals = approvedScreenCount.value;
    const rejections = rejectedScreenCount.value;
    const unreviewed = unreviewedScreenCount.value;
    if (unreviewed === 0 && rejections === 0) return 'Approve All';

    const totalApprovals = approvals + unreviewed;
    const parts = [`${totalApprovals} ${totalApprovals === 1 ? 'approval' : 'approvals'}`];
    if (rejections > 0) parts.push(`${rejections} ${rejections === 1 ? 'rejection' : 'rejections'}`);

    const submit = `Submit ${parts.join(', ')}`;
    return unreviewed > 0 ? `Auto-approve ${unreviewed} + ${submit}` : submit;
});

function needsReview(screen: IScreen) {
    return screen.currentBuildScreen?.status === 'new' || screen.currentBuildScreen?.status === 'needs review';
}

function isCollapsed(screen: IScreen) {
    return needsReview(screen) && !!screen.currentBuildScreen?.reviewStatus && !screen.reviewExpanded;
}

function toggleExpanded(screen: IScreen) {
    screen.reviewExpanded = !screen.reviewExpanded;
}

// Shift+click on any screenshot toggles the diff overlay for ALL screens, mirroring the header checkbox.
function onImageShiftClick(e: MouseEvent) {
    if (!e.shiftKey || !showChanges.value) return;
    e.preventDefault();
    showDiff.value = !showDiff.value;
}

const screenRefs = new Map<string, HTMLElement>();

function setScreenRef(screenId: string, el: HTMLElement | null) {
    if (el) screenRefs.set(screenId, el);
    else screenRefs.delete(screenId);
}

// After a screen collapses on review, bring the next screen's header to the top of the viewport.
async function scrollToNextScreen(current: IScreen) {
    const list = displayScreens.value;
    if (!list) return;

    const idx = list.findIndex(s => s.screenId === current.screenId);
    if (idx < 0 || idx >= list.length - 1) return;

    const next = list[idx + 1];
    await nextTick();
    screenRefs.get(next.screenId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Cap the rendered width at the screenshot's intrinsic size so images are never stretched larger than actual.
function setNaturalWidth(e: Event) {
    const img = e.target as HTMLImageElement;
    img.style.setProperty('--natural-width', `${img.naturalWidth}px`);
}

async function submitReview(screen: IScreen, reviewStatus: 'approved' | 'rejected') {
    if (!screen.currentBuildScreen) return;

    try {
        screen.reviewSubmitting = true;
        const result = await dataFromAsync(
            BuildScreensApi.postBuildScreensReviewScreen({
                path: {
                    appId: String(route.params.id),
                    id: String(route.params.buildId),
                    screenId: screen.screenId
                },
                body: { reviewStatus, comment: screen.reviewCommentDraft ?? '' }
            })
        );

        screen.currentBuildScreen.reviewStatus = result.reviewStatus;
        screen.currentBuildScreen.reviewComment = result.reviewComment;
        screen.currentBuildScreen.reviewedById = result.reviewedById;
        screen.currentBuildScreen.reviewedAt = result.reviewedAt;
        screen.reviewExpanded = false;
        scrollToNextScreen(screen);
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        screen.reviewSubmitting = false;
    }
}

onMounted(load);

async function load() {
    try {
        const appId = String(route.params.id);
        const buildId = String(route.params.buildId);

        const [screensResponse, appResponse, buildResponse] = await Promise.all([
            BuildScreensApi.getBuildScreensGetScreens({ path: { appId, id: buildId } }),
            AppsApi.getAppsShow({ path: { id: appId } }),
            BuildsApi.getBuildsGet({ path: { appId, id: buildId } })
        ]);

        screens.value = dataFrom(screensResponse);
        screens.value?.forEach(screen => {
            screen.reviewCommentDraft = screen.currentBuildScreen?.reviewComment ?? '';
        });
        app.value = dataFrom(appResponse);
        build.value = dataFrom(buildResponse);
        loadImages();
    } catch (err) {
        handleError(err);
        loadError.value = formatError(err);
    } finally {
        isLoading.value = false;
    }
}

async function loadImages() {
    if (!screens.value) return;

    for (const screen of screens.value) {
        if (screen.currentBuildScreen) {
            getScreenImage(screen.currentBuildScreen).then(imageSrc => {
                screen.currentBuildScreen!.imageSrc = imageSrc;
            });
        }

        if (screen.referenceBuildScreen) {
            getScreenImage(screen.referenceBuildScreen).then(imageSrc => {
                screen.referenceBuildScreen!.imageSrc = imageSrc;
            });
        }

        getScreenDiff(screen).then(diffImageSrc => {
            screen.diffImageSrc = diffImageSrc;
        });
    }
}

async function getScreenImage(screen: NonNullable<IScreen['currentBuildScreen']>) {
    try {
        const response = await BuildScreensApi.getBuildScreensGetScreenImage({
            path: {
                appId: String(route.params.id),
                id: screen.matchedBuildId ?? screen.buildId,
                screenId: screen.screenId
            }
        });
        return URL.createObjectURL(response.data as Blob);
    } catch (err) {
        handleError(err);
        return false;
    }
}

async function getScreenDiff(screen: IBuildScreenResponse) {
    if (!screen.currentBuildScreen || !screen.referenceBuildScreen || screen.currentBuildScreen.status === 'no changes') return false;

    try {
        const response = await BuildScreensApi.getBuildScreensGetScreenDiff({
            path: {
                appId: String(route.params.id),
                id: screen.currentBuildScreen.matchedBuildId ?? screen.currentBuildScreen.buildId,
                screenId: screen.screenId
            }
        });
        return URL.createObjectURL(response.data as Blob);
    } catch (err) {
        handleError(err);
        return false;
    }
}

async function submitBuild() {
    const rejections = rejectedScreenCount.value;
    const unreviewed = unreviewedScreenCount.value;

    let message = `Are you sure you'd like to submit these changes?`;
    if (rejections > 0) {
        message = `Submit with ${rejections} ${rejections === 1 ? 'rejection' : 'rejections'}? Rejected screens will fail the build.`;
    } else if (unreviewed > 0) {
        message = `Auto-approve ${unreviewed} unreviewed ${unreviewed === 1 ? 'screen' : 'screens'} and submit?`;
    }

    const response = await showConfirm(message);
    if (!response) return;

    try {
        isLoading.value = true;
        const { vcsUrl } = await dataFromAsync(
            BuildsApi.postBuildsApprove({
                path: { appId: String(route.params.id), id: String(route.params.buildId) }
            })
        );

        if (rejections > 0) {
            // The build is now rejected (failed); there's no CI job to follow. Show the result.
            location.href = `/apps/${route.params.id}`;
            return;
        }

        if (!vcsUrl) {
            await showAlert('Your review was submitted, but the VCS CI job could not be re-run automatically.');
            isLoading.value = false;
        } else {
            location.href = vcsUrl;
        }
    } catch (err) {
        handleErrorAndAlert(err);
        isLoading.value = false;
    }
}

function getStatusText(status: NonNullable<IBuildScreenResponse['currentBuildScreen']>['status']) {
    switch (status) {
        case 'new':
            return 'New';
        case 'no changes':
            return 'No Changes';
        case 'needs review':
            return 'Needs Review';
        case 'changes approved':
            return 'Changes Approved';
        default:
            return '';
    }
}

function getStatusStyle(status?: NonNullable<IBuildScreenResponse['currentBuildScreen']>['status']) {
    switch (status) {
        case 'changes approved':
            return 'success';
        case 'needs review':
            return 'warning';
        case 'no changes':
            return 'info';
        case 'new':
            return 'release';
        default:
            return '';
    }
}
</script>

<style lang="scss" scoped>
#screens {
    .header-center {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
    }
    .screen-count {
        height: 24px;
        flex-shrink: 0;
    }
    .commit-info {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        max-width: 400px;
        color: var(--text-2);
        font-size: 12px;
        text-decoration: none;
    }
    .commit-info .truncate {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    a.commit-info:hover {
        color: var(--link);
    }
    .screen-list {
        display: flex;
        flex-direction: column;
        gap: 16px;
    }
    .screen {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 16px 18px;
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--surface);
        box-shadow: var(--shadow-sm);
        scroll-margin-top: 160px;
    }
    .screen-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
    }
    .screen-name {
        min-width: 0;
        overflow-wrap: anywhere;
        font-weight: 600;
    }
    .screen-number {
        flex-shrink: 0;
        font-family: var(--font-mono);
    }
    .collapse-toggle {
        width: 24px;
        height: 24px;
        padding: 0;
        flex-shrink: 0;
    }
    .review-bar {
        display: flex;
        align-items: stretch;
        gap: 8px;
        border-top: 1px solid var(--border);
        padding-top: 14px;
    }
    .review-comment {
        flex: 1;
        min-width: 0;
        min-height: 36px;
        height: auto;
        padding: 8px 10px;
        resize: vertical;
    }
    .review-actions {
        display: flex;
        gap: 8px;
    }
    .review-actions button {
        height: auto;
        min-height: 36px;
    }
    .approve {
        color: var(--success);
        border-color: var(--success-border);
        background: var(--success-soft);
    }
    .approve:hover:not(:disabled),
    .approve.active {
        color: var(--success);
        border-color: var(--success);
        background: var(--success-soft);
        box-shadow: inset 0 0 0 1px var(--success);
    }
    .reject {
        color: var(--danger);
        border-color: var(--danger-border);
        background: var(--danger-soft);
    }
    .reject:hover:not(:disabled),
    .reject.active {
        color: var(--danger);
        border-color: var(--danger);
        background: var(--danger-soft);
        box-shadow: inset 0 0 0 1px var(--danger);
    }
    .collapsed-summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding-top: 14px;
        border-top: 1px solid var(--border);
        color: var(--text-2);
        font-size: 13px;
        cursor: pointer;
    }
    .comment-preview {
        white-space: pre-line;
        overflow-wrap: anywhere;
    }
    .comment-preview.empty {
        display: block;
        min-height: 0;
        padding: 0;
        color: var(--text-3);
        font-style: italic;
    }
    .expand-hint {
        color: var(--text-3);
        white-space: nowrap;
    }
    .image-wrapper-outer {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-top: 14px;
        border-top: 1px solid var(--border);
    }
    .labels {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
    }
    .labels span {
        color: var(--text-3);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.045em;
        text-transform: uppercase;
        text-align: center;
    }
    // One shared scroll frame keeps reference and current screenshots in sync.
    .scroll-frame {
        overflow: auto;
        border-radius: var(--radius-sm);
        max-height: max(200px, calc(100vh - 23rem));
    }
    .images {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch;
        gap: 6px;
    }
    .single .images {
        grid-template-columns: minmax(0, 1fr);
    }
    .image-wrapper {
        position: relative;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        min-width: 0;
        border-radius: var(--radius-sm);
        background: var(--surface-3);
    }
    .image-wrapper-inner {
        width: 100%;
    }
    .image-wrapper-inner.diff {
        position: absolute;
        top: 0;
        left: 0;
        height: 100%;
    }
    .diff-hint {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 10;
        display: flex;
        align-items: center;
        gap: 6px;
        max-width: calc(100% - 16px);
        padding: 4px 8px;
        border-radius: var(--radius-sm);
        background: var(--text);
        color: var(--bg);
        opacity: 0;
        pointer-events: none;
        font-size: 11px;
        transition: opacity 0.15s;
    }
    .diff-toggleable:hover .diff-hint {
        opacity: 0.9;
    }
    img {
        display: block;
        height: auto;
        width: min(var(--zoom), var(--natural-width, 100%));
        margin: 0 auto;
        border-radius: var(--radius-sm);
    }
    .placeholder,
    .error {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-height: 180px;
        height: 100%;
        padding: 24px;
        border-radius: var(--radius-sm);
        background: var(--surface-2);
        color: var(--text-3);
        text-align: center;
    }
    .button-wrapper {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
        padding: 20px 0;
    }
}
@media (max-width: 900px) {
    #screens .header-center {
        width: 100%;
        order: 3;
    }
}
@media (max-width: 640px) {
    #screens .header > .flex {
        flex-wrap: wrap;
        gap: 10px;
    }
    #screens .screen {
        padding: 14px 12px;
    }
    #screens .screen-meta > div {
        flex-wrap: wrap;
    }
    #screens .review-bar {
        flex-direction: column;
    }
    #screens .review-actions {
        justify-content: flex-end;
    }
}
</style>
