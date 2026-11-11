<template>
    <div id="screens" class="full" :style="stickyStyle">
        <LoaderModal v-if="isLoading" />

        <template v-else>
            <div ref="pageHeader" class="header">
                <div class="header-title">
                    <RouterLink :to="buildsPath" class="btn back" aria-label="Back to builds">
                        <i class="fa fa-arrow-left" aria-hidden="true" />
                    </RouterLink>

                    <h1 :title="app?.name">{{ app?.name ?? (build ? 'Build' : 'Build unavailable') }}</h1>
                </div>

                <div v-if="build" class="header-center">
                    <span class="context-item branch" :title="build.branchName">
                        <i class="fa fa-code-branch fa-sm" aria-hidden="true" />
                        <span class="truncate">{{ build.branchName }}</span>
                    </span>

                    <component
                        :is="commitUrl ? 'a' : 'span'"
                        class="context-item commit"
                        :href="commitUrl ?? undefined"
                        :target="commitUrl ? '_blank' : undefined"
                        v-tooltip="build.commitSubject"
                    >
                        <i class="fa fa-code-commit fa-sm" aria-hidden="true" />
                        <span class="mono hash">{{ shortHash }}</span>
                        <span class="truncate subject">{{ build.commitSubject }}</span>
                    </component>

                    <span v-if="buildStatus" class="tag build-status" :class="buildStatus.tone" data-testid="build-status">
                        <i v-if="buildStatus.icon" class="fa fa-fw" :class="buildStatus.icon" aria-hidden="true" />
                        {{ buildStatus.label }}
                    </span>
                </div>

                <div v-if="screens" class="header-tools">
                    <ScreensSegmented v-model="filter" label="Screens to show" :options="filterOptions" />

                    <label class="diff-toggle" v-tooltip="'Shift+click a screenshot to toggle, or hold D to flash the diff'">
                        <input type="checkbox" v-model="showDiff" data-testid="diff-check" />
                        Diff
                    </label>

                    <ScreensSegmented v-model="zoom" label="Zoom" :options="ZOOM_OPTIONS" />
                </div>
            </div>

            <div v-if="loadError" class="notice danger load-error" role="alert">
                <i class="fa fa-triangle-exclamation" aria-hidden="true" />
                <div class="notice-body">This build couldn't be loaded. It may have been removed, or you may not have access.</div>
                <div class="notice-actions">
                    <RouterLink :to="buildsPath" class="btn">Back to builds</RouterLink>
                </div>
            </div>

            <div v-else-if="!displayScreens.length" class="card">
                <div class="empty">
                    <i class="fa fa-circle-check" aria-hidden="true" />
                    <h2>{{ screens?.length ? 'Nothing in this build needs review.' : 'This build has no screens.' }}</h2>
                </div>
            </div>

            <template v-else>
                <div class="screen-list" :data-zoom="zoom">
                    <div
                        v-for="(screen, index) in displayScreens"
                        :key="screen.screenId"
                        :ref="el => setScreenRef(screen.screenId, el as HTMLElement | null)"
                        class="screen"
                        :class="{ 'is-active': activeScreenId === screen.screenId }"
                        tabindex="-1"
                        role="group"
                        :aria-labelledby="`screen-name-${screen.screenId}`"
                        @focusin="activeScreenId = screen.screenId"
                        @pointerdown="activeScreenId = screen.screenId"
                    >
                        <div class="screen-meta">
                            <div class="screen-title">
                                <button
                                    v-if="isCollapsible(screen)"
                                    type="button"
                                    class="btn ghost collapse-toggle"
                                    v-tooltip="isCollapsed(screen) ? 'Expand' : 'Collapse'"
                                    :aria-label="`${isCollapsed(screen) ? 'Expand' : 'Collapse'} ${screen.name}`"
                                    :aria-expanded="!isCollapsed(screen)"
                                    @click="toggleExpanded(screen)"
                                >
                                    <i class="fa" :class="isCollapsed(screen) ? 'fa-chevron-right' : 'fa-chevron-down'" aria-hidden="true" />
                                </button>

                                <span class="screen-number tag" aria-hidden="true">{{ index + 1 }}</span>

                                <h2 :id="`screen-name-${screen.screenId}`" class="screen-name">{{ screen.name }}</h2>
                            </div>

                            <span
                                v-if="screen.currentBuildScreen?.reviewStatus"
                                class="review-badge tag"
                                :class="screen.currentBuildScreen.reviewStatus === 'approved' ? 'success' : 'danger'"
                            >
                                <i
                                    class="fa"
                                    :class="screen.currentBuildScreen.reviewStatus === 'approved' ? 'fa-check' : 'fa-xmark'"
                                    aria-hidden="true"
                                />
                                {{ screen.currentBuildScreen.reviewStatus === 'approved' ? 'Approved' : 'Rejected' }}
                            </span>
                            <span v-else-if="getScreenStatus(screen)" class="screen-status tag" :class="getScreenStatus(screen)!.tone">
                                {{ getScreenStatus(screen)!.label }}
                            </span>
                        </div>

                        <div v-show="!isCollapsed(screen)" class="image-wrapper-outer" :class="{ single: isUnchanged(screen) }">
                            <div v-if="!isUnchanged(screen)" class="labels">
                                <span>Reference build <span class="qualifier baseline">approved baseline</span></span>
                                <span>
                                    New build
                                    <span v-if="diffShown && isNew(screen)" class="qualifier">No diff: this screen is new</span>
                                </span>
                            </div>

                            <div class="panes">
                                <div v-if="!isUnchanged(screen)" class="pane-wrap">
                                    <span v-if="hasDiff(screen)" class="diff-hint" aria-hidden="true">
                                        <i class="fa fa-layer-group fa-sm" />
                                        {{ diffHint }}
                                    </span>

                                    <div
                                        class="image-wrapper left"
                                        :class="{ 'diff-toggleable': hasDiff(screen) }"
                                        @scroll="onPaneScroll"
                                        @click="onImageShiftClick($event, screen)"
                                    >
                                        <div class="pane-content">
                                            <div v-if="!screen.referenceBuildScreen" class="placeholder">
                                                <span v-if="screen.currentBuildScreen"
                                                    >New screen. There's no reference yet; approving makes this the baseline.</span
                                                >
                                                <span v-else>No reference screenshot.</span>
                                            </div>
                                            <div v-else-if="screen.referenceBuildScreen.imageSrc === false" class="placeholder">
                                                <span>This image couldn't be loaded.</span>
                                            </div>
                                            <Loader v-else-if="!screen.referenceBuildScreen.imageSrc" class="loading" />
                                            <img
                                                v-else
                                                :src="screen.referenceBuildScreen.imageSrc"
                                                :alt="`Reference screenshot: ${screen.name}`"
                                                @load="onImageLoad"
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div class="pane-wrap">
                                    <span v-if="hasDiff(screen)" class="diff-hint" aria-hidden="true">
                                        <i class="fa fa-layer-group fa-sm" />
                                        {{ diffHint }}
                                    </span>

                                    <div
                                        class="image-wrapper right"
                                        :class="{ 'diff-toggleable': hasDiff(screen) }"
                                        @scroll="onPaneScroll"
                                        @click="onImageShiftClick($event, screen)"
                                    >
                                        <div class="pane-content">
                                            <div v-if="!screen.currentBuildScreen" class="placeholder">
                                                <span>This screen is no longer in the build.</span>
                                            </div>

                                            <template v-else>
                                                <div class="image-wrapper-inner" :class="{ 'is-covered': diffShown && hasDiff(screen) }">
                                                    <div v-if="screen.currentBuildScreen.imageSrc === false" class="placeholder">
                                                        <span>This image couldn't be loaded.</span>
                                                    </div>
                                                    <Loader v-else-if="!screen.currentBuildScreen.imageSrc" class="loading" />
                                                    <img
                                                        v-else
                                                        :src="screen.currentBuildScreen.imageSrc"
                                                        :alt="`New build screenshot: ${screen.name}`"
                                                        @load="onImageLoad"
                                                    />
                                                </div>

                                                <div v-if="diffShown && hasDiff(screen)" class="image-wrapper-inner diff">
                                                    <div v-if="screen.diffImageSrc === false" class="placeholder">
                                                        <span>This image couldn't be loaded.</span>
                                                    </div>
                                                    <Loader v-else-if="!screen.diffImageSrc" class="loading" />
                                                    <img v-else :src="screen.diffImageSrc" :alt="`Visual diff: ${screen.name}`" @load="onImageLoad" />
                                                </div>
                                            </template>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div v-if="!isCollapsed(screen) && canReview(screen)" class="review-bar">
                            <textarea
                                v-model="screen.reviewCommentDraft"
                                class="input review-comment"
                                rows="1"
                                placeholder="Leave a comment (optional)"
                                :aria-label="`Comment on ${screen.name}`"
                                :disabled="screen.reviewSubmitting"
                            />

                            <div class="review-actions">
                                <button
                                    type="button"
                                    class="btn approve"
                                    :class="{ active: screen.currentBuildScreen?.reviewStatus === 'approved' }"
                                    :aria-pressed="screen.currentBuildScreen?.reviewStatus === 'approved'"
                                    :disabled="screen.reviewSubmitting"
                                    @click="submitReview(screen, 'approved')"
                                >
                                    Approve
                                </button>
                                <button
                                    type="button"
                                    class="btn reject"
                                    :class="{ active: screen.currentBuildScreen?.reviewStatus === 'rejected' }"
                                    :aria-pressed="screen.currentBuildScreen?.reviewStatus === 'rejected'"
                                    :disabled="screen.reviewSubmitting"
                                    @click="submitReview(screen, 'rejected')"
                                >
                                    Reject
                                </button>
                            </div>
                        </div>

                        <div v-if="isCollapsed(screen) && !isUnchanged(screen)" class="collapsed-summary" @click="toggleExpanded(screen)">
                            <span v-if="screen.currentBuildScreen?.reviewComment" class="comment-preview">
                                <i class="fa fa-comment fa-sm" aria-hidden="true" />
                                {{ screen.currentBuildScreen.reviewComment }}
                            </span>
                            <span v-else class="comment-preview is-empty">No comment</span>

                            <button
                                type="button"
                                class="btn ghost sm expand-hint"
                                :aria-label="`Expand ${screen.name}`"
                                @click.stop="toggleExpanded(screen)"
                            >
                                <i class="fa fa-chevron-right" aria-hidden="true" />
                                Expand
                            </button>
                        </div>
                    </div>
                </div>

                <div v-if="showDecisionBar" ref="decisionBar" class="decision-bar" data-testid="decision-bar">
                    <p class="progress">
                        {{ reviewedScreenCount }} of {{ reviewableScreens.length }} reviewed<template v-if="unreviewedScreenCount > 0">
                            · {{ unreviewedScreenCount }} unreviewed will be approved on submit</template
                        ><template v-if="removedScreenCount > 0"> · {{ removedScreenCount }} removed</template>
                    </p>

                    <p class="shortcuts">
                        <span><kbd>J</kbd>/<kbd>K</kbd> next/previous</span>
                        <span aria-hidden="true">·</span>
                        <span><kbd>A</kbd> approve</span>
                        <span aria-hidden="true">·</span>
                        <span><kbd>R</kbd> reject</span>
                        <span aria-hidden="true">·</span>
                        <span><kbd>D</kbd> diff</span>
                    </p>

                    <button type="button" class="btn primary" data-testid="submit-build" :disabled="isAnySubmitting" @click="submitBuild">
                        {{ submitLabel }}
                    </button>
                </div>
            </template>
        </template>

        <div class="sr-only" role="status" aria-live="polite">{{ announcement }}</div>
    </div>
</template>

<script lang="ts" setup>
import { dataFrom, dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { handleError, handleErrorAndAlert, presentOverlay, showAlert, showToast } from '@zyno-io/vue-foundation';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

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

import ScreensSegmented from './screens-segmented.vue';
import SubmitConfirm from './screens-submit-confirm.vue';

const route = useRoute();
const router = useRouter();

type Filter = 'review' | 'all';
type Zoom = 'fit' | '100' | '200';

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

const appId = String(route.params.id);
const buildId = String(route.params.buildId);
const buildsPath = `/apps/${appId}`;

const isLoading = ref(true);

const app = ref<IAppShowResponse>();
const build = ref<IBuildResponse>();
const screens = ref<IScreen[]>();
const loadError = ref(false);
const filter = ref<Filter>('review');
const showDiff = ref(false);
// While D is held the diff state is inverted, so a tap reads as a quick flash.
const diffHeld = ref(false);
const activeScreenId = ref<string>();
const announcement = ref('');

// ── Zoom ──
const ZOOM_OPTIONS: { value: Zoom; label: string; testId: string }[] = [
    { value: 'fit', label: 'Fit', testId: 'zoom-fit' },
    { value: '100', label: '100%', testId: 'zoom-100' },
    { value: '200', label: '200%', testId: 'zoom-200' }
];

// Stored as 'fit' / '100%' / '200%'. Older versions stored a bare number (a share of the column:
// 25/50/75/100); those, and anything unrecognised, become Fit. A bare '100' must not read as 1:1.
const zoomStorageKey = `pixelci:zoom:${appId}`;
const ZOOM_STORED: Record<Zoom, string> = { fit: 'fit', '100': '100%', '200': '200%' };
function readSavedZoom(): Zoom {
    try {
        const saved = localStorage.getItem(zoomStorageKey);
        return (Object.keys(ZOOM_STORED) as Zoom[]).find(z => ZOOM_STORED[z] === saved) ?? 'fit';
    } catch {
        return 'fit';
    }
}
const zoom = ref<Zoom>(readSavedZoom());
watch(zoom, v => {
    try {
        localStorage.setItem(zoomStorageKey, ZOOM_STORED[v]);
    } catch {
        // storage unavailable; the choice just won't persist
    }
});

// ── Derived state ──
const displayScreens = computed(() => {
    if (filter.value === 'review') return screens.value?.filter(showsInReviewFilter) ?? [];
    return screens.value ?? [];
});

const filterOptions = computed(() => [
    { value: 'review' as const, label: `Needs review (${reviewFilterCount.value})`, testId: 'filter-review' },
    { value: 'all' as const, label: `All screens (${screens.value?.length ?? 0})`, testId: 'filter-all' }
]);

const diffShown = computed(() => showDiff.value !== diffHeld.value);
const diffHint = computed(() => `Shift+click to ${diffShown.value ? 'hide' : 'show'} all diffs · Hold D to flash the diff`);

const shortHash = computed(() => build.value?.commitHash?.substring(0, 8) ?? '');

const commitUrl = computed(() => {
    if (app.value?.commitUrlBase && build.value?.commitHash) {
        return `${app.value.commitUrlBase}/${build.value.commitHash}`;
    }
    return null;
});

// Same tones, icons and wording as the build list.
const BUILD_STATUS: Record<IBuildResponse['status'], { label: string; tone: string; icon?: string }> = {
    'needs review': { label: 'Needs Review', tone: 'warning', icon: 'fa-magnifying-glass' },
    processing: { label: 'Processing', tone: 'warning', icon: 'fa-stopwatch' },
    'no changes': { label: 'No Changes', tone: 'info', icon: 'fa-check' },
    'changes approved': { label: 'Changes Approved', tone: 'success', icon: 'fa-check' },
    'changes rejected': { label: 'Changes Rejected', tone: 'danger', icon: 'fa-xmark' },
    failed: { label: 'Failed', tone: 'danger', icon: 'fa-xmark' },
    draft: { label: 'Draft', tone: '', icon: 'fa-pen-to-square' },
    canceled: { label: 'Canceled', tone: '' }
};
const buildStatus = computed(() => (build.value ? BUILD_STATUS[build.value.status] : undefined));

const SCREEN_STATUS: Record<string, { label: string; tone: string }> = {
    new: { label: 'New', tone: 'release' },
    'needs review': { label: 'Needs Review', tone: 'warning' },
    'no changes': { label: 'No Changes', tone: 'info' },
    'changes approved': { label: 'Changes Approved', tone: 'success' }
};

// Unknown or empty statuses get no tag at all rather than an empty one.
function getScreenStatus(screen: IScreen) {
    if (!screen.currentBuildScreen) return { label: 'Removed', tone: '' };
    return SCREEN_STATUS[screen.currentBuildScreen.status ?? ''];
}

const reviewableScreens = computed(() => screens.value?.filter(needsReview) ?? []);
// Screens removed from the build have nothing to review; they are listed (not counted as reviewable) under Needs review.
const removedScreenCount = computed(() => screens.value?.filter(isRemoved).length ?? 0);
const reviewFilterCount = computed(() => reviewableScreens.value.length + removedScreenCount.value);
// Reviewing is only possible while the build itself is awaiting review; every other build is read-only.
const isReviewable = computed(() => build.value?.status === 'needs review');
const showDecisionBar = computed(() => isReviewable.value && reviewableScreens.value.length > 0);
const isAnySubmitting = computed(() => !!screens.value?.some(s => s.reviewSubmitting));
const approvedScreenCount = computed(() => reviewableScreens.value.filter(s => s.currentBuildScreen?.reviewStatus === 'approved').length);
const rejectedScreenCount = computed(() => reviewableScreens.value.filter(s => s.currentBuildScreen?.reviewStatus === 'rejected').length);
const reviewedScreenCount = computed(() => approvedScreenCount.value + rejectedScreenCount.value);
const unreviewedScreenCount = computed(() => reviewableScreens.value.length - reviewedScreenCount.value);

// Submit auto-approves unreviewed screens, so any rejection is the only thing that changes the outcome.
// The counts live in the progress text and the confirm, not the button.
const submitLabel = computed(() => (rejectedScreenCount.value > 0 ? 'Submit review' : 'Approve build'));

function needsReview(screen: IScreen) {
    return screen.currentBuildScreen?.status === 'new' || screen.currentBuildScreen?.status === 'needs review';
}

function isRemoved(screen: IScreen) {
    return !screen.currentBuildScreen;
}

function isNew(screen: IScreen) {
    return !!screen.currentBuildScreen && !screen.referenceBuildScreen;
}

function isUnchanged(screen: IScreen) {
    return screen.currentBuildScreen?.status === 'no changes';
}

function showsInReviewFilter(screen: IScreen) {
    return needsReview(screen) || isRemoved(screen);
}

function canReview(screen: IScreen) {
    return isReviewable.value && needsReview(screen);
}

function hasDiff(screen: IScreen) {
    return !!screen.currentBuildScreen && !!screen.referenceBuildScreen && !isUnchanged(screen);
}

// Reviewed screens and unchanged screens fold to their header line; both expand with the chevron.
function isCollapsible(screen: IScreen) {
    return isUnchanged(screen) || (needsReview(screen) && !!screen.currentBuildScreen?.reviewStatus);
}

function isCollapsed(screen: IScreen) {
    return isCollapsible(screen) && !screen.reviewExpanded;
}

function toggleExpanded(screen: IScreen) {
    screen.reviewExpanded = !screen.reviewExpanded;
}

// Shift+click on any screenshot toggles the diff for ALL screens, mirroring the header checkbox.
function onImageShiftClick(e: MouseEvent, screen: IScreen) {
    if (!e.shiftKey || !hasDiff(screen)) return;
    e.preventDefault();
    showDiff.value = !showDiff.value;
}

// ── Sticky chrome ──
// The page header (top) and decision bar (bottom) are sticky and change height as they wrap. Their
// measured heights feed the comparison height cap and the cards' scroll margins.
const pageHeader = ref<HTMLElement>();
const decisionBar = ref<HTMLElement>();
const pageHeaderHeight = ref(0);
const decisionBarHeight = ref(0);

const resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
        const height = (entry.target as HTMLElement).offsetHeight;
        if (entry.target === pageHeader.value) pageHeaderHeight.value = height;
        if (entry.target === decisionBar.value) decisionBarHeight.value = height;
    }
});

function observeHeight(target: typeof pageHeader, height: typeof pageHeaderHeight) {
    watch(target, (el, old) => {
        if (old) resizeObserver.unobserve(old);
        if (el) resizeObserver.observe(el);
        else height.value = 0;
    });
}
observeHeight(pageHeader, pageHeaderHeight);
observeHeight(decisionBar, decisionBarHeight);

const stickyStyle = computed(() => ({
    '--page-header-h': `${pageHeaderHeight.value}px`,
    '--decision-bar-h': `${decisionBarHeight.value}px`
}));

// ── Locked panning ──
// Each comparison has two scroll panes (reference, new). Scrolling either moves the other to the same
// offset in both axes. A programmatic scroll fires its own scroll event; we remember the (clamped)
// offset we set so that echo is ignored instead of bouncing back to the pane the user is moving.
const pendingSync = new WeakMap<HTMLElement, { top: number; left: number }>();

function onPaneScroll(e: Event) {
    const source = e.currentTarget as HTMLElement;
    const expected = pendingSync.get(source);
    if (expected) {
        pendingSync.delete(source);
        if (Math.abs(source.scrollTop - expected.top) < 1 && Math.abs(source.scrollLeft - expected.left) < 1) return;
    }

    source
        .closest('.panes')
        ?.querySelectorAll<HTMLElement>('.image-wrapper')
        .forEach(pane => {
            if (pane !== source) syncPane(pane, source);
        });
}

function syncPane(pane: HTMLElement, source: HTMLElement) {
    const top = Math.min(source.scrollTop, Math.max(0, pane.scrollHeight - pane.clientHeight));
    const left = Math.min(source.scrollLeft, Math.max(0, pane.scrollWidth - pane.clientWidth));
    if (Math.abs(pane.scrollTop - top) < 1 && Math.abs(pane.scrollLeft - left) < 1) return;
    pendingSync.set(pane, { top, left });
    pane.scrollTop = top;
    pane.scrollLeft = left;
}

// An image that finishes loading late grows its pane's scroll range; pull the pane to its sibling's offset.
function syncPaneFromSibling(pane: HTMLElement | null) {
    pane?.closest('.panes')
        ?.querySelectorAll<HTMLElement>('.image-wrapper')
        .forEach(sibling => {
            if (sibling !== pane) syncPane(pane, sibling);
        });
}

// Record the screenshot's intrinsic width (200% renders at twice it) and re-sync its pane.
function onImageLoad(e: Event) {
    const img = e.target as HTMLImageElement;
    img.style.setProperty('--natural-width', `${img.naturalWidth}px`);
    syncPaneFromSibling(img.closest<HTMLElement>('.image-wrapper'));
}

// ── Screen refs, active screen, navigation ──
const screenRefs = new Map<string, HTMLElement>();

function setScreenRef(screenId: string, el: HTMLElement | null) {
    if (el) screenRefs.set(screenId, el);
    else screenRefs.delete(screenId);
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// The band of the viewport not covered by the sticky top bar + page header or the decision bar.
function visibleBand() {
    let top = 0;
    let bottom = window.innerHeight;
    if (pageHeader.value) top = Math.max(top, pageHeader.value.getBoundingClientRect().bottom);
    if (decisionBar.value) bottom = Math.min(bottom, decisionBar.value.getBoundingClientRect().top);
    return { top, bottom };
}

function visibleHeight(screen: IScreen) {
    const el = screenRefs.get(screen.screenId);
    if (!el) return 0;
    const { top, bottom } = visibleBand();
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top));
}

// A card counts as visible once at least half of what could be shown of it is; a sliver under the header doesn't.
function isScreenVisible(screen: IScreen, fully = false) {
    const el = screenRefs.get(screen.screenId);
    if (!el) return false;
    const { top, bottom } = visibleBand();
    const rect = el.getBoundingClientRect();
    if (fully) return rect.top >= top && rect.bottom <= bottom;
    return visibleHeight(screen) >= Math.min(rect.height, Math.max(0, bottom - top)) / 2;
}

function activateScreen(screen: IScreen, scroll = true) {
    activeScreenId.value = screen.screenId;
    const el = screenRefs.get(screen.screenId);
    if (!el) return;
    el.focus({ preventScroll: true });
    // Cards already fully in view stay put; anything else is brought to the top (below the sticky header).
    if (scroll && !isScreenVisible(screen, true)) {
        el.scrollIntoView({ behavior: prefersReducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
    }
}

function moveActive(step: 1 | -1) {
    const list = displayScreens.value;
    if (!list.length) return;

    const idx = list.findIndex(s => s.screenId === activeScreenId.value);
    const next = idx < 0 ? (step > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, idx + step));
    activateScreen(list[next]);
}

// After a screen collapses on review, bring the next undecided screen's header to the top of the viewport,
// searching forward first and then wrapping to screens above the current one.
async function scrollToNextScreen(current: IScreen, activeAtStart: string | undefined) {
    const list = displayScreens.value;
    const idx = list.findIndex(s => s.screenId === current.screenId);
    if (idx < 0) return;

    await nextTick();

    // The user moved to another card while the request was in flight; don't yank them back.
    if (activeScreenId.value !== activeAtStart) return;

    const isUndecided = (s: IScreen) => needsReview(s) && !s.currentBuildScreen?.reviewStatus;
    const next = list.slice(idx + 1).find(isUndecided) ?? list.slice(0, idx).find(isUndecided);
    if (!next) {
        // Nothing left to decide: keep focus on this card rather than losing it with the removed review bar.
        activateScreen(current, false);
        return;
    }

    activeScreenId.value = next.screenId;
    const el = screenRefs.get(next.screenId);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ behavior: prefersReducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
}

// If the filter hides the active screen, drop it so J/K start from the top of the new list.
watch(filter, () => {
    if (!displayScreens.value.some(s => s.screenId === activeScreenId.value)) activeScreenId.value = undefined;
});

// ── Keyboard ──
const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
    return target instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(target.type);
}

function isOverlayOpen() {
    return !!document.querySelector('.vf-modal-wrap:not(.hidden), dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]');
}

function onKeydown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (isTypingTarget(e.target) || isOverlayOpen()) return;
    if (isLoading.value || loadError.value || !screens.value) return;

    switch (e.key.toLowerCase()) {
        case 'j':
            e.preventDefault();
            moveActive(1);
            break;
        case 'k':
            e.preventDefault();
            moveActive(-1);
            break;
        case 'a':
            e.preventDefault();
            if (!e.repeat) reviewActive('approved');
            break;
        case 'r':
            e.preventDefault();
            if (!e.repeat) reviewActive('rejected');
            break;
        case 'd':
            e.preventDefault();
            if (!e.repeat) diffHeld.value = true;
            break;
    }
}

function onKeyup(e: KeyboardEvent) {
    if (e.key.toLowerCase() === 'd') diffHeld.value = false;
}

function releaseDiffFlash() {
    diffHeld.value = false;
}

function reviewActive(reviewStatus: 'approved' | 'rejected') {
    const screen = displayScreens.value.find(s => s.screenId === activeScreenId.value);
    if (!screen || !canReview(screen) || screen.reviewSubmitting) return;

    // If the active card is scrolled out of view, show which card is active instead of reviewing it blind.
    if (!isScreenVisible(screen)) {
        const topmost =
            displayScreens.value.find(s => isScreenVisible(s)) ??
            displayScreens.value.reduce<IScreen | undefined>(
                (best, s) => (visibleHeight(s) > (best ? visibleHeight(best) : 0) ? s : best),
                undefined
            );
        if (topmost) activateScreen(topmost, false);
        return;
    }
    submitReview(screen, reviewStatus);
}

// Re-setting to '' first makes an identical consecutive message announce again.
async function announce(message: string) {
    announcement.value = '';
    await nextTick();
    announcement.value = message;
}

async function submitReview(screen: IScreen, reviewStatus: 'approved' | 'rejected') {
    if (!screen.currentBuildScreen) return;
    const activeAtStart = activeScreenId.value;

    try {
        screen.reviewSubmitting = true;
        const result = await dataFromAsync(
            BuildScreensApi.postBuildScreensReviewScreen({
                path: { appId, id: buildId, screenId: screen.screenId },
                body: { reviewStatus, comment: screen.reviewCommentDraft ?? '' }
            })
        );

        screen.currentBuildScreen.reviewStatus = result.reviewStatus;
        screen.currentBuildScreen.reviewComment = result.reviewComment;
        screen.currentBuildScreen.reviewedById = result.reviewedById;
        screen.currentBuildScreen.reviewedAt = result.reviewedAt;
        screen.reviewExpanded = false;

        announce(
            `${screen.name} ${result.reviewStatus === 'rejected' ? 'rejected' : 'approved'}. ` +
                `${reviewedScreenCount.value} of ${reviewableScreens.value.length} reviewed.`
        );
        scrollToNextScreen(screen, activeAtStart);
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        screen.reviewSubmitting = false;
    }
}

onMounted(() => {
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('keyup', onKeyup);
    window.addEventListener('blur', releaseDiffFlash);
    load();
});

// Screenshots load as blobs; their object URLs live until revoked.
const objectUrls = new Set<string>();
let disposed = false;

function createObjectUrl(blob: Blob) {
    if (disposed) return false;
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    return url;
}

onBeforeUnmount(() => {
    disposed = true;
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('keyup', onKeyup);
    window.removeEventListener('blur', releaseDiffFlash);
    resizeObserver.disconnect();
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls.clear();
});

async function load() {
    const [screensResult, appResult, buildResult] = await Promise.allSettled([
        BuildScreensApi.getBuildScreensGetScreens({ path: { appId, id: buildId } }),
        AppsApi.getAppsShow({ path: { id: appId } }),
        BuildsApi.getBuildsGet({ path: { appId, id: buildId } })
    ]);
    if (disposed) return;

    // The app name is only header context; show it even when the build itself failed to load.
    try {
        if (appResult.status === 'fulfilled') app.value = dataFrom(appResult.value);
    } catch {
        // the header falls back to "Build unavailable"
    }

    try {
        if (screensResult.status === 'rejected') throw screensResult.reason;
        if (buildResult.status === 'rejected') throw buildResult.reason;

        const loadedScreens: IScreen[] = dataFrom(screensResult.value);
        loadedScreens.forEach(screen => {
            screen.reviewCommentDraft = screen.currentBuildScreen?.reviewComment ?? '';
        });
        build.value = dataFrom(buildResult.value);
        screens.value = loadedScreens;

        filter.value = loadedScreens.some(needsReview) ? 'review' : 'all';
        document.title = [app.value?.name, build.value.branchName, shortHash.value, 'PixelCI'].filter(Boolean).join(' · ');
        loadImages();
    } catch (err) {
        handleError(err);
        loadError.value = true;
        document.title = 'Build unavailable · PixelCI';
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

        // Unchanged screens only ever show the new screenshot.
        if (screen.referenceBuildScreen && !isUnchanged(screen)) {
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
                appId,
                id: screen.matchedBuildId ?? screen.buildId,
                screenId: screen.screenId
            }
        });
        return createObjectUrl(response.data as Blob);
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
                appId,
                id: screen.currentBuildScreen.matchedBuildId ?? screen.currentBuildScreen.buildId,
                screenId: screen.screenId
            }
        });
        return createObjectUrl(response.data as Blob);
    } catch (err) {
        handleError(err);
        return false;
    }
}

function plural(n: number, one: string, many: string) {
    return `${n} ${n === 1 ? one : many}`;
}

async function submitBuild() {
    if (isAnySubmitting.value) return;

    const rejections = rejectedScreenCount.value;
    const unreviewed = unreviewedScreenCount.value;
    const removed = removedScreenCount.value;

    const unreviewedNote = unreviewed > 0 ? `${plural(unreviewed, 'unreviewed screen', 'unreviewed screens')} will be approved as well. ` : '';
    let title: string;
    let message: string;
    let confirmLabel: string;
    if (rejections > 0) {
        title = `Submit with ${plural(rejections, 'rejection', 'rejections')}?`;
        message = `${unreviewedNote}Rejected screens will fail the build.`;
        confirmLabel = 'Submit review';
    } else {
        title = 'Approve this build?';
        message = `${unreviewedNote}PixelCI will re-run the CI job and take you to the pipeline.`;
        // A rejected build promotes nothing, so only an approval changes the baseline.
        if (removed > 0 && build.value?.branchId === app.value?.defaultBranchId)
            message += ` ${plural(removed, 'screen', 'screens')} removed from this build will leave the baseline.`;
        confirmLabel = 'Approve build';
    }

    const ok = await presentOverlay(SubmitConfirm, { title, message, confirmLabel });
    if (disposed || !ok || isAnySubmitting.value) return;

    // Reviews may have changed while the dialog was open.
    const finalRejections = rejectedScreenCount.value;

    try {
        isLoading.value = true;
        const { vcsUrl, vcsError, vcsNotice } = await dataFromAsync(BuildsApi.postBuildsApprove({ path: { appId, id: buildId } }));

        if (finalRejections > 0) {
            // The build is now rejected (failed); there's no CI job to follow. Return to the build list.
            await router.push(buildsPath);
            showToast({ message: 'Review submitted. The build was marked rejected.', durationSecs: 5 });
            return;
        }

        if (!vcsUrl) {
            if (build.value) build.value.status = 'changes approved';
            await showAlert(`Your review was submitted, but the VCS CI job could not be re-run automatically.${vcsError ? `\n\n${vcsError}` : ''}`);
            isLoading.value = false;
        } else if (vcsNotice) {
            // Informational (not an error): the re-run is deferred; continue to the workflow run afterwards.
            await showAlert(`Your review was submitted. ${vcsNotice}\n\n${vcsUrl}`);
            location.href = vcsUrl;
        } else {
            location.href = vcsUrl;
        }
    } catch (err) {
        handleErrorAndAlert(err);
        isLoading.value = false;
    }
}
</script>

<style lang="scss" scoped>
#screens {
    // Sticky chrome: the top bar plus the page header above, the decision bar below.
    --sticky-top: calc(var(--header-h) + var(--page-header-h, 56px));
    --sticky-bottom: var(--decision-bar-h, 0px);
    // Height a comparison pane may take so a card scrolled to the top shows its name, both screenshots
    // and its review bar between the sticky header and the decision bar. 196px is the card's own
    // chrome (padding, meta row, column labels, review bar) plus the scroll margins.
    --pane-max-h: max(200px, calc(100dvh - var(--sticky-top) - var(--sticky-bottom) - 196px));

    // ── Header ──
    // The sticky header and decision bar reach 4px past the content edge so the active card's outline
    // (2px at a 2px offset) slides under them instead of peeking out beside them.
    > .header,
    > .decision-bar {
        margin-inline: -4px;
        padding-inline: 4px;
    }
    .header-title {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
        flex: 0 1 auto;
    }
    .header-title h1 {
        min-width: 0;
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    // A size container so the context line truncates instead of propping the header open. Shrink
    // order: commit subject first (hidden outright when it would be a stub), then the branch.
    .header-center {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1 1 0;
        min-width: 0;
        container-type: inline-size;
    }
    .context-item {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        color: var(--text-2);
        font-size: 12px;
        white-space: nowrap;
        text-decoration: none;

        i {
            flex-shrink: 0;
            color: var(--text-3);
        }
    }
    .context-item .truncate {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .context-item.branch {
        flex: 0 1 auto;
        min-width: 56px;
        max-width: 220px;
    }
    .context-item.commit {
        flex: 0 20 auto;
        min-width: 72px;
    }
    @container (max-width: 420px) {
        .context-item .subject {
            display: none;
        }
    }
    .context-item .hash {
        flex-shrink: 0;
        color: var(--text);
    }
    a.context-item:hover,
    a.context-item:hover .hash {
        color: var(--link);
    }
    .build-status {
        height: 24px;
        flex-shrink: 0;
    }
    .header-tools {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
    }
    .diff-toggle {
        white-space: nowrap;
    }

    // ── Failure ──
    .load-error {
        align-items: center;
    }

    // ── Cards ──
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
        scroll-margin-top: calc(var(--sticky-top) + 12px);
        scroll-margin-bottom: calc(var(--sticky-bottom) + 12px);

        // The card itself takes focus only programmatically (J/K); the active ring below marks it instead.
        &:focus {
            outline: none;
        }

        &.is-active {
            outline: 2px solid var(--focus);
            outline-offset: 2px;
        }
    }
    .screen-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 24px;
    }
    .screen-title {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
    }
    .screen-name {
        min-width: 0;
        overflow-wrap: anywhere;
        font-size: 14px;
        font-weight: 600;
    }
    .screen-number {
        flex-shrink: 0;
        font-family: var(--font-mono);
    }
    .screen-meta > .tag {
        flex-shrink: 0;
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
        padding-top: 10px;
        border-top: 1px solid var(--border);
        color: var(--text-2);
        font-size: 13px;
        cursor: pointer;
    }
    .comment-preview {
        min-width: 0;
        white-space: pre-line;
        overflow-wrap: anywhere;
    }
    .comment-preview.is-empty {
        color: var(--text-3);
        font-style: italic;
    }
    .expand-hint {
        flex-shrink: 0;
        color: var(--text-3);

        i {
            font-size: 10px;
        }
    }

    // ── Comparison ──
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
    .labels > span {
        color: var(--text-3);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.045em;
        text-transform: uppercase;
        text-align: center;
    }
    .labels .qualifier {
        margin-left: 4px;
        font-weight: 400;
        letter-spacing: normal;
        text-transform: none;
    }
    .panes {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch;
        gap: 6px;
    }
    // An unchanged screen shows its one screenshot, capped like a single-image view.
    .single .panes {
        grid-template-columns: minmax(0, 1fr);
        width: 100%;
        max-width: 1280px;
        margin: 0 auto;
    }
    .pane-wrap {
        position: relative;
        display: flex;
        flex-direction: column;
        min-width: 0;
    }
    // Each pane scrolls on its own but is locked to its sibling (see onPaneScroll). The height cap keeps
    // tall or zoomed screenshots from pushing the name and review bar off screen.
    .image-wrapper {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        max-height: var(--pane-max-h);
        overflow: auto;
        border-radius: var(--radius-sm);
        background: var(--surface-3);
        scrollbar-gutter: stable;
        scrollbar-width: thin;
        scrollbar-color: var(--border-strong) transparent;
    }
    // A grid so its one in-flow child (image, loader or placeholder) stretches to fill the pane.
    .pane-content {
        position: relative;
        display: grid;
        min-height: 100%;
    }
    .image-wrapper-inner {
        width: 100%;
    }
    .image-wrapper-inner.is-covered {
        opacity: 0;
    }
    .image-wrapper-inner.diff {
        position: absolute;
        inset: 0;
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
    .pane-wrap:has(.diff-toggleable:hover) .diff-hint {
        opacity: 0.9;
    }
    img {
        display: block;
        height: auto;
        margin: 0 auto;
        border-radius: var(--radius-sm);
    }
    .placeholder {
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
        font-size: 13px;
        text-align: center;

        span {
            max-width: 340px;
        }
    }
    .loading {
        min-height: 180px;
        align-items: center;
    }

    // Zoom. Fit: scale down to the column, never above natural size. 100%: one image pixel per CSS
    // pixel. 200%: twice that, kept crisp. In the pixel modes the content box grows to the image so the
    // pane scrolls and the diff layer (inset: 0) matches the new screenshot exactly.
    [data-zoom='fit'] img {
        width: auto;
        max-width: 100%;
    }
    [data-zoom='100'],
    [data-zoom='200'] {
        .pane-content {
            width: max-content;
            min-width: 100%;
        }
        img {
            max-width: none;
        }
    }
    [data-zoom='100'] img {
        width: auto;
    }
    [data-zoom='200'] img {
        width: calc(var(--natural-width) * 2);
        image-rendering: pixelated;
    }

    // ── Decision bar ──
    .decision-bar {
        position: sticky;
        bottom: 0;
        z-index: 20;
        display: flex;
        align-items: center;
        gap: 8px 20px;
        margin-top: 16px;
        padding-block: 12px;
        border-top: 1px solid var(--border);
        background: var(--bg);

        .btn {
            flex-shrink: 0;
            margin-left: auto;
        }
    }
    .progress {
        flex: 0 1 auto;
        min-width: 0;
        color: var(--text);
        font-size: 13px;
        font-weight: 500;
    }
    .shortcuts {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 2px 6px;
        flex: 1 1 auto;
        min-width: 0;
        color: var(--text-3);
        font-size: 12px;

        > span {
            white-space: nowrap;
        }
    }
    kbd {
        display: inline-block;
        min-width: 18px;
        padding: 2px 4px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--surface-2);
        color: var(--text-2);
        font-family: var(--font-mono);
        font-size: 11px;
        line-height: 1;
        text-align: center;
    }
}
// Title (up to 320px) + context line (branch, commit, status) + the filter/zoom tools need about 1120px
// to share one row; below that the context line moves onto its own row.
@media (max-width: 1120px) {
    #screens .header-center {
        width: 100%;
        order: 3;
        flex-basis: 100%;
    }
}
@media (max-width: 900px) {
    #screens .decision-bar {
        flex-wrap: wrap;
    }
}
@media (max-width: 640px) {
    #screens .header-title,
    #screens .header-tools {
        flex-wrap: wrap;
        gap: 10px;
    }
    #screens .header-tools {
        flex-shrink: 1;
        min-width: 0;
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
    #screens .shortcuts {
        display: none;
    }
    #screens .labels .baseline {
        display: none;
    }
    #screens .progress {
        flex: 1 1 0;
    }
}
</style>
