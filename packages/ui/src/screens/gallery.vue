<template>
    <div id="gallery" class="full" :style="{ '--tile-aspect': tileAspect }">
        <LoaderModal v-if="isLoading" />

        <template v-else>
            <div class="header">
                <div class="header-row">
                    <div class="header-title">
                        <RouterLink :to="`/apps/${appId}`" class="btn back" aria-label="Back to builds">
                            <i class="fa fa-arrow-left" aria-hidden="true" />
                        </RouterLink>
                        <h1 :title="app?.name">{{ app?.name ?? 'Screens' }}</h1>
                    </div>

                    <div v-if="!loadError" class="header-context">
                        <template v-if="contextBuild">
                            <span v-if="!buildId" class="context-label">Baseline</span>
                            <span class="context-item branch" :title="contextBuild.branchName">
                                <i class="fa fa-code-branch fa-sm" aria-hidden="true" />
                                <span class="clip">{{ contextBuild.branchName }}</span>
                            </span>
                            <component
                                :is="commitUrl ? 'a' : 'span'"
                                class="context-item commit"
                                :href="commitUrl ?? undefined"
                                :target="commitUrl ? '_blank' : undefined"
                                v-tooltip="contextBuild.commitSubject"
                            >
                                <i class="fa fa-code-commit fa-sm" aria-hidden="true" />
                                <span class="mono hash">{{ contextBuild.commitHash.substring(0, 8) }}</span>
                                <span class="clip subject">{{ contextBuild.commitSubject }}</span>
                            </component>
                            <span v-if="buildId && buildStatus" class="tag build-status" :class="buildStatus.tone" data-testid="build-status">
                                <i v-if="buildStatus.icon" class="fa fa-fw" :class="buildStatus.icon" aria-hidden="true" />
                                {{ buildStatus.label }}
                            </span>
                        </template>
                        <span v-else class="context-label">No approved baseline yet; showing each screen's latest upload</span>
                    </div>

                    <div v-if="!loadError" class="header-actions">
                        <button type="button" class="btn" data-testid="app-tolerances" @click="showAppTolerances = true">
                            <i class="fa fa-sliders" aria-hidden="true" />
                            {{ buildId ? 'App tolerances' : 'Tolerances' }}
                        </button>
                        <RouterLink
                            v-if="buildId"
                            :to="`/apps/${appId}/builds/${buildId}`"
                            class="btn"
                            :class="{ primary: build?.status === 'needs review' }"
                            data-testid="open-review"
                        >
                            {{ build?.status === 'needs review' ? 'Review build' : 'Compare with reference' }}
                        </RouterLink>
                    </div>
                </div>

                <div v-if="tiles.length" class="toolbar">
                    <div class="search-bar">
                        <i class="fa fa-magnifying-glass" aria-hidden="true" />
                        <input
                            v-model="search"
                            class="input"
                            type="search"
                            placeholder="Find a screen"
                            aria-label="Find a screen by name"
                            data-testid="gallery-search"
                        />
                    </div>

                    <ScreensSegmented v-model="filter" label="Screens to show" :options="filterOptions" />

                    <p class="result-count" role="status">{{ resultCount }}</p>

                    <select v-model="size" class="select" aria-label="Thumbnail size" data-testid="gallery-size">
                        <option value="s">Small thumbnails</option>
                        <option value="m">Medium thumbnails</option>
                        <option value="l">Large thumbnails</option>
                    </select>
                </div>
            </div>

            <div v-if="loadError" class="notice danger load-error" role="alert">
                <i class="fa fa-triangle-exclamation" aria-hidden="true" />
                <div class="notice-body">
                    {{ accessDenied ?? "These screens couldn't be loaded. They may have been removed, or you may not have access." }}
                </div>
                <div class="notice-actions">
                    <button v-if="accessDenied" type="button" class="btn" data-testid="switch-account" @click="signOut">
                        Sign in with a different account
                    </button>
                    <RouterLink :to="`/apps/${appId}`" class="btn">Back to builds</RouterLink>
                </div>
            </div>

            <div v-else-if="!tiles.length" class="card">
                <div class="empty">
                    <i class="fa fa-images" aria-hidden="true" />
                    <h2>{{ buildId ? 'This build has no screens.' : 'No screens yet' }}</h2>
                    <p v-if="!buildId">Screens appear here once a build uploads screenshots.</p>
                </div>
            </div>

            <div v-else-if="!visibleTiles.length" class="card">
                <div class="empty">
                    <i class="fa fa-magnifying-glass" aria-hidden="true" />
                    <h2>No screens match</h2>
                    <p>Try a different name, or show all screens.</p>
                </div>
            </div>

            <ul v-else class="tiles" :data-size="size" data-testid="gallery-tiles">
                <li v-for="tile in visibleTiles" :key="tile.screenId">
                    <button
                        :ref="el => observeTile(tile, el as HTMLElement | null)"
                        type="button"
                        class="tile"
                        :aria-label="tileLabel(tile)"
                        data-testid="gallery-tile"
                        @click="openTile(tile)"
                    >
                        <span class="tile-mat">
                            <span v-if="!tile.thumb || thumbSrc(tile) === false" class="tile-missing">
                                {{ tile.thumb ? "Couldn't load" : 'No screenshot' }}
                            </span>
                            <span v-else-if="!thumbSrc(tile)" class="tile-loading" aria-hidden="true" />
                            <img
                                v-else
                                :src="thumbSrc(tile) as string"
                                alt=""
                                decoding="async"
                                :class="{ 'is-tall': tallTiles.has(tile.screenId) }"
                                @load="onThumbLoad($event, tile)"
                            />
                        </span>

                        <span class="tile-foot">
                            <span class="tile-name" :title="tile.name">{{ tile.name }}</span>
                            <span class="tile-tags">
                                <span v-if="hasOverride(tile.tolerances)" class="tag" v-tooltip="toleranceSummary(tile)">
                                    <i class="fa fa-sliders" aria-hidden="true" /> Custom
                                </span>
                                <span v-if="tile.status" class="tag" :class="tile.status.tone">
                                    <i v-if="tile.status.icon" class="fa" :class="tile.status.icon" aria-hidden="true" />
                                    {{ tile.status.label }}
                                </span>
                            </span>
                        </span>
                    </button>
                </li>
            </ul>
        </template>

        <ScreenLightbox
            v-if="lightboxIndex !== null && visibleTiles.length"
            v-model:index="lightboxIndex"
            :app-id="appId"
            :items="visibleTiles"
            :app-tolerances="appTolerances"
            :can-edit="app?.canReview === true"
            :current-label="buildId ? 'New build' : undefined"
            :images="images"
            :app-masks="{ masks: app?.masks ?? [], version: app?.masksVersion ?? 0 }"
            :on-reload-masks="reloadMasks"
            @close="lightboxIndex = null"
            @saved="onToleranceSaved"
            @masks-saved="onMasksSaved"
            @app-masks-saved="onAppMasksSaved"
        />

        <AppTolerances v-if="showAppTolerances && app" :app="app" @close="showAppTolerances = false" @saved="onAppTolerancesSaved" />
    </div>
</template>

<script lang="ts" setup>
/**
 * Browse screens as thumbnails, outside the review flow. Two routes share it: an app's screens
 * (what new builds are compared against) and one build's screens. A thumbnail opens the lightbox,
 * where the screen's comparison tolerances can be read and changed.
 */
import { dataFrom, dataFromAsync } from '@zyno-io/openapi-client-codegen';
import { handleError } from '@zyno-io/vue-foundation';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { useScreenImages } from '@/composables/useScreenImages';
import {
    AppsApi,
    BuildScreensApi,
    BuildsApi,
    type IAppGalleryResponse,
    type IAppMasksResponse,
    type IAppShowResponse,
    type IBuildResponse,
    type IBuildScreenResponse,
    type IScreenMasksResponse,
    ScreensApi
} from '@/openapi-client-generated';
import { accessDeniedMessage, signOut } from '@/shared/access-error';
import LoaderModal from '@/shared/components/loader-modal.vue';
import ScreenLightbox, { type ILightboxScreen } from '@/shared/components/screen-lightbox.vue';
import { BUILD_STATUS, REMOVED_STATUS, REVIEW_STATUS, SCREEN_STATUS } from '@/shared/status';
import {
    formatTolerance,
    hasOverride,
    type IToleranceOverrides,
    type ITolerances,
    pickOverrides,
    resolveTolerances,
    TOLERANCE_FIELDS
} from '@/shared/tolerances';

import AppTolerances from './app-tolerances.vue';
import ScreensSegmented from './screens-segmented.vue';

type Filter = 'all' | 'changed' | 'unchanged' | 'custom';
type Size = 's' | 'm' | 'l';

interface ITile extends ILightboxScreen {
    /** The image shown as the thumbnail: the screen's own, or its reference once it has left the build. */
    thumb?: { buildId: string } | null;
    changed: boolean;
}

const route = useRoute();

const appId = computed(() => String(route.params.id));
const buildId = computed(() => (route.params.buildId ? String(route.params.buildId) : null));

const isLoading = ref(true);
const loadError = ref(false);
const accessDenied = ref<string | null>(null);

const app = ref<IAppShowResponse>();
const build = ref<IBuildResponse>();
const baselineBuild = ref<IBuildResponse | null>(null);
const tiles = ref<ITile[]>([]);

const images = useScreenImages(() => appId.value);

// ── Header context ──
const contextBuild = computed(() => (buildId.value ? build.value : baselineBuild.value));
const buildStatus = computed(() => (build.value ? BUILD_STATUS[build.value.status] : undefined));
const commitUrl = computed(() =>
    app.value?.commitUrlBase && contextBuild.value?.commitHash ? `${app.value.commitUrlBase}/${contextBuild.value.commitHash}` : null
);

// ── Tolerances ──
const FALLBACK_TOLERANCES: ITolerances = { colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.01 };
const showAppTolerances = ref(false);
/** What a screen without its own overrides is compared with. */
const appTolerances = computed(() => resolveTolerances(app.value, app.value?.instanceTolerances ?? FALLBACK_TOLERANCES));

function toleranceSummary(tile: ITile) {
    return TOLERANCE_FIELDS.filter(field => tile.tolerances[field.key] != null)
        .map(field => `${field.label}: ${formatTolerance(field.key, tile.tolerances[field.key]!)}`)
        .join('\n');
}

function onToleranceSaved(screenId: string, tolerances: IToleranceOverrides) {
    const tile = tiles.value.find(t => t.screenId === screenId);
    if (tile) tile.tolerances = tolerances;
}

function onAppTolerancesSaved(tolerances: IToleranceOverrides) {
    if (app.value) Object.assign(app.value, tolerances);
    showAppTolerances.value = false;
}

// ── Masks ──
function onMasksSaved(screenId: string, masks: IScreenMasksResponse) {
    const tile = tiles.value.find(t => t.screenId === screenId);
    if (tile) tile.masks = masks;
}

function onAppMasksSaved(masks: IAppMasksResponse) {
    if (app.value) Object.assign(app.value, { masks: masks.masks, masksVersion: masks.version });
}

/** Re-reads the masks after a save was refused as stale, without closing the lightbox. */
async function reloadMasks() {
    const forApp = appId.value;
    const forBuild = buildId.value;
    const [appResponse, screens] = await Promise.all([
        dataFromAsync(AppsApi.getAppsShow({ path: { id: forApp } })),
        forBuild
            ? dataFromAsync(BuildScreensApi.getBuildScreensGetScreens({ path: { appId: forApp, id: forBuild } }))
            : dataFromAsync(ScreensApi.getScreensIndex({ path: { appId: forApp } })).then(gallery => gallery.screens)
    ]);
    if (forApp !== appId.value || forBuild !== buildId.value) return;
    app.value = appResponse;
    for (const screen of screens) {
        const tile = tiles.value.find(t => t.screenId === screen.screenId);
        if (tile) tile.masks = screen.masks;
    }
}

// ── Filtering ──
const search = ref('');
const filter = ref<Filter>('all');

const filterOptions = computed(() => {
    const all = { value: 'all' as const, label: `All (${tiles.value.length})`, testId: 'gallery-filter-all' };
    const custom = {
        value: 'custom' as const,
        label: `Custom tolerance (${tiles.value.filter(t => hasOverride(t.tolerances)).length})`,
        testId: 'gallery-filter-custom'
    };
    if (!buildId.value) return [all, custom];

    const changed = tiles.value.filter(t => t.changed).length;
    return [
        all,
        { value: 'changed' as const, label: `Changed (${changed})`, testId: 'gallery-filter-changed' },
        { value: 'unchanged' as const, label: `Unchanged (${tiles.value.length - changed})`, testId: 'gallery-filter-unchanged' },
        custom
    ];
});

const visibleTiles = computed(() => {
    const term = search.value.trim().toLowerCase();
    return tiles.value.filter(tile => {
        if (term && !tile.name.toLowerCase().includes(term)) return false;
        if (filter.value === 'changed') return tile.changed;
        if (filter.value === 'unchanged') return !tile.changed;
        if (filter.value === 'custom') return hasOverride(tile.tolerances);
        return true;
    });
});

const resultCount = computed(() => {
    const shown = visibleTiles.value.length;
    const total = tiles.value.length;
    const noun = total === 1 ? 'screen' : 'screens';
    return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
});

// ── Thumbnails ──
const sizeStorageKey = 'pixelci:gallery-size';
function readSavedSize(): Size {
    try {
        const saved = localStorage.getItem(sizeStorageKey);
        return saved === 's' || saved === 'l' ? saved : 'm';
    } catch {
        return 'm';
    }
}
const size = ref<Size>(readSavedSize());
watch(size, value => {
    try {
        localStorage.setItem(sizeStorageKey, value);
    } catch {
        // storage unavailable; the choice just won't persist
    }
});

// Tiles take the shape of the app's screenshots (landscape for a web app, portrait for a phone app) so
// thumbnails fill their mats instead of floating in them. The shape comes from the first screen in the
// list, not whichever image loads first, and is remembered per app so a return visit doesn't reflow.
const DEFAULT_TILE_RATIO = 1.6;
const aspectStorageKey = () => `pixelci:gallery-aspect:${appId.value}`;
const tileRatio = ref(DEFAULT_TILE_RATIO);
const tileAspect = computed(() => `${Math.round(tileRatio.value * 1000)} / 1000`);
const imageRatios = reactive(new Map<string, number>());
// Screens much taller than the tile show their top; the rest is one click away.
const tallTiles = computed(() => new Set([...imageRatios].filter(([, ratio]) => ratio < tileRatio.value * 0.92).map(([id]) => id)));

function readSavedRatio() {
    try {
        const saved = Number(localStorage.getItem(aspectStorageKey()));
        return saved >= 0.5 && saved <= 1.9 ? saved : DEFAULT_TILE_RATIO;
    } catch {
        return DEFAULT_TILE_RATIO;
    }
}

function onThumbLoad(e: Event, tile: ITile) {
    const img = e.target as HTMLImageElement;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const ratio = img.naturalWidth / img.naturalHeight;
    imageRatios.set(tile.screenId, ratio);

    if (tile !== tiles.value.find(t => t.thumb)) return;
    tileRatio.value = Math.min(1.9, Math.max(0.5, ratio));
    try {
        localStorage.setItem(aspectStorageKey(), String(tileRatio.value));
    } catch {
        // storage unavailable; the shape is just worked out again next time
    }
}

function thumbSrc(tile: ITile) {
    return tile.thumb ? images.get('thumb', tile.thumb.buildId, tile.screenId) : false;
}

// Only fetch thumbnails as their tiles come near the viewport.
const tileByElement = new WeakMap<Element, ITile>();
const elementByScreen = new Map<string, Element>();
const observer = new IntersectionObserver(
    entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const tile = tileByElement.get(entry.target);
            if (tile?.thumb) images.request('thumb', tile.thumb.buildId, tile.screenId);
            observer.unobserve(entry.target);
        }
    },
    { rootMargin: '600px 0px' }
);

function observeTile(tile: ITile, el: HTMLElement | null) {
    const previous = elementByScreen.get(tile.screenId);
    if (previous === el) return;
    if (previous) observer.unobserve(previous);
    if (!el) {
        elementByScreen.delete(tile.screenId);
        return;
    }
    elementByScreen.set(tile.screenId, el);
    tileByElement.set(el, tile);
    observer.observe(el);
}

function tileLabel(tile: ITile) {
    return [tile.name, tile.status?.label, hasOverride(tile.tolerances) ? 'custom tolerance' : ''].filter(Boolean).join(', ');
}

// ── Lightbox ──
const lightboxIndex = ref<number | null>(null);

function openTile(tile: ITile) {
    lightboxIndex.value = visibleTiles.value.indexOf(tile);
}

// A save can drop the open screen out of the "Custom tolerance" filter; keep the index in range.
watch(visibleTiles, list => {
    if (lightboxIndex.value === null) return;
    if (!list.length) lightboxIndex.value = null;
    else if (lightboxIndex.value > list.length - 1) lightboxIndex.value = list.length - 1;
});

// ── Loading ──
function buildTile(screen: IBuildScreenResponse, forBuildId: string): ITile {
    const current = screen.currentBuildScreen;
    const reference = screen.referenceBuildScreen;
    const currentImage = current ? { buildId: current.matchedBuildId ?? current.buildId } : null;
    const referenceImage = reference ? { buildId: reference.matchedBuildId ?? reference.buildId } : null;
    const unchanged = current?.status === 'no changes';

    return {
        screenId: screen.screenId,
        name: screen.name,
        status: !current ? REMOVED_STATUS : current.reviewStatus ? REVIEW_STATUS[current.reviewStatus] : SCREEN_STATUS[current.status ?? ''],
        tolerances: pickOverrides(screen.tolerances),
        masks: screen.masks,
        current: currentImage,
        reference: referenceImage,
        diff: currentImage && referenceImage && !unchanged ? currentImage : null,
        compare: { buildId: forBuildId },
        thumb: currentImage ?? referenceImage,
        changed: !unchanged,
        link: unchanged ? undefined : { label: 'Open in review', to: `/apps/${appId.value}/builds/${forBuildId}` }
    };
}

function appTile(screen: IAppGalleryResponse['screens'][number]): ITile {
    const image = { buildId: screen.image.buildId };
    return {
        screenId: screen.screenId,
        name: screen.name,
        status: screen.image.isBaseline ? undefined : { label: 'Not in baseline', tone: 'release' },
        tolerances: pickOverrides(screen.tolerances),
        masks: screen.masks,
        current: image,
        thumb: image,
        changed: false,
        meta: [{ label: 'Shown from', value: screen.image.isBaseline ? 'Baseline build' : 'Latest upload' }],
        link: { label: 'Open its build', to: `/apps/${appId.value}/builds/${screen.image.sourceBuildId}/screens` }
    };
}

let loadRun = 0;

async function load() {
    const run = ++loadRun;
    const forApp = appId.value;
    const forBuild = buildId.value;

    isLoading.value = true;
    loadError.value = false;
    accessDenied.value = null;
    lightboxIndex.value = null;
    showAppTolerances.value = false;
    search.value = '';
    filter.value = 'all';
    tiles.value = [];
    imageRatios.clear();
    tileRatio.value = readSavedRatio();
    build.value = undefined;
    baselineBuild.value = null;

    const [appResult, dataResult] = await Promise.allSettled([
        AppsApi.getAppsShow({ path: { id: forApp } }),
        forBuild
            ? Promise.all([
                  BuildScreensApi.getBuildScreensGetScreens({ path: { appId: forApp, id: forBuild } }),
                  BuildsApi.getBuildsGet({ path: { appId: forApp, id: forBuild } })
              ])
            : ScreensApi.getScreensIndex({ path: { appId: forApp } })
    ]);
    if (run !== loadRun) return;

    try {
        if (appResult.status === 'rejected') throw appResult.reason;
        if (dataResult.status === 'rejected') throw dataResult.reason;
        app.value = dataFrom(appResult.value);

        if (forBuild) {
            const [screensResponse, buildResponse] = dataResult.value as [
                Awaited<ReturnType<typeof BuildScreensApi.getBuildScreensGetScreens>>,
                Awaited<ReturnType<typeof BuildsApi.getBuildsGet>>
            ];
            build.value = dataFrom(buildResponse);
            tiles.value = dataFrom(screensResponse).map(screen => buildTile(screen, forBuild));
            document.title = [app.value.name, build.value.branchName, 'Screens', 'PixelCI'].filter(Boolean).join(' · ');
        } else {
            const gallery = dataFrom(dataResult.value as Awaited<ReturnType<typeof ScreensApi.getScreensIndex>>);
            baselineBuild.value = gallery.baselineBuild;
            tiles.value = gallery.screens.map(appTile);
            document.title = `${app.value.name} · Screens · PixelCI`;
        }
    } catch (err) {
        handleError(err);
        accessDenied.value = accessDeniedMessage(err);
        loadError.value = true;
        document.title = 'Screens unavailable · PixelCI';
    } finally {
        isLoading.value = false;
    }
}

onMounted(load);
// The app and build galleries are the same component, so moving between them doesn't remount it.
watch([appId, buildId], load);

onBeforeUnmount(() => {
    loadRun++;
    observer.disconnect();
});
</script>

<style lang="scss" scoped>
#gallery {
    // ── Header ──
    > .header {
        flex-direction: column;
        align-items: stretch;
        flex-wrap: nowrap;
    }
    .header-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 12px;
    }
    .header-title {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
        flex: 0 1 auto;

        h1 {
            min-width: 0;
            max-width: 320px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
    }
    .header-context {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1 1 0;
        min-width: 0;
        container-type: inline-size;
    }
    .context-label {
        min-width: 0;
        overflow: hidden;
        color: var(--text-3);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
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
        .clip {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .hash {
            flex-shrink: 0;
            color: var(--text);
        }
        &.branch {
            flex: 0 1 auto;
            min-width: 56px;
            max-width: 220px;
        }
        &.commit {
            flex: 0 20 auto;
            min-width: 72px;
        }
    }
    @container (max-width: 420px) {
        .context-item .subject {
            display: none;
        }
    }
    a.context-item:hover,
    a.context-item:hover .hash {
        color: var(--link);
    }
    .build-status {
        height: 24px;
        flex-shrink: 0;
    }
    .header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        margin-left: auto;
    }

    // ── Toolbar ──
    .toolbar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px 12px;
    }
    .search-bar {
        display: flex;
        align-items: center;
        gap: 9px;
        flex: 0 1 280px;
        min-width: 160px;
        padding: 0 10px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius);
        background: var(--surface);
        color: var(--text-3);
        box-shadow: var(--shadow-sm);

        &:focus-within {
            border-color: var(--focus);
            box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .input {
            flex: 1;
            min-width: 0;
            padding: 0;
            border: 0;
            background: transparent;
            box-shadow: none;
        }
        i {
            font-size: 12px;
        }
    }
    .result-count {
        margin-left: auto;
        color: var(--text-3);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }

    .load-error {
        align-items: center;
    }

    // ── Tiles ──
    .tiles {
        --tile-min: 260px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(var(--tile-min), 100%), 1fr));
        gap: 16px;
        margin: 0;
        padding: 0;
        list-style: none;

        &[data-size='s'] {
            --tile-min: 180px;
            gap: 12px;
        }
        &[data-size='l'] {
            --tile-min: 400px;
        }
    }
    .tile {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        height: 100%;
        padding: 8px 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--surface);
        color: var(--text);
        font: inherit;
        text-align: left;
        cursor: zoom-in;
        box-shadow: var(--shadow-sm);
        transition:
            background-color 0.12s,
            border-color 0.12s;

        &:hover {
            border-color: var(--border-strong);
            background: var(--surface-hover);
        }
    }
    .tile-mat {
        position: relative;
        display: block;
        width: 100%;
        aspect-ratio: var(--tile-aspect);
        overflow: hidden;
        border-radius: var(--radius-sm);
        background: var(--surface-3);

        img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        // A screenshot taller than the tile shows its top and fades out where it is cut off.
        img.is-tall {
            object-fit: cover;
            object-position: top center;
            mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
        }
    }
    .tile-loading {
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, var(--surface-3) 0%, var(--surface-2) 50%, var(--surface-3) 100%);
        background-size: 200% 100%;
        animation: skeleton-shimmer 1.4s ease-in-out infinite;
    }
    .tile-missing {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 8px;
        background: var(--surface-2);
        color: var(--text-3);
        font-size: 12px;
        text-align: center;
    }
    .tile-foot {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        padding: 0 4px;
    }
    .tile-name {
        display: -webkit-box;
        min-width: 0;
        overflow: hidden;
        overflow-wrap: anywhere;
        font-size: 13px;
        font-weight: 600;
        line-height: 19px;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
    }
    .tile-tags {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 4px;
        flex-shrink: 0;
        max-width: 60%;
    }
    [data-size='s'] .tile-tags {
        max-width: 100%;
    }
    [data-size='s'] .tile-foot {
        flex-direction: column;
        gap: 6px;
    }
    [data-size='s'] .tile-tags {
        justify-content: flex-start;
    }
}
@media (prefers-reduced-motion: reduce) {
    #gallery .tile-loading {
        animation: none;
    }
}
// The context line moves under the title once the row can't hold title, context and actions.
@media (max-width: 1120px) {
    #gallery .header-context {
        order: 3;
        flex-basis: 100%;
    }
}
@media (max-width: 640px) {
    // The wrapped header would pin a third of a phone screen; let it scroll away with the page.
    #gallery > .header {
        position: static;
    }
    #gallery .header-actions {
        margin-left: 0;
    }
    #gallery .search-bar {
        flex-basis: 100%;
    }
    #gallery .result-count {
        margin-left: 0;
    }
    #gallery .tiles,
    #gallery .tiles[data-size] {
        --tile-min: 150px;
        gap: 10px;
    }
    #gallery .tile-foot {
        flex-direction: column;
        gap: 6px;
    }
    #gallery .tile-tags {
        justify-content: flex-start;
        max-width: 100%;
    }
}
</style>
