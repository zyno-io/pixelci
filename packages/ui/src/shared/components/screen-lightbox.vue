<template>
    <A11yModal @close="emit('close')">
        <div class="lightbox" data-testid="lightbox">
            <header class="lb-bar">
                <div class="lb-nav">
                    <button
                        type="button"
                        class="btn icon"
                        aria-label="Previous screen"
                        v-tooltip="'Previous (←)'"
                        :disabled="index <= 0"
                        data-testid="lightbox-prev"
                        @click="step(-1)"
                    >
                        <i class="fa fa-chevron-left" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        class="btn icon"
                        aria-label="Next screen"
                        v-tooltip="'Next (→)'"
                        :disabled="index >= items.length - 1"
                        data-testid="lightbox-next"
                        @click="step(1)"
                    >
                        <i class="fa fa-chevron-right" aria-hidden="true" />
                    </button>
                    <span class="lb-count">{{ index + 1 }} of {{ items.length }}</span>
                </div>

                <h2 class="lb-name" :title="item.name">{{ item.name }}</h2>

                <div class="lb-tools">
                    <ScreensSegmented v-if="viewOptions.length > 1" v-model="view" label="Image to show" :options="viewOptions" />

                    <select v-model="zoom" class="select" aria-label="Screenshot zoom" data-testid="lightbox-zoom">
                        <option value="fit">Fit</option>
                        <option value="100">100%</option>
                        <option value="200">200%</option>
                    </select>

                    <button type="button" class="btn ghost icon" aria-label="Close" data-testid="lightbox-close" @click="emit('close')">
                        <i class="fa fa-xmark" aria-hidden="true" />
                    </button>
                </div>
            </header>

            <div class="lb-body">
                <div
                    ref="stage"
                    class="lb-stage"
                    :data-zoom="zoom"
                    tabindex="0"
                    role="group"
                    :aria-label="`${stageLabel}: ${item.name}`"
                    data-testid="lightbox-stage"
                >
                    <div v-if="stageSrc === false" class="lb-placeholder">This image couldn't be loaded.</div>
                    <div v-else-if="stageSrc === null" class="lb-placeholder">{{ missingText }}</div>
                    <Loader v-else-if="!stageSrc" class="lb-loading" />
                    <div v-else class="lb-canvas" :style="canvasStyle" data-testid="lightbox-canvas">
                        <img :key="stageSrc" :src="stageSrc" :alt="`${stageLabel}: ${item.name}`" @load="onImageLoad($event, stageSrc)" />
                        <MaskLayer
                            v-if="layerShown && natural"
                            v-model:masks="activeMasks"
                            v-bind:selected-id="selectedMaskId"
                            :width="natural.width"
                            :height="natural.height"
                            :context="contextMasks"
                            :editable="maskEditable"
                            :drawing="drawMode"
                            :aria-label="maskTarget === 'app' ? 'App masks' : 'Masks for this screen'"
                            @select="selectedMaskId = $event"
                            @remove="removeMask"
                            @draw-end="drawMode = false"
                            @dragging="maskDragging = $event"
                            @announce="announce"
                            @escape="onMaskEscape"
                        />
                    </div>
                </div>

                <div class="lb-panel" role="region" aria-label="Screen details">
                    <section class="lb-section">
                        <h3>Details</h3>
                        <dl class="lb-details">
                            <div v-if="item.status">
                                <dt>Status</dt>
                                <dd>
                                    <span class="tag" :class="item.status.tone">
                                        <i v-if="item.status.icon" class="fa" :class="item.status.icon" aria-hidden="true" />
                                        {{ item.status.label }}
                                    </span>
                                </dd>
                            </div>
                            <div v-for="row in item.meta ?? []" :key="row.label">
                                <dt>{{ row.label }}</dt>
                                <dd :class="{ mono: row.mono }">{{ row.value }}</dd>
                            </div>
                            <div v-if="dimensions">
                                <dt>Size</dt>
                                <dd>{{ dimensions }}</dd>
                            </div>
                        </dl>
                        <RouterLink v-if="item.link" :to="item.link.to" class="btn lb-link" @click="emit('close')">
                            {{ item.link.label }}
                            <i class="fa fa-arrow-right" aria-hidden="true" />
                        </RouterLink>
                    </section>

                    <section class="lb-section">
                        <div class="lb-section-head">
                            <h3>Tolerance</h3>
                            <span v-if="hasOverride(item.tolerances)" class="tag"><i class="fa fa-sliders" aria-hidden="true" /> Custom</span>
                        </div>
                        <p class="lb-lead">How strictly this screen is compared with its reference. Empty fields follow the app default.</p>

                        <ToleranceFields
                            v-model="draft"
                            :inherited="appTolerances"
                            inherited-label="app default"
                            :id-prefix="`lb-${item.screenId}`"
                            :disabled="isSaving"
                            @validity="isValid = $event"
                        />

                        <div
                            v-if="canCompare"
                            class="notice lb-preview"
                            :class="previewTone"
                            role="status"
                            aria-live="polite"
                            data-testid="tolerance-preview"
                        >
                            <i class="fa" :class="previewIcon" aria-hidden="true" />
                            <div class="notice-body">
                                <template v-if="preview">
                                    <strong>{{ preview.passes ? 'Would pass' : 'Would be flagged' }}</strong>
                                    <span v-if="preview.canvasTooLarge" class="lb-preview-line" data-testid="preview-canvas-too-large">
                                        These screenshots are too different in size to compare pixel by pixel, so every pixel counts as changed.
                                    </span>
                                    <span v-else class="lb-preview-line">
                                        {{ formatPct(preview.diffPct) }} of pixels differ ({{ preview.diffPixels.toLocaleString() }} px);
                                        {{ formatTolerance('diffPctTolerance', effective.diffPctTolerance) }} allowed.
                                    </span>
                                    <span v-if="preview.shiftTolerantPixels > 0" class="lb-preview-line">
                                        {{ preview.shiftTolerantPixels.toLocaleString() }} px ignored as shifted.
                                    </span>
                                    <span v-if="preview.maskedPixels > 0" class="lb-preview-line" data-testid="preview-masked">
                                        {{ preview.maskedPixels.toLocaleString() }} px masked.
                                    </span>
                                </template>
                                <template v-else-if="!previewValid">Correct the highlighted value to preview it.</template>
                                <template v-else-if="previewUnavailable">
                                    This screen matched its baseline and its own image has been cleaned up, so there is nothing to preview.
                                </template>
                                <template v-else-if="previewFailed">The comparison couldn't be run with these values.</template>
                                <template v-else>Comparing with these values…</template>
                            </div>
                            <div v-if="preview" class="notice-actions">
                                <button
                                    type="button"
                                    class="btn sm"
                                    :aria-pressed="view === 'diff'"
                                    data-testid="preview-show-diff"
                                    @click="view = view === 'diff' ? 'current' : 'diff'"
                                >
                                    {{ view === 'diff' ? 'Hide diff' : 'Show diff' }}
                                </button>
                            </div>
                        </div>
                        <p v-else class="lb-note">{{ noCompareText }}</p>

                        <p v-if="!canEdit" class="lb-note" data-testid="tolerance-readonly">
                            You can try values here, but only people who can review this app can save them.
                        </p>
                        <div v-else class="lb-save">
                            <p class="lb-note">Saved values apply from the next build. Results of earlier builds stay as they are.</p>
                            <div class="lb-save-row">
                                <span v-if="isDirty" class="lb-unsaved" role="status">Unsaved changes</span>
                                <button
                                    type="button"
                                    class="btn primary"
                                    :disabled="!isDirty || !isValid || isSaving"
                                    data-testid="tolerance-save"
                                    @click="save"
                                >
                                    Save for this screen
                                </button>
                            </div>
                        </div>
                    </section>

                    <section class="lb-section" aria-labelledby="lb-masks-title" data-testid="masks-section">
                        <div class="lb-section-head">
                            <h3 id="lb-masks-title">{{ maskTarget === 'app' ? 'App masks' : 'Masks' }}</h3>
                            <span v-if="activeMasks.length" class="tag" data-testid="mask-count">
                                <i class="fa fa-table-cells-large" aria-hidden="true" /> {{ formatMaskCount(activeMasks.length) }}
                            </span>
                        </div>
                        <p class="lb-lead">
                            <template v-if="maskTarget === 'app'">
                                Regions ignored on every screen that uses the app's masks. Changes there never count as differences.
                            </template>
                            <template v-else>Regions of this screen whose pixels never count as a difference, such as clocks or ads.</template>
                        </p>

                        <div v-if="maskTarget === 'app'" class="notice warning lb-app-mode" data-testid="app-mask-mode">
                            <i class="fa fa-globe" aria-hidden="true" />
                            <div class="notice-body">Editing the app's masks. They apply to every screen that uses them, not only this one.</div>
                            <div class="notice-actions">
                                <button type="button" class="btn sm" data-testid="app-masks-done" @click="leaveAppMasks">Back to screen</button>
                            </div>
                        </div>

                        <div v-if="maskEditable" class="lb-mask-tools" role="toolbar" aria-label="Mask tools">
                            <button
                                type="button"
                                class="btn sm"
                                :aria-pressed="drawMode"
                                :disabled="isSavingMasks || !natural"
                                data-testid="mask-draw"
                                @click="toggleDraw"
                            >
                                <i class="fa fa-crop-simple" aria-hidden="true" /> Draw mask
                            </button>
                            <button
                                type="button"
                                class="btn sm"
                                :disabled="isSavingMasks || !natural || activeMasks.length >= MAX_MASKS"
                                data-testid="mask-add"
                                @click="addMask()"
                            >
                                <i class="fa fa-plus" aria-hidden="true" /> Add mask
                            </button>
                            <button
                                type="button"
                                class="btn sm ghost"
                                :aria-pressed="!layerVisible"
                                data-testid="mask-toggle-layer"
                                @click="toggleLayer()"
                            >
                                <i class="fa" :class="layerVisible ? 'fa-eye-slash' : 'fa-eye'" aria-hidden="true" />
                                {{ layerVisible ? 'Hide masks' : 'Show masks' }}
                            </button>
                        </div>
                        <div v-else class="lb-mask-tools">
                            <button
                                type="button"
                                class="btn sm ghost"
                                :aria-pressed="!layerVisible"
                                data-testid="mask-toggle-layer"
                                @click="toggleLayer()"
                            >
                                <i class="fa" :class="layerVisible ? 'fa-eye-slash' : 'fa-eye'" aria-hidden="true" />
                                {{ layerVisible ? 'Hide masks' : 'Show masks' }}
                            </button>
                        </div>

                        <p v-if="drawMode" class="lb-note" data-testid="mask-draw-hint">Drag on the screenshot to draw a mask. Escape cancels.</p>

                        <label v-if="maskTarget === 'screen'" class="lb-check" :class="{ disabled: !maskEditable || isSavingMasks }">
                            <input
                                v-model="maskDraft.inherit"
                                type="checkbox"
                                :disabled="!maskEditable || isSavingMasks"
                                data-testid="mask-inherit"
                            />
                            <span>
                                Use app masks
                                <span class="lb-check-hint" data-testid="app-mask-count">
                                    {{ appMasksNow.length ? `(${formatMaskCount(appMasksNow.length)}, read-only here)` : '(the app has none)' }}
                                </span>
                            </span>
                        </label>
                        <div v-if="maskTarget === 'screen' && store.isAdmin" class="lb-app-edit">
                            <button type="button" class="btn sm" data-testid="app-masks-edit" :disabled="isSavingMasks" @click="enterAppMasks">
                                <i class="fa fa-globe" aria-hidden="true" /> Edit app masks
                            </button>
                            <span v-if="appDirty" class="lb-unsaved">Unsaved app masks</span>
                        </div>

                        <MaskFields
                            v-if="activeMasks.length"
                            v-model="activeMasks"
                            :selected-id="selectedMaskId"
                            :id-prefix="`lb-mask-${maskTarget}-${item.screenId}`"
                            :disabled="!maskEditable || isSavingMasks"
                            @select="selectedMaskId = $event"
                            @remove="removeMask"
                            @validity="masksFieldsValid = $event"
                        />
                        <p v-else class="lb-note" data-testid="mask-empty">
                            <template v-if="maskEditable">No masks yet. Draw one on the screenshot, or add one and set its position here.</template>
                            <template v-else>This screen has no masks of its own.</template>
                        </p>

                        <p v-if="listProblem" class="lb-note lb-problem" role="alert" data-testid="mask-problem">{{ listProblem }}</p>

                        <p v-if="outside.partly || outside.outside" class="lb-note lb-warn" data-testid="mask-outside">
                            <i class="fa fa-triangle-exclamation" aria-hidden="true" />
                            <template v-if="outside.partly">
                                {{ formatMaskCount(outside.partly) }} {{ outside.partly === 1 ? 'is' : 'are' }} partly outside this screenshot. The
                                part outside is ignored.
                            </template>
                            <template v-if="outside.outside">
                                {{ formatMaskCount(outside.outside) }} {{ outside.outside === 1 ? 'is' : 'are' }} entirely outside this screenshot and
                                {{ outside.outside === 1 ? 'has' : 'have' }} no effect here.
                            </template>
                        </p>
                        <p v-if="coverage > COVERAGE_WARNING_PCT" class="lb-note lb-warn" data-testid="mask-coverage">
                            <i class="fa fa-triangle-exclamation" aria-hidden="true" />
                            Masks cover {{ Math.round(coverage) }}% of this screenshot. Changes under them can't be flagged.
                        </p>

                        <div v-if="canCompare" class="lb-mask-preview" data-testid="mask-preview">
                            <template v-if="preview">
                                <strong>{{ preview.passes ? 'Would pass' : 'Would be flagged' }}</strong>
                                <span> · {{ preview.maskedPixels.toLocaleString() }} px masked</span>
                            </template>
                            <span v-else-if="!previewValid">Correct the highlighted value to preview it.</span>
                            <span v-else-if="previewFailed">No preview.</span>
                            <span v-else>Comparing…</span>
                        </div>

                        <p v-if="maskInfo" class="lb-note" data-testid="mask-saved-by">{{ maskInfo }}</p>

                        <p v-if="!canEditMaskTarget" class="lb-note" data-testid="mask-readonly">
                            Only people who can review this app can change masks.
                        </p>
                        <div v-else class="lb-save">
                            <p class="lb-note">Saved masks apply from the next build. Results of earlier builds stay as they are.</p>
                            <div class="lb-save-row">
                                <span v-if="activeMasksDirty" class="lb-unsaved" role="status">Unsaved changes</span>
                                <button
                                    type="button"
                                    class="btn primary"
                                    :disabled="!activeMasksDirty || !activeMasksValid || isSavingMasks"
                                    data-testid="masks-save"
                                    @click="saveMasks"
                                >
                                    {{ maskTarget === 'app' ? 'Save app masks' : 'Save masks' }}
                                </button>
                            </div>
                        </div>

                        <div class="sr-only" role="status" aria-live="polite" data-testid="mask-live">{{ announcement }}</div>
                    </section>

                    <p class="lb-keys">
                        <span><kbd>←</kbd>/<kbd>→</kbd> previous/next</span>
                        <template v-if="hasDiffView">
                            <span aria-hidden="true">·</span>
                            <span>hold <kbd>D</kbd> for the diff</span>
                        </template>
                        <template v-if="maskEditable">
                            <span aria-hidden="true">·</span>
                            <span><kbd>N</kbd> add mask</span>
                        </template>
                        <span aria-hidden="true">·</span>
                        <span><kbd>M</kbd> hide masks</span>
                        <template v-if="maskEditable">
                            <span aria-hidden="true">·</span>
                            <span class="wrap"
                                >on a mask: <kbd>←</kbd><kbd>↑</kbd><kbd>→</kbd><kbd>↓</kbd> move, <kbd>Alt</kbd> resize, <kbd>Shift</kbd> by 10,
                                <kbd>Del</kbd> remove</span
                            >
                        </template>
                        <span aria-hidden="true">·</span>
                        <span><kbd>Esc</kbd> close</span>
                    </p>
                </div>
            </div>
        </div>
    </A11yModal>
</template>

<script lang="ts" setup>
import type { RouteLocationRaw } from 'vue-router';

/**
 * Full-size view of one screen, stepped through with the arrow keys, with the screen's comparison
 * tolerances beside it. Where the screen has a reference in the build being viewed, the proposed
 * tolerances are run against that pair live, so the reviewer sees the resulting diff and verdict
 * before saving. Used by the galleries and by the review screen.
 */
import { dataFromAsync, OpenApiError } from '@zyno-io/openapi-client-codegen';
import { handleError, handleErrorAndAlert, showAlert, showToast } from '@zyno-io/vue-foundation';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { IStatusTag } from '@/shared/status';

import { useScreenImages, type ScreenImageRef, type ScreenImages } from '@/composables/useScreenImages';
import {
    AppsApi,
    BuildScreensApi,
    type IAppMasksResponse,
    type IBuildScreenCompareResponse,
    type IScreenMasksResponse,
    ScreensApi
} from '@/openapi-client-generated';
import ScreensSegmented from '@/screens/screens-segmented.vue';
import {
    cloneMasks,
    coveragePct,
    COVERAGE_WARNING_PCT,
    describeMask,
    formatMaskCount,
    type IMaskRect,
    listError,
    MAX_MASKS,
    newMaskId,
    outsideSummary,
    sameMasks
} from '@/shared/masks';
import {
    formatPct,
    formatTolerance,
    hasOverride,
    type IToleranceOverrides,
    type ITolerances,
    pickOverrides,
    resolveTolerances,
    sameOverrides
} from '@/shared/tolerances';
import { useStore } from '@/store';

import A11yModal from './a11y-modal.vue';
import Loader from './loader.vue';
import MaskFields from './mask-fields.vue';
import MaskLayer from './mask-layer.vue';
import ToleranceFields from './tolerance-fields.vue';

export interface ILightboxScreen {
    screenId: string;
    name: string;
    status?: IStatusTag;
    /** The screen's saved overrides. */
    tolerances: IToleranceOverrides;
    /** The screen's own masks and whether it uses the app's. */
    masks: IScreenMasksResponse;
    /** Build whose stored image is this screen's screenshot (already resolved past matched builds). */
    current?: { buildId: string } | null;
    reference?: { buildId: string } | null;
    /** Where the diff stored when the build was processed lives, if there is one. */
    diff?: { buildId: string } | null;
    /** The build whose current-vs-reference pair a tolerance preview runs against. */
    compare?: { buildId: string } | null;
    meta?: { label: string; value: string; mono?: boolean }[];
    link?: { label: string; to: RouteLocationRaw };
}

type View = 'current' | 'reference' | 'diff';
type Zoom = 'fit' | '100' | '200';

const props = defineProps<{
    appId: string;
    items: ILightboxScreen[];
    index: number;
    /** What a screen without overrides is compared with: the app's values, resolved over the instance defaults. */
    appTolerances: ITolerances;
    /** Label for the screen's own image when it sits beside a reference, e.g. "New build". */
    currentLabel?: string;
    images?: ScreenImages;
    /** Whether the user may save screen tolerances (the same role as reviewing; the API enforces it). */
    canEdit: boolean;
    /**
     * Called with a screen's saved overrides. A prop, not an emit: a save can still be in flight
     * when the lightbox closes, and Vue drops events emitted by an unmounted component.
     */
    onSaved?: (screenId: string, tolerances: IToleranceOverrides) => void;
    /** The app's masks, which a screen that uses them is compared with. */
    appMasks?: { masks: IMaskRect[]; version: number };
    /** Props rather than emits for the same reason as `onSaved`. */
    onMasksSaved?: (screenId: string, masks: IScreenMasksResponse) => void;
    onAppMasksSaved?: (masks: IAppMasksResponse) => void;
    /** Asked to re-fetch the masks (and `appMasks`) after a save was refused as stale. */
    onReloadMasks?: () => Promise<void> | void;
}>();

const emit = defineEmits<{
    close: [];
    'update:index': [index: number];
}>();

const ownImages = useScreenImages(() => props.appId);
const images = computed(() => props.images ?? ownImages);

const item = computed(() => props.items[Math.min(Math.max(props.index, 0), props.items.length - 1)]);

// ── Navigation ──
function step(delta: 1 | -1) {
    const next = props.index + delta;
    if (next < 0 || next >= props.items.length) return;
    emit('update:index', next);
}

// ── Image ──
const view = ref<View>('current');
const zoom = ref<Zoom>('fit');
const stage = ref<HTMLElement>();
const natural = ref<{ width: number; height: number }>();
// The size of the screen's own image, kept while the diff or reference is shown.
const currentSize = ref<{ width: number; height: number }>();
// While D is held the stage shows the diff, like the review screen's flash.
const diffHeld = ref(false);

const viewOptions = computed(() => {
    const options: { value: View; label: string; testId: string }[] = [];
    if (item.value.current) options.push({ value: 'current', label: props.currentLabel ?? 'Screenshot', testId: 'lightbox-view-current' });
    if (item.value.reference) options.push({ value: 'reference', label: 'Reference', testId: 'lightbox-view-reference' });
    if (hasDiffView.value) options.push({ value: 'diff', label: 'Diff', testId: 'lightbox-view-diff' });
    return options;
});

const hasDiffView = computed(() => !!item.value.diff || canCompare.value);

const shownView = computed<View>(() => {
    if (diffHeld.value && hasDiffView.value) return 'diff';
    if (viewOptions.value.some(option => option.value === view.value)) return view.value;
    return viewOptions.value[0]?.value ?? 'current';
});

const stageLabel = computed(() => {
    if (shownView.value === 'diff') return 'Diff';
    if (shownView.value === 'reference') return 'Reference screenshot';
    return props.currentLabel ? `${props.currentLabel} screenshot` : 'Screenshot';
});

/** An object URL, `false` (failed), `undefined` (loading) or `null` (this screen has no such image). */
const stageSrc = computed<string | false | undefined | null>(() => {
    const screen = item.value;
    if (shownView.value === 'diff') {
        // A preview's diff reflects the values being edited, so it wins over the stored one.
        if (preview.value) return preview.value.diffImage;
        // The stored diff stands in when there is nothing to preview against, or the preview failed.
        if (screen.diff && (!canCompare.value || previewFailed.value)) return images.value.get('diff', screen.diff.buildId, screen.screenId);
        return previewFailed.value ? false : undefined;
    }
    const source = shownView.value === 'reference' ? screen.reference : screen.current;
    if (!source) return null;
    return images.value.get('image', source.buildId, screen.screenId);
});

const missingText = computed(() =>
    shownView.value === 'reference' ? 'This screen has no reference yet.' : 'This screen is no longer in the build.'
);

function requestImages() {
    const screen = item.value;
    if (screen.current) images.value.request('image', screen.current.buildId, screen.screenId);
    if (screen.reference) images.value.request('image', screen.reference.buildId, screen.screenId);
    if (screen.diff && !canCompare.value) images.value.request('diff', screen.diff.buildId, screen.screenId);
    // Kept loaded while shown, including the stored diff a failed preview falls back to.
    const held: ScreenImageRef[] = [];
    if (screen.current) held.push(['image', screen.current.buildId, screen.screenId]);
    if (screen.reference) held.push(['image', screen.reference.buildId, screen.screenId]);
    if (screen.diff) held.push(['diff', screen.diff.buildId, screen.screenId]);
    images.value.hold('lightbox', held);
}

// The image the mask layer is currently aligned to; a new image is loading until this catches up.
const loadedSrc = ref<string>();

function onImageLoad(e: Event, src: string) {
    const img = e.target as HTMLImageElement;
    natural.value = { width: img.naturalWidth, height: img.naturalHeight };
    loadedSrc.value = src;
    if (shownView.value === 'current' || !item.value.current) currentSize.value = natural.value;
}

// The canvas is sized in px from the image's natural size, so the mask layer (an SVG in the image's own
// pixels) scales with Fit, 100% and 200% exactly as the image does.
const stageBox = ref({ width: 0, height: 0 });
let stageObserver: ResizeObserver | undefined;

function measureStage() {
    const el = stage.value;
    if (!el) return;
    const style = getComputedStyle(el);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    // narrow screens stack the panel under the stage, which then is only as tall as its screenshot (capped)
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    stageBox.value = { width: el.clientWidth - padX, height: (narrow ? window.innerHeight * 0.5 : el.clientHeight) - padY };
}

const canvasScale = computed(() => {
    if (zoom.value === '100') return 1;
    if (zoom.value === '200') return 2;
    const size = natural.value;
    const { width, height } = stageBox.value;
    if (!size || width <= 0 || height <= 0) return 1;
    return Math.min(1, width / size.width, height / size.height);
});

const canvasStyle = computed(() => {
    const size = natural.value;
    if (!size) return { width: '0px', height: '0px', overflow: 'hidden' };
    return { width: `${size.width * canvasScale.value}px`, height: `${size.height * canvasScale.value}px` };
});

const dimensions = computed(() => (currentSize.value ? `${currentSize.value.width} × ${currentSize.value.height} px` : ''));

// ── Tolerances ──
// Unsaved edits are kept per screen while the lightbox is open, so stepping away and back loses nothing.
const drafts = new Map<string, IToleranceOverrides>();
const draft = ref<IToleranceOverrides>(pickOverrides(item.value.tolerances));
const isValid = ref(true);
const isSaving = ref(false);

const isDirty = computed(() => !sameOverrides(draft.value, pickOverrides(item.value.tolerances)));
const effective = computed(() => resolveTolerances(draft.value, props.appTolerances));

watch(draft, value => drafts.set(item.value.screenId, value));

async function save() {
    const screen = item.value;
    const values = draft.value;
    try {
        isSaving.value = true;
        const saved = pickOverrides(
            await dataFromAsync(ScreensApi.putScreensUpdateTolerances({ path: { appId: props.appId, screenId: screen.screenId }, body: values }))
        );
        drafts.delete(screen.screenId);
        props.onSaved?.(screen.screenId, saved);
        if (item.value.screenId === screen.screenId) draft.value = saved;
        showToast({ message: hasOverride(saved) ? `Tolerance saved for ${screen.name}.` : `${screen.name} now follows the app default.` });
    } catch (err) {
        handleErrorAndAlert(err);
    } finally {
        isSaving.value = false;
    }
}

// ── Masks ──
// Rectangles whose pixels never count as a difference. A screen's masks are saved on their own (they
// are not a tolerance), and admins can edit the app's set from the same canvas. Unsaved edits are kept
// per screen like tolerance drafts, and the app's set while the lightbox is open.
type MaskTarget = 'screen' | 'app';
interface IMaskDraft {
    masks: IMaskRect[];
    inherit: boolean;
}

const store = useStore();
const maskTarget = ref<MaskTarget>('screen');
const layerVisible = ref(true);
const drawMode = ref(false);
const selectedMaskId = ref<string | null>(null);
const maskDragging = ref(false);
const isSavingMasks = ref(false);
const masksFieldsValid = ref(true);
const announcement = ref('');

const maskDrafts = new Map<string, IMaskDraft>();
const freshMaskDraft = (): IMaskDraft => ({ masks: cloneMasks(item.value.masks.masks), inherit: item.value.masks.inheritAppMasks });
const maskDraft = ref<IMaskDraft>(freshMaskDraft());
// null until an admin starts editing the app's masks
const appDraft = ref<IMaskRect[] | null>(null);

const savedAppMasks = computed(() => props.appMasks?.masks ?? []);
const appMasksNow = computed(() => appDraft.value ?? savedAppMasks.value);
const appDirty = computed(() => appDraft.value !== null && !sameMasks(appDraft.value, savedAppMasks.value));
const screenMasksDirty = computed(
    () => !sameMasks(maskDraft.value.masks, item.value.masks.masks) || maskDraft.value.inherit !== item.value.masks.inheritAppMasks
);

watch(
    maskDraft,
    value => {
        if (screenMasksDirty.value) maskDrafts.set(item.value.screenId, value);
        else maskDrafts.delete(item.value.screenId);
    },
    { deep: true }
);

/** The list on the canvas and in the fields: the app's while an admin edits those, otherwise the screen's. */
const activeMasks = computed<IMaskRect[]>({
    get: () => (maskTarget.value === 'app' ? appMasksNow.value : maskDraft.value.masks),
    set: masks => {
        if (maskTarget.value === 'app') appDraft.value = masks;
        else maskDraft.value = { ...maskDraft.value, masks };
    }
});
/** The other set, drawn like the others but fixed, with a tooltip and the list hint saying they are the app's. */
const contextMasks = computed(() => (maskTarget.value === 'app' ? maskDraft.value.masks : maskDraft.value.inherit ? appMasksNow.value : []));
/** What a comparison of this screen would ignore. */
const effectiveMasks = computed(() => [...(maskDraft.value.inherit ? appMasksNow.value : []), ...maskDraft.value.masks]);

const canEditMaskTarget = computed(() => (maskTarget.value === 'app' ? store.isAdmin : props.canEdit));
const maskEditable = canEditMaskTarget;
const activeMasksDirty = computed(() => (maskTarget.value === 'app' ? appDirty.value : screenMasksDirty.value));
const listProblem = computed(() => listError(activeMasks.value));
const activeMasksValid = computed(() => masksFieldsValid.value && !listProblem.value);
const masksValid = computed(
    () => masksFieldsValid.value && !listError(maskDraft.value.masks) && !listError(appMasksNow.value) && effectiveMasks.value.length <= MAX_MASKS * 2
);
const previewValid = computed(() => isValid.value && masksValid.value);

const layerShown = computed(() => layerVisible.value && !!natural.value && loadedSrc.value === stageSrc.value);

// Masks outside the screenshot are clipped by the comparison; say so rather than leave them silently inert.
const boundsSize = computed(() => currentSize.value ?? natural.value);
const outside = computed(() =>
    boundsSize.value ? outsideSummary(effectiveMasks.value, boundsSize.value.width, boundsSize.value.height) : { partly: 0, outside: 0 }
);
const coverage = computed(() => (boundsSize.value ? coveragePct(effectiveMasks.value, boundsSize.value.width, boundsSize.value.height) : 0));

const maskInfo = computed(() => {
    const { updatedByName, updatedAt } = item.value.masks;
    if (maskTarget.value === 'app' || (!updatedByName && !updatedAt)) return '';
    const when = updatedAt ? new Date(updatedAt).toLocaleString() : '';
    return 'Last saved' + (updatedByName ? ' by ' + updatedByName : '') + (when ? ' on ' + when : '') + '.';
});

watch(
    () => activeMasks.value.length,
    count => {
        if (!count) masksFieldsValid.value = true;
    }
);

function resetMasksForScreen() {
    maskTarget.value = 'screen';
    drawMode.value = false;
    selectedMaskId.value = null;
    maskDragging.value = false;
    masksFieldsValid.value = true;
    maskDraft.value = maskDrafts.get(item.value.screenId) ?? freshMaskDraft();
}

let announceFlip = false;
function announce(message: string) {
    // a repeated message still reads out again
    announceFlip = !announceFlip;
    announcement.value = announceFlip ? message : message + ' ';
}

function focusMask(id: string | null) {
    void nextTick(() => {
        const target = id ? stage.value?.querySelector<SVGElement>('[data-mask-id="' + id + '"]') : null;
        if (target) target.focus({ preventScroll: true });
        else document.querySelector<HTMLElement>('[data-testid="mask-add"]')?.focus();
    });
}

function toggleDraw() {
    drawMode.value = !drawMode.value;
    announce(drawMode.value ? 'Draw mode on. Drag on the screenshot to draw a mask.' : 'Draw mode off.');
}

function toggleLayer() {
    layerVisible.value = !layerVisible.value;
    announce(layerVisible.value ? 'Masks shown.' : 'Masks hidden.');
}

function addMask() {
    const size = natural.value;
    if (!maskEditable.value || !size) return;
    if (activeMasks.value.length >= MAX_MASKS) {
        announce('At most ' + MAX_MASKS + ' masks.');
        return;
    }
    // a modest box near the top-left of what is in view, cascading so several don't stack exactly
    const width = Math.min(size.width, Math.max(8, Math.min(240, Math.round(size.width / 4))));
    const height = Math.min(size.height, Math.max(8, Math.min(64, Math.round(size.height / 10))));
    const originX = zoom.value === 'fit' || !stage.value ? 0 : Math.round(stage.value.scrollLeft / canvasScale.value);
    const originY = zoom.value === 'fit' || !stage.value ? 0 : Math.round(stage.value.scrollTop / canvasScale.value);
    const cascade = (activeMasks.value.length % 8) * 12;
    const mask: IMaskRect = {
        id: newMaskId(),
        x: Math.min(Math.max(0, originX + 24 + cascade), Math.max(0, size.width - width)),
        y: Math.min(Math.max(0, originY + 24 + cascade), Math.max(0, size.height - height)),
        width,
        height,
        label: null
    };
    activeMasks.value = [...activeMasks.value, mask];
    selectedMaskId.value = mask.id;
    announce('Added ' + describeMask(mask, activeMasks.value.length - 1) + '. Use the arrow keys to move it, Alt and the arrow keys to resize it.');
    focusMask(mask.id);
}

function removeMask(id: string) {
    const list = activeMasks.value;
    const index = list.findIndex(m => m.id === id);
    if (index < 0) return;
    activeMasks.value = list.filter(m => m.id !== id);
    const next = activeMasks.value[Math.min(index, activeMasks.value.length - 1)];
    selectedMaskId.value = next?.id ?? null;
    announce('Removed mask ' + (index + 1) + '. ' + formatMaskCount(activeMasks.value.length) + ' left.');
    focusMask(next?.id ?? null);
}

function onMaskEscape() {
    selectedMaskId.value = null;
    stage.value?.focus({ preventScroll: true });
}

function enterAppMasks() {
    appDraft.value ??= cloneMasks(savedAppMasks.value);
    maskTarget.value = 'app';
    drawMode.value = false;
    selectedMaskId.value = null;
    announce("Editing the app's masks.");
}

function leaveAppMasks() {
    maskTarget.value = 'screen';
    drawMode.value = false;
    selectedMaskId.value = null;
    announce("Editing this screen's masks.");
}

// Escape ends draw mode before the modal (or anything else) can take it as "close".
function onDrawEscape(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    drawMode.value = false;
    announce('Draw mode off.');
}
watch(drawMode, on => {
    if (on) window.addEventListener('keydown', onDrawEscape, true);
    else window.removeEventListener('keydown', onDrawEscape, true);
});

/** A save refused because someone else saved first: the stored masks are re-read and the edits dropped. */
async function handleMaskSaveError(err: unknown, target: MaskTarget, screenId: string) {
    if (!(err instanceof OpenApiError) || err.response?.status !== 409) {
        handleErrorAndAlert(err);
        return;
    }
    if (target === 'app') appDraft.value = null;
    else maskDrafts.delete(screenId);
    try {
        await props.onReloadMasks?.();
    } catch (reloadErr) {
        handleError(reloadErr);
    }
    await nextTick();
    if (target === 'screen' && item.value.screenId === screenId) maskDraft.value = freshMaskDraft();
    await showAlert(
        (target === 'app' ? "Someone else changed the app's masks" : "Someone else changed this screen's masks") +
            ' while you were editing. They have been reloaded, and your unsaved changes were discarded.'
    );
}

async function saveMasks() {
    if (maskTarget.value === 'app') {
        await saveAppMasks();
        return;
    }
    const screen = item.value;
    const values = maskDraft.value;
    try {
        isSavingMasks.value = true;
        const saved = await dataFromAsync(
            ScreensApi.putScreensUpdateMasks({
                path: { appId: props.appId, screenId: screen.screenId },
                body: { masks: cloneMasks(values.masks), inheritAppMasks: values.inherit, baseVersion: screen.masks.version }
            })
        );
        maskDrafts.delete(screen.screenId);
        props.onMasksSaved?.(screen.screenId, saved);
        if (item.value.screenId === screen.screenId) maskDraft.value = { masks: cloneMasks(saved.masks), inherit: saved.inheritAppMasks };
        showToast({ message: 'Masks saved for ' + screen.name + '. They apply from the next build.' });
    } catch (err) {
        await handleMaskSaveError(err, 'screen', screen.screenId);
    } finally {
        isSavingMasks.value = false;
    }
}

async function saveAppMasks() {
    const masks = appDraft.value;
    if (!masks) return;
    try {
        isSavingMasks.value = true;
        const saved = await dataFromAsync(
            AppsApi.putAppsUpdateMasks({ path: { id: props.appId }, body: { masks: cloneMasks(masks), baseVersion: props.appMasks?.version ?? 0 } })
        );
        appDraft.value = null;
        props.onAppMasksSaved?.(saved);
        showToast({ message: 'App masks saved. They apply from the next build.' });
    } catch (err) {
        await handleMaskSaveError(err, 'app', item.value.screenId);
    } finally {
        isSavingMasks.value = false;
    }
}

// ── Live preview ──
const canCompare = computed(() => !!item.value.compare && !!item.value.current && !!item.value.reference);
const preview = ref<IBuildScreenCompareResponse>();
const previewFailed = ref(false);
// the server refuses to compare a screen whose own image was cleaned up after it matched its baseline (a 400): expected, not an error
const previewUnavailable = ref(false);
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let previewRun = 0;

const noCompareText = computed(() =>
    item.value.compare
        ? 'This screen has no reference in this build, so there is nothing to preview against.'
        : 'Open a build to preview these values against a real comparison.'
);

const previewTone = computed(() => {
    if (preview.value) return preview.value.passes ? 'info' : 'warning';
    return previewFailed.value && previewValid.value ? 'danger' : '';
});
const previewIcon = computed(() => {
    if (preview.value) return preview.value.passes ? 'fa-check' : 'fa-magnifying-glass';
    if (!previewValid.value) return 'fa-circle-info';
    return previewFailed.value ? 'fa-triangle-exclamation' : 'fa-circle-notch fa-spin';
});

// One comparison is in flight at a time. Edits made meanwhile only replace what runs next, so fast
// typing can't queue a comparison per keystroke on the server.
let previewInFlight = false;
let previewQueued = false;

function schedulePreview(delay: number) {
    clearTimeout(previewTimer);
    previewRun++;
    previewQueued = false;
    if (!canCompare.value) return;
    if (!previewValid.value) {
        // a verdict for values that are no longer in the fields would mislead
        preview.value = undefined;
        previewFailed.value = false;
        return;
    }
    previewTimer = setTimeout(runPreview, delay);
}

async function runPreview() {
    if (previewInFlight) {
        previewQueued = true;
        return;
    }
    const run = previewRun;
    const screen = item.value;
    const values = { ...effective.value, masks: cloneMasks(effectiveMasks.value) };

    previewInFlight = true;
    try {
        const result = await dataFromAsync(
            BuildScreensApi.postBuildScreensCompareScreen({
                path: { appId: props.appId, id: screen.compare!.buildId, screenId: screen.screenId },
                body: values
            })
        );
        if (run === previewRun) {
            preview.value = result;
            previewFailed.value = false;
            previewUnavailable.value = false;
        }
    } catch (err) {
        if (run === previewRun) {
            previewUnavailable.value = err instanceof OpenApiError && err.response?.status === 400;
            if (!previewUnavailable.value) handleError(err);
            preview.value = undefined;
            previewFailed.value = true;
            // fall back to the diff stored when the build was processed
            if (screen.diff) images.value.request('diff', screen.diff.buildId, screen.screenId);
        }
    } finally {
        previewInFlight = false;
        if (previewQueued && !disposed) {
            previewQueued = false;
            void runPreview();
        }
    }
}

// Re-run when the values change; the previous result stays up until the new one lands. A mask drag
// waits for the pointer to come up rather than running a comparison per pixel of movement.
watch(
    [effective, effectiveMasks, previewValid, maskDragging],
    () => {
        if (!maskDragging.value) schedulePreview(350);
    },
    { deep: true }
);

// ── Screen change ──
watch(
    () => item.value.screenId,
    () => {
        draft.value = drafts.get(item.value.screenId) ?? pickOverrides(item.value.tolerances);
        isValid.value = true;
        resetMasksForScreen();
        preview.value = undefined;
        previewFailed.value = false;
        natural.value = undefined;
        loadedSrc.value = undefined;
        currentSize.value = undefined;
        requestImages();
        schedulePreview(0);
        void nextTick(() => stage.value?.scrollTo({ top: 0, left: 0 }));
    },
    { immediate: true }
);

// ── Keyboard ──
function isTypingTarget(target: EventTarget | null) {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function onKeydown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
    if (isTypingTarget(e.target)) return;

    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
    } else if (e.key.toLowerCase() === 'd' && hasDiffView.value) {
        e.preventDefault();
        if (!e.repeat) diffHeld.value = true;
    } else if (e.key.toLowerCase() === 'n' && canEditMaskTarget.value) {
        e.preventDefault();
        if (!e.repeat) addMask();
    } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (!e.repeat) toggleLayer();
    }
}

function onKeyup(e: KeyboardEvent) {
    if (e.key.toLowerCase() === 'd') diffHeld.value = false;
}

function releaseDiff() {
    diffHeld.value = false;
}

onMounted(() => {
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('keyup', onKeyup);
    window.addEventListener('blur', releaseDiff);
    // The dialog would otherwise start on the zoom select, where the arrow keys change the zoom
    // instead of stepping between screens.
    stage.value?.focus({ preventScroll: true });
    if (stage.value) {
        stageObserver = new ResizeObserver(measureStage);
        stageObserver.observe(stage.value);
    }
    window.addEventListener('resize', measureStage);
    measureStage();
});

onBeforeUnmount(() => {
    disposed = true;
    images.value.hold('lightbox', []);
    stageObserver?.disconnect();
    window.removeEventListener('resize', measureStage);
    window.removeEventListener('keydown', onDrawEscape, true);
    clearTimeout(previewTimer);
    previewRun++;
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('keyup', onKeyup);
    window.removeEventListener('blur', releaseDiff);
});
</script>

<style lang="scss">
// The foundation's modal caps its panel at 95% and pads its content; the lightbox wants the room.
.vf-modal:has(> .vf-modal-content > .lightbox) {
    max-width: none;
    max-height: none;

    > .vf-modal-content {
        padding: 0;
        white-space: normal;
        color: var(--text);
    }
}
</style>

<style lang="scss" scoped>
.lightbox {
    display: flex;
    flex-direction: column;
    width: min(1760px, calc(100vw - 32px));
    height: calc(100dvh - 32px);
}

// ── Bar ──
.lb-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    padding: 10px 12px 10px 14px;
    border-bottom: 1px solid var(--border);
}
.lb-nav {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}
.lb-count {
    margin-left: 4px;
    color: var(--text-3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}
.lb-name {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.lb-tools {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}

// ── Body ──
.lb-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    flex: 1 1 auto;
    min-height: 0;
}
.lb-stage {
    display: grid;
    place-items: safe center;
    min-width: 0;
    min-height: 0;
    padding: 16px;
    overflow: auto;
    background: var(--surface-3);
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;

    &:focus-visible {
        outline-offset: -2px;
    }

    // Fit: the whole screenshot inside the stage, never above its natural size. The canvas is sized in
    // script (canvasStyle) for every zoom; 100% and 200% are true scale of the image's own pixels and scroll.
    &[data-zoom='fit'] {
        grid-template: minmax(0, 1fr) / minmax(0, 1fr);
        overflow: hidden;
    }
    &[data-zoom='200'] img {
        image-rendering: pixelated;
    }
}
// The image and the mask layer share one box, so the layer's pixels are the image's pixels.
.lb-canvas {
    position: relative;
    flex-shrink: 0;

    img {
        display: block;
        width: 100%;
        height: 100%;
        border-radius: var(--radius-sm);
    }
}
.lb-placeholder {
    max-width: 340px;
    color: var(--text-3);
    font-size: 13px;
    text-align: center;
}
.lb-loading {
    align-items: center;
}

// ── Panel ──
.lb-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    border-left: 1px solid var(--border);
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
}
.lb-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px;

    & + & {
        border-top: 1px solid var(--border);
    }

    h3 {
        color: var(--text);
        font-size: 14px;
        font-weight: 600;
    }
}
.lb-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.lb-lead,
.lb-note {
    color: var(--text-3);
    font-size: 12px;
    text-wrap: pretty;
}
.lb-lead {
    margin-top: -6px;
}
.lb-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;

    > div {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
    }
    dt {
        flex-shrink: 0;
        color: var(--text-3);
    }
    dd {
        min-width: 0;
        overflow-wrap: anywhere;
        color: var(--text);
        font-variant-numeric: tabular-nums;
        text-align: right;
    }
}
.lb-link {
    align-self: flex-start;

    i {
        font-size: 11px;
        color: var(--text-3);
    }
}
.lb-preview {
    strong {
        display: block;
    }
}
.lb-preview-line {
    display: block;
    font-variant-numeric: tabular-nums;
}
.lb-preview {
    align-items: center;
}
.lb-mask-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;

    .btn[aria-pressed='true']:not(.ghost) {
        border-color: var(--focus);
        background: var(--accent-soft);
    }
}
.lb-check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;

    &.disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }
    input {
        margin-top: 2px;
    }
}
.lb-check-hint {
    color: var(--text-3);
    font-weight: 400;
}
.lb-app-edit {
    display: flex;
    align-items: center;
    gap: 10px;
}
.lb-app-mode {
    align-items: center;
}
.lb-warn {
    display: flex;
    gap: 6px;
    color: var(--warning);

    i {
        margin-top: 2px;
    }
}
.lb-problem {
    color: var(--danger);
}
.lb-mask-preview {
    color: var(--text-2);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
}
.lb-save {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.lb-save-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
}
.lb-unsaved {
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
}
.lb-keys {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 6px;
    margin-top: auto;
    padding: 12px 18px;
    border-top: 1px solid var(--border);
    color: var(--text-3);
    font-size: 12px;

    > span {
        white-space: nowrap;

        &.wrap {
            white-space: normal;
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

// The panel moves under the stage once it would squeeze the screenshot.
@media (max-width: 900px) {
    .lightbox {
        width: calc(100vw - 16px);
        height: calc(100dvh - 16px);
    }
    // One scrolling column: the stage is as tall as its screenshot (capped), then the panel follows.
    .lb-body {
        display: block;
        overflow-y: auto;
    }
    .lb-stage {
        max-height: 50dvh;
        padding: 12px;

        &[data-zoom='fit'] {
            grid-template: auto / minmax(0, 1fr);
        }
    }
    .lb-panel {
        overflow: visible;
        border-top: 1px solid var(--border);
        border-left: 0;
    }
    // no keyboard to speak of on a phone
    .lb-keys {
        display: none;
    }
    .lb-bar {
        flex-wrap: wrap;
        gap: 8px 12px;
    }
    .lb-name {
        order: 3;
        flex-basis: 100%;
    }
    .lb-tools {
        margin-left: auto;
    }
}
</style>
