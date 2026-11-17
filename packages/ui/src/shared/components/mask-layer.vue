<template>
    <svg
        ref="svg"
        class="mask-layer"
        :class="{ editable, drawing }"
        :viewBox="`0 0 ${width} ${height}`"
        preserveAspectRatio="none"
        :role="editable ? 'group' : undefined"
        :aria-label="editable ? ariaLabel : undefined"
        :aria-hidden="editable ? undefined : 'true'"
        focusable="false"
        data-testid="mask-layer"
    >
        <defs>
            <pattern :id="patternId" :width="hatch" :height="hatch" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect :width="hatch" :height="hatch" class="hatch-bg" />
                <rect :width="hatch / 3" :height="hatch" class="hatch-line" />
            </pattern>
        </defs>

        <!-- Starts a draw anywhere on the screenshot; only present in draw mode so clicks otherwise pass through. -->
        <rect
            v-if="editable && drawing"
            class="draw-surface"
            :width="width"
            :height="height"
            data-testid="mask-draw-surface"
            @pointerdown="startDraw"
        />

        <g v-for="mask in context" :key="mask.id" class="mask is-context" data-testid="app-mask-rect">
            <rect class="mask-fill" :x="mask.x" :y="mask.y" :width="mask.width" :height="mask.height" />
            <rect class="mask-edge-a" :x="mask.x" :y="mask.y" :width="mask.width" :height="mask.height" />
            <rect class="mask-edge-b" :x="mask.x" :y="mask.y" :width="mask.width" :height="mask.height" />
        </g>

        <g
            v-for="(mask, index) in masks"
            :key="mask.id"
            class="mask"
            :class="{ selected: mask.id === selectedId }"
            :tabindex="editable ? 0 : undefined"
            :role="editable ? 'group' : undefined"
            :aria-label="editable ? describeMask(mask, index) : undefined"
            :data-mask-id="mask.id"
            :data-testid="editable ? 'mask-rect' : 'mask-outline'"
            @pointerdown="startMove($event, mask)"
            @focus="emit('select', mask.id)"
            @keydown="onKeydown($event, mask, index)"
        >
            <rect class="mask-fill" :x="mask.x" :y="mask.y" :width="mask.width" :height="mask.height" :fill="`url(#${patternId})`" />
            <rect class="mask-edge-a" :x="mask.x" :y="mask.y" :width="mask.width" :height="mask.height" />
            <rect class="mask-edge-b" :x="mask.x" :y="mask.y" :width="mask.width" :height="mask.height" />
            <rect class="mask-focus" :x="mask.x" :y="mask.y" :width="mask.width" :height="mask.height" />
            <text v-if="editable" class="mask-number" :x="mask.x + 4 / scale" :y="mask.y + 14 / scale" :font-size="12 / scale" aria-hidden="true">
                {{ index + 1 }}
            </text>
        </g>

        <rect
            v-if="draftRect"
            class="mask-draft"
            :x="draftRect.x"
            :y="draftRect.y"
            :width="draftRect.width"
            :height="draftRect.height"
            data-testid="mask-draft"
        />

        <template v-if="editable && selected && !drag?.draft">
            <rect
                v-for="handle in HANDLES"
                :key="handle.name"
                class="mask-handle"
                :x="handleX(selected, handle) - handleSize / 2"
                :y="handleY(selected, handle) - handleSize / 2"
                :width="handleSize"
                :height="handleSize"
                :style="{ cursor: handle.cursor }"
                :data-testid="`mask-handle-${handle.name}`"
                @pointerdown="startResize($event, selected, handle)"
            />
        </template>
    </svg>
</template>

<script lang="ts" setup>
/**
 * Mask rectangles drawn over a screenshot, in the screenshot's own pixels (`viewBox` is its natural
 * size, so the layer follows Fit and the zoom levels). Read-only, it is an outline: no pointer
 * events, so the image underneath still takes clicks. Editable, masks can be drawn, moved and resized
 * with a pointer, and each one is focusable and moves, resizes and deletes from the keyboard.
 * `context` masks (the other set, e.g. the app's while editing a screen's) are drawn dashed and fixed.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { describeMask, type IMaskRect, MAX_MASKS, newMaskId } from '@/shared/masks';

type HandleName = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
interface IHandle {
    name: HandleName;
    /** -1 left/top, 0 middle, 1 right/bottom */
    dx: -1 | 0 | 1;
    dy: -1 | 0 | 1;
    cursor: string;
}

const HANDLES: IHandle[] = [
    { name: 'nw', dx: -1, dy: -1, cursor: 'nwse-resize' },
    { name: 'n', dx: 0, dy: -1, cursor: 'ns-resize' },
    { name: 'ne', dx: 1, dy: -1, cursor: 'nesw-resize' },
    { name: 'e', dx: 1, dy: 0, cursor: 'ew-resize' },
    { name: 'se', dx: 1, dy: 1, cursor: 'nwse-resize' },
    { name: 's', dx: 0, dy: 1, cursor: 'ns-resize' },
    { name: 'sw', dx: -1, dy: 1, cursor: 'nesw-resize' },
    { name: 'w', dx: -1, dy: 0, cursor: 'ew-resize' }
];

const props = withDefaults(
    defineProps<{
        /** The screenshot's natural size: the layer's coordinate space. */
        width: number;
        height: number;
        masks: IMaskRect[];
        /** Read-only masks from the set not being edited. */
        context?: IMaskRect[];
        editable?: boolean;
        /** Draw mode: dragging on the screenshot creates a mask. */
        drawing?: boolean;
        selectedId?: string | null;
        ariaLabel?: string;
    }>(),
    { context: () => [], selectedId: null, ariaLabel: 'Masks' }
);

const emit = defineEmits<{
    'update:masks': [masks: IMaskRect[]];
    select: [id: string | null];
    remove: [id: string];
    /** A draw ended, with or without a mask: leave draw mode. */
    'draw-end': [];
    /** True while a pointer drag is in progress, so listeners can wait for pointer up. */
    dragging: [dragging: boolean];
    /** Plain text for a live region. */
    announce: [message: string];
    /** Escape on a focused mask: the owner decides where focus goes. */
    escape: [];
}>();

const svg = ref<SVGSVGElement>();
const scale = ref(1);
const coarse = ref(false);
let resizeObserver: ResizeObserver | undefined;

const patternId = `mask-hatch-${Math.random().toString(36).slice(2, 8)}`;

const hatch = computed(() => 8 / scale.value);
const handleSize = computed(() => (coarse.value ? 16 : 9) / scale.value);
const selected = computed(() => props.masks.find(m => m.id === props.selectedId));

function measure() {
    const rect = svg.value?.getBoundingClientRect();
    if (rect && rect.width > 0 && props.width > 0) scale.value = rect.width / props.width;
}

onMounted(() => {
    measure();
    if (svg.value) {
        resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(svg.value);
    }
    coarse.value = window.matchMedia?.('(pointer: coarse)').matches ?? false;
});
onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    endDrag(true);
});

// ── Geometry ──
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

function toImage(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const element = svg.value;
    const matrix = element?.getScreenCTM();
    if (!element || !matrix) return null;
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
}

function handleX(mask: IMaskRect, handle: IHandle) {
    return mask.x + (handle.dx + 1) * (mask.width / 2);
}
function handleY(mask: IMaskRect, handle: IHandle) {
    return mask.y + (handle.dy + 1) * (mask.height / 2);
}

function replace(updated: IMaskRect) {
    emit(
        'update:masks',
        props.masks.map(m => (m.id === updated.id ? updated : m))
    );
}

/** Moving keeps a mask on the screenshot where it fits; one that already sticks out isn't pulled back further than it is. */
function moved(mask: IMaskRect, x: number, y: number): IMaskRect {
    return {
        ...mask,
        x: clamp(Math.round(x), 0, Math.max(props.width - mask.width, mask.x)),
        y: clamp(Math.round(y), 0, Math.max(props.height - mask.height, mask.y))
    };
}

// ── Pointer drags ──
interface IDrag {
    kind: 'draw' | 'move' | 'resize';
    start: { x: number; y: number };
    orig?: IMaskRect;
    handle?: IHandle;
    /** The rectangle being drawn: not a mask until the pointer is released. */
    draft?: { x: number; y: number; width: number; height: number };
    moved: boolean;
}
const drag = ref<IDrag | null>(null);
const draftRect = computed(() => drag.value?.draft ?? null);

function beginDrag(next: IDrag) {
    drag.value = next;
    emit('dragging', true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    // capture: Escape cancels a draw before the modal, or anything else, sees it
    window.addEventListener('keydown', onDragKey, true);
}

function endDrag(silent = false) {
    if (!drag.value) return;
    drag.value = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onDragKey, true);
    if (!silent) emit('dragging', false);
}

function startDraw(e: PointerEvent) {
    if (e.button !== 0 || !props.editable) return;
    const point = toImage(e);
    if (!point) return;
    e.preventDefault();
    const x = clamp(Math.round(point.x), 0, props.width);
    const y = clamp(Math.round(point.y), 0, props.height);
    beginDrag({ kind: 'draw', start: { x, y }, draft: { x, y, width: 0, height: 0 }, moved: false });
}

function startMove(e: PointerEvent, mask: IMaskRect) {
    if (e.button !== 0 || !props.editable) return;
    const point = toImage(e);
    if (!point) return;
    // in draw mode the draw surface is below; a press that lands on a mask still moves it
    e.preventDefault();
    e.stopPropagation();
    emit('select', mask.id);
    (e.currentTarget as SVGElement).focus({ preventScroll: true });
    beginDrag({ kind: 'move', start: point, orig: { ...mask }, moved: false });
}

function startResize(e: PointerEvent, mask: IMaskRect, handle: IHandle) {
    if (e.button !== 0 || !props.editable) return;
    const point = toImage(e);
    if (!point) return;
    e.preventDefault();
    e.stopPropagation();
    beginDrag({ kind: 'resize', start: point, orig: { ...mask }, handle, moved: false });
}

function onPointerMove(e: PointerEvent) {
    const current = drag.value;
    const point = toImage(e);
    if (!current || !point) return;
    current.moved = true;

    if (current.kind === 'draw') {
        const x = clamp(Math.round(point.x), 0, props.width);
        const y = clamp(Math.round(point.y), 0, props.height);
        current.draft = {
            x: Math.min(current.start.x, x),
            y: Math.min(current.start.y, y),
            width: Math.abs(x - current.start.x),
            height: Math.abs(y - current.start.y)
        };
    } else if (current.kind === 'move' && current.orig) {
        replace(moved(current.orig, current.orig.x + (point.x - current.start.x), current.orig.y + (point.y - current.start.y)));
    } else if (current.kind === 'resize' && current.orig && current.handle) {
        const { orig, handle } = current;
        let left = orig.x;
        let right = orig.x + orig.width;
        let top = orig.y;
        let bottom = orig.y + orig.height;
        const px = clamp(Math.round(point.x), 0, Math.max(props.width, right));
        const py = clamp(Math.round(point.y), 0, Math.max(props.height, bottom));
        if (handle.dx === -1) left = px;
        if (handle.dx === 1) right = px;
        if (handle.dy === -1) top = py;
        if (handle.dy === 1) bottom = py;
        const x = Math.min(left, right);
        const y = Math.min(top, bottom);
        replace({ ...orig, x, y, width: Math.max(1, Math.abs(right - left)), height: Math.max(1, Math.abs(bottom - top)) });
    }
}

function onPointerUp() {
    const current = drag.value;
    if (!current) return;
    const draft = current.draft;
    endDrag();
    if (current.kind === 'move' || current.kind === 'resize') {
        const mask = props.masks.find(m => m.id === current.orig?.id);
        if (mask && current.moved) announceMask(mask);
        return;
    }
    emit('draw-end');
    // a click, or a sliver too small to mean it, draws nothing
    if (!draft || draft.width * scale.value < 4 || draft.height * scale.value < 4) return;
    if (props.masks.length >= MAX_MASKS) {
        emit('announce', `At most ${MAX_MASKS} masks.`);
        return;
    }
    const mask: IMaskRect = {
        id: newMaskId(),
        x: draft.x,
        y: draft.y,
        width: Math.max(1, draft.width),
        height: Math.max(1, draft.height),
        label: null
    };
    emit('update:masks', [...props.masks, mask]);
    emit('select', mask.id);
    emit('announce', `Added ${describeMask(mask, props.masks.length)}.`);
}

function onPointerCancel() {
    cancelDrag();
}

/** Puts a move or resize back, drops a draw. */
function cancelDrag() {
    const current = drag.value;
    if (!current) return;
    const wasDraw = current.kind === 'draw';
    if (current.orig) replace(current.orig);
    endDrag();
    if (wasDraw) emit('draw-end');
    emit('announce', wasDraw ? 'Draw cancelled.' : 'Change cancelled.');
}

function onDragKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelDrag();
}

// ── Keyboard ──
function announceMask(mask: IMaskRect) {
    emit(
        'announce',
        describeMask(
            mask,
            props.masks.findIndex(m => m.id === mask.id)
        )
    );
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

function onKeydown(e: KeyboardEvent, mask: IMaskRect, index: number) {
    if (!props.editable || e.ctrlKey || e.metaKey || e.isComposing) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        emit('escape');
        return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        emit('announce', `Removed mask ${index + 1}.`);
        emit('remove', mask.id);
        return;
    }
    if (!ARROWS.has(e.key)) return;

    // consumed here, so the lightbox doesn't step to another screen and the page doesn't scroll
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;

    const next = e.altKey
        ? { ...mask, width: Math.max(1, mask.width + dx), height: Math.max(1, mask.height + dy) }
        : moved(mask, mask.x + dx, mask.y + dy);
    if (next.x === mask.x && next.y === mask.y && next.width === mask.width && next.height === mask.height) return;
    replace(next);
    emit('announce', describeMask(next, index));
}
</script>

<style lang="scss">
// Mask colours. Two tones on every outline (a light and a dark line) read on any screenshot; the hatch
// is a faint ink stripe. Redeclared for dark mode like every other token.
:root {
    --mask-edge-light: rgba(255, 255, 255, 0.95);
    --mask-edge-dark: #1f2330;
    --mask-hatch-bg: rgba(255, 255, 255, 0.28);
    --mask-hatch-line: rgba(31, 35, 48, 0.3);
    --mask-context-fill: rgba(31, 35, 48, 0.06);
    --mask-number-ink: #15171c;
    --mask-number-halo: rgba(255, 255, 255, 0.9);
    --mask-handle-fill: #ffffff;
}
html.dark {
    --mask-edge-light: rgba(255, 255, 255, 0.9);
    --mask-edge-dark: #0c0d10;
    --mask-hatch-bg: rgba(255, 255, 255, 0.2);
    --mask-hatch-line: rgba(12, 13, 16, 0.42);
    --mask-context-fill: rgba(236, 236, 240, 0.06);
    --mask-number-ink: #ececf0;
    --mask-number-halo: rgba(12, 13, 16, 0.85);
    --mask-handle-fill: #ececf0;
}
</style>

<style lang="scss" scoped>
.mask-layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    // read-only: clicks go to the image beneath; the editable layer re-enables them on the masks
    pointer-events: none;
}
.hatch-bg {
    fill: var(--mask-hatch-bg);
}
.hatch-line {
    fill: var(--mask-hatch-line);
}
// Read-only (the review screen) is outline only: the screenshot underneath stays fully legible.
.mask-layer:not(.editable) .mask-fill {
    fill: none;
}
.mask-edge-a,
.mask-edge-b,
.mask-focus,
.mask-draft {
    fill: none;
    vector-effect: non-scaling-stroke;
}
.mask-edge-a {
    stroke: var(--mask-edge-light);
    stroke-width: 3px;
}
.mask-edge-b {
    stroke: var(--mask-edge-dark);
    stroke-width: 1.5px;
    stroke-dasharray: 6 4;
}
.mask-focus {
    display: none;
    stroke: var(--focus);
    stroke-width: 2.5px;
}
.is-context {
    .mask-fill {
        fill: var(--mask-context-fill);
    }
    .mask-edge-a {
        stroke-width: 2px;
        opacity: 0.7;
    }
    .mask-edge-b {
        stroke-dasharray: 2 4;
        opacity: 0.8;
    }
}
.mask-draft {
    stroke: var(--focus);
    stroke-width: 2px;
    stroke-dasharray: 5 3;
    fill: var(--accent-soft);
}
.mask-number {
    fill: var(--mask-number-ink);
    font-family: var(--font-sans);
    font-weight: 600;
    paint-order: stroke;
    stroke: var(--mask-number-halo);
    stroke-width: 3px;
    stroke-linejoin: round;
    user-select: none;
}
.mask-handle {
    fill: var(--mask-handle-fill);
    stroke: var(--focus);
    stroke-width: 1.5px;
    vector-effect: non-scaling-stroke;
    pointer-events: all;
    touch-action: none;
}

.editable {
    .mask {
        pointer-events: all;
        cursor: move;
        touch-action: none;
        outline: none;
    }
    .mask.selected .mask-focus,
    .mask:focus-visible .mask-focus {
        display: block;
    }
    .draw-surface {
        fill: transparent;
        pointer-events: all;
        cursor: crosshair;
        touch-action: none;
    }
}
</style>
