<template>
    <div id="screens" class="full" :class="{ 'max-w-screen-xl mx-auto': !showChanges }">
        <LoaderModal v-if="isLoading" />

        <template v-else>
            <div class="header">
                <div class="flex gap-4 items-center">
                    <RouterLink :to="`/apps/${route.params.id}`">
                        <button class="back">
                            <i class="fa fa-arrow-left" />
                        </button>
                    </RouterLink>

                    <h1>Screens</h1>
                </div>

                <div class="header-center">
                    <span class="screen-count">{{ totalScreens }} {{ totalScreens === 1 ? 'screen' : 'screens' }}</span>

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

                    <select v-model="zoomLevel" class="zoom-select" data-testid="zoom-select">
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
                                class="collapse-toggle"
                                v-tooltip="isCollapsed(screen) ? 'Expand' : 'Collapse'"
                                @click="toggleExpanded(screen)"
                            >
                                <i class="fa" :class="isCollapsed(screen) ? 'fa-chevron-right' : 'fa-chevron-down'" />
                            </button>

                            <span class="screen-number">{{ index + 1 }}</span>

                            <span class="screen-name">{{ screen.name }}</span>

                            <span
                                v-if="screen.currentBuildScreen?.reviewStatus"
                                class="review-badge"
                                :class="
                                    screen.currentBuildScreen.reviewStatus === 'approved'
                                        ? 'bg-green-500/10 border-green-500/50 text-green-500'
                                        : 'bg-red-500/10 border-red-500/50 text-red-500'
                                "
                            >
                                <i class="fa" :class="screen.currentBuildScreen.reviewStatus === 'approved' ? 'fa-check' : 'fa-xmark'" />
                                {{ screen.currentBuildScreen.reviewStatus === 'approved' ? 'Approved' : 'Rejected' }}
                            </span>
                        </div>

                        <span v-if="showChanges" class="screen-status" :class="getStatusStyle(screen.currentBuildScreen?.status)">{{
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
                            class="review-comment"
                            rows="1"
                            placeholder="Leave a comment (optional)"
                            :disabled="screen.reviewSubmitting"
                        />

                        <div class="review-actions">
                            <button
                                class="approve"
                                :class="{ active: screen.currentBuildScreen?.reviewStatus === 'approved' }"
                                :disabled="screen.reviewSubmitting"
                                @click="submitReview(screen, 'approved')"
                            >
                                Approve
                            </button>
                            <button
                                class="reject"
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
                <button class="primary" @click="submitBuild">{{ submitLabel }}</button>
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
            return 'bg-green-500/10 border-green-500/50 text-green-500';
        case 'needs review':
            return 'bg-red-500/10 border-red-500/50 text-red-500';
        case 'no changes':
            return 'bg-blue-500/10 border-blue-500/50 text-blue-500';
        default:
            return '';
    }
}
</script>

<style lang="scss" scoped>
@reference "tailwindcss";

#screens {
    .header-center {
        @apply flex items-center gap-4 min-w-0;
    }

    .screen-count {
        @apply shrink-0 px-2.5 py-1 rounded-md text-sm font-medium tabular-nums bg-neutral-500/15 border border-neutral-500/25 text-neutral-400 whitespace-nowrap;
    }

    .commit-info {
        @apply flex items-center gap-2 text-neutral-400 text-sm max-w-[400px] no-underline;

        .truncate {
            @apply overflow-hidden text-ellipsis whitespace-nowrap;
        }

        &:is(a):hover {
            @apply text-blue-400 transition-colors;
        }
    }

    .screen-list {
        @apply flex flex-col gap-4;
    }

    .screen {
        @apply relative flex flex-col gap-4 p-4 bg-neutral-500/10 border border-neutral-500/25 rounded-md scroll-mt-20;

        .screen-meta {
            @apply flex justify-between gap-4;

            .screen-status {
                @apply px-2 py-1 border rounded-md text-sm whitespace-nowrap;
            }
        }

        .screen-number {
            @apply shrink-0 px-2 py-0.5 rounded-md text-sm font-mono font-medium tabular-nums bg-neutral-500/15 border border-neutral-500/25 text-neutral-400;
        }

        .collapse-toggle {
            @apply w-5 shrink-0 p-0 border-0 bg-transparent text-neutral-400 transition-colors hover:text-neutral-200;

            &:hover {
                @apply bg-transparent;
            }
        }

        .review-badge {
            @apply flex items-center gap-1.5 px-2 py-1 border rounded-md text-sm whitespace-nowrap;
        }

        .review-bar {
            @apply flex items-stretch gap-2 border-t border-neutral-500/25 pt-4;

            .review-comment {
                @apply flex-1 px-3 py-2 text-sm rounded-md bg-neutral-500/10 border border-neutral-500/25 outline-none;
                resize: vertical;
                min-height: 2.5rem;

                &:focus {
                    @apply border-neutral-500/50;
                }
            }

            .review-actions {
                @apply flex gap-2;

                button {
                    @apply px-5 rounded-md text-sm font-medium border transition-colors;

                    &.approve {
                        @apply bg-green-500/10 border-green-500/50 text-green-500;

                        &:hover:not(:disabled),
                        &.active {
                            @apply bg-green-500 text-white;
                        }
                    }

                    &.reject {
                        @apply bg-red-500/10 border-red-500/50 text-red-500;

                        &:hover:not(:disabled),
                        &.active {
                            @apply bg-red-500 text-white;
                        }
                    }

                    &:disabled {
                        @apply opacity-50 cursor-not-allowed;
                    }
                }
            }
        }

        .collapsed-summary {
            @apply flex items-center justify-between gap-4 text-sm text-neutral-400 cursor-pointer border-t border-neutral-500/25 pt-4;

            .comment-preview {
                @apply whitespace-pre-line;

                &.empty {
                    @apply italic text-neutral-500;
                }
            }

            .expand-hint {
                @apply text-neutral-500 whitespace-nowrap;
            }
        }

        .image-wrapper-outer {
            @apply flex flex-col border-t border-neutral-500/25 pt-4 gap-1 duration-500 ease-in-out;

            .labels {
                @apply grid grid-cols-2 gap-1;

                span {
                    @apply text-center font-bold uppercase text-neutral-500;
                }
            }

            // Cap the comparison at one viewport so very tall screenshots scroll internally instead of
            // stretching the page. Both columns live in this single scroller, so they stay pixel-synced.
            // The offset reserves room for the sticky header + this card's meta/labels above and the
            // review bar (comment + approve/reject) below, so those stay on-screen with the frame.
            .scroll-frame {
                @apply overflow-y-auto rounded-md;
                max-height: calc(100vh - 23rem);

                .images {
                    @apply grid grid-cols-2 gap-1 items-stretch;
                }
            }

            &.single .scroll-frame .images {
                @apply grid-cols-1;
            }

            .image-wrapper {
                @apply flex items-start justify-center bg-neutral-500/25 rounded-md relative;

                .image-wrapper-inner {
                    @apply w-full;

                    &.diff {
                        @apply absolute top-0 left-0 h-full;
                    }
                }

                .diff-hint {
                    @apply absolute top-2 right-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded-md text-xs normal-case font-normal bg-neutral-900/70 text-neutral-200 opacity-0 pointer-events-none transition-opacity duration-150;
                }

                &.diff-toggleable:hover .diff-hint {
                    @apply opacity-100;
                }
            }

            img {
                @apply h-auto rounded-md mx-auto;
                width: min(var(--zoom), var(--natural-width, 100%));
            }

            .placeholder {
                @apply flex items-center justify-center bg-neutral-500/25 h-full w-full rounded-md;

                span {
                    @apply text-2xl text-neutral-500 p-24;
                }
            }

            .error {
                @apply flex items-center justify-center bg-neutral-500/25 h-full w-full rounded-md;
            }
        }
    }

    .zoom-select {
        @apply text-sm py-1 px-2 cursor-pointer;
    }

    .button-wrapper {
        @apply py-4 flex gap-4 items-center justify-end;

        button:disabled {
            @apply opacity-50 cursor-not-allowed;
        }
    }
}
</style>
