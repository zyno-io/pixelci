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
                    <img v-else :key="stageSrc" :src="stageSrc" :alt="`${stageLabel}: ${item.name}`" :style="naturalStyle" @load="onImageLoad" />
                </div>

                <aside class="lb-panel" aria-label="Screen details">
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
                                    <span class="lb-preview-line">
                                        {{ formatPct(preview.diffPct) }} of pixels differ ({{ preview.diffPixels.toLocaleString() }} px);
                                        {{ formatTolerance('diffPctTolerance', effective.diffPctTolerance) }} allowed.
                                    </span>
                                    <span v-if="preview.shiftTolerantPixels > 0" class="lb-preview-line">
                                        {{ preview.shiftTolerantPixels.toLocaleString() }} px ignored as shifted.
                                    </span>
                                </template>
                                <template v-else-if="!isValid">Correct the highlighted value to preview it.</template>
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

                    <p class="lb-keys">
                        <span><kbd>←</kbd>/<kbd>→</kbd> previous/next</span>
                        <template v-if="hasDiffView">
                            <span aria-hidden="true">·</span>
                            <span>hold <kbd>D</kbd> for the diff</span>
                        </template>
                        <span aria-hidden="true">·</span>
                        <span><kbd>Esc</kbd> close</span>
                    </p>
                </aside>
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
import { dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { handleError, handleErrorAndAlert, showToast } from '@zyno-io/vue-foundation';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { IStatusTag } from '@/shared/status';

import { useScreenImages, type ScreenImages } from '@/composables/useScreenImages';
import { BuildScreensApi, type IBuildScreenCompareResponse, ScreensApi } from '@/openapi-client-generated';
import ScreensSegmented from '@/screens/screens-segmented.vue';
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

import A11yModal from './a11y-modal.vue';
import Loader from './loader.vue';
import ToleranceFields from './tolerance-fields.vue';

export interface ILightboxScreen {
    screenId: string;
    name: string;
    status?: IStatusTag;
    /** The screen's saved overrides. */
    tolerances: IToleranceOverrides;
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
}

function onImageLoad(e: Event) {
    const img = e.target as HTMLImageElement;
    natural.value = { width: img.naturalWidth, height: img.naturalHeight };
    if (shownView.value === 'current' || !item.value.current) currentSize.value = natural.value;
}

// The percentage zooms scale the image's own pixels.
const naturalStyle = computed(() => (natural.value ? { '--natural-width': `${natural.value.width}px` } : undefined));

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

// ── Live preview ──
const canCompare = computed(() => !!item.value.compare && !!item.value.current && !!item.value.reference);
const preview = ref<IBuildScreenCompareResponse>();
const previewFailed = ref(false);
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
    return previewFailed.value && isValid.value ? 'danger' : '';
});
const previewIcon = computed(() => {
    if (preview.value) return preview.value.passes ? 'fa-check' : 'fa-magnifying-glass';
    if (!isValid.value) return 'fa-circle-info';
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
    if (!isValid.value) {
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
    const values = effective.value;

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
        }
    } catch (err) {
        if (run === previewRun) {
            handleError(err);
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

// Re-run when the values change; the previous result stays up until the new one lands.
watch([effective, isValid], () => schedulePreview(350), { deep: true });

// ── Screen change ──
watch(
    () => item.value.screenId,
    () => {
        draft.value = drafts.get(item.value.screenId) ?? pickOverrides(item.value.tolerances);
        isValid.value = true;
        preview.value = undefined;
        previewFailed.value = false;
        natural.value = undefined;
        currentSize.value = undefined;
        requestImages();
        schedulePreview(0);
        void nextTick(() => stage.value?.scrollTo({ top: 0, left: 0 }));
    },
    { immediate: true }
);

watch(shownView, () => {
    natural.value = undefined;
});

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
});

onBeforeUnmount(() => {
    disposed = true;
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

    img {
        display: block;
        border-radius: var(--radius-sm);
    }
    // Fit: the whole screenshot inside the stage, never above its natural size.
    &[data-zoom='fit'] {
        // definite tracks, so the image's percentage caps resolve against the stage
        grid-template: minmax(0, 1fr) / minmax(0, 1fr);
        overflow: hidden;

        img {
            max-width: 100%;
            max-height: 100%;
            min-width: 0;
            min-height: 0;
            object-fit: contain;
        }
    }
    // 100% and 200% are true scale of the image's own pixels; the stage scrolls.
    &[data-zoom='100'] img {
        width: var(--natural-width, auto);
        max-width: none;
    }
    &[data-zoom='200'] img {
        width: calc(var(--natural-width, auto) * 2);
        max-width: none;
        image-rendering: pixelated;
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

            img {
                max-height: calc(50dvh - 24px);
            }
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
