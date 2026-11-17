import { handleError } from '@zyno-io/vue-foundation';
import { onBeforeUnmount, reactive } from 'vue';

import { BuildScreensApi } from '@/openapi-client-generated';

/** `thumb` is a scaled-down screenshot for gallery tiles; `image` is the full-size one. */
export type ScreenImageKind = 'image' | 'thumb' | 'diff';

/** A loaded object URL, `false` when the image could not be loaded, `undefined` while pending. */
export type ScreenImageSrc = string | false | undefined;

const MAX_CONCURRENT = 6;

/**
 * Full-size screenshots and diffs kept loaded beyond what's in use, in blob bytes. Past it the least recently
 * used ones are unloaded and fetched again if they come back. Thumbnails are small and always stay.
 */
const MAX_LOADED_BYTES = 200 * 1024 * 1024;

export type ScreenImageRef = [kind: ScreenImageKind, buildId: string, screenId: string];

/**
 * Loads screenshots and diffs as blobs (the image endpoints need the session's auth header, so a
 * plain <img src> can't fetch them) and hands out object URLs. Requests are de-duplicated, capped
 * at a few at a time so a large gallery doesn't open hundreds of connections, and newest-first so
 * what the user just scrolled to or opened jumps the queue. Full-size images past a byte budget are
 * unloaded least recently used first, except those a caller holds (see `hold`). URLs are revoked when
 * the owner unmounts.
 */
export function useScreenImages(appId: () => string) {
    const sources = reactive(new Map<string, string | false>());
    const queued = new Map<string, () => Promise<void>>();
    const loading = new Set<string>();
    const objectUrls = new Set<string>();
    let disposed = false;
    let pumpScheduled = false;
    // Loaded full-size images and diffs by blob size, least recently used first.
    const loadedSizes = new Map<string, number>();
    let loadedBytes = 0;
    const holds = new Map<string, Set<string>>();

    const keyOf = (kind: ScreenImageKind, buildId: string, screenId: string) => `${kind}:${buildId}:${screenId}`;

    function pump() {
        while (!disposed && loading.size < MAX_CONCURRENT && queued.size) {
            const key = [...queued.keys()].pop()!;
            const run = queued.get(key)!;
            queued.delete(key);
            loading.add(key);
            void run().finally(() => {
                loading.delete(key);
                pump();
            });
        }
    }

    function request(kind: ScreenImageKind, buildId: string, screenId: string) {
        const key = keyOf(kind, buildId, screenId);
        if (disposed || loading.has(key)) return;
        if (sources.has(key)) {
            // Asked for again: now the most recently used.
            const size = loadedSizes.get(key);
            if (size !== undefined) {
                loadedSizes.delete(key);
                loadedSizes.set(key, size);
            }
            return;
        }

        // Re-requesting something still queued moves it to the front.
        queued.delete(key);
        queued.set(key, async () => {
            try {
                const path = { appId: appId(), id: buildId, screenId };
                const response =
                    kind === 'diff'
                        ? await BuildScreensApi.getBuildScreensGetScreenDiff({ path })
                        : kind === 'thumb'
                          ? await BuildScreensApi.getBuildScreensGetScreenThumbnail({ path })
                          : await BuildScreensApi.getBuildScreensGetScreenImage({ path });
                if (disposed) return;
                const blob = response.data as Blob;
                const url = URL.createObjectURL(blob);
                objectUrls.add(url);
                sources.set(key, url);
                if (kind !== 'thumb') {
                    loadedSizes.set(key, blob.size);
                    loadedBytes += blob.size;
                    evict();
                }
            } catch (err) {
                handleError(err);
                if (!disposed) sources.set(key, false);
            }
        });
        // Start on a microtask, not now: callers queue a whole batch least-urgent first, and starting the first
        // few as they arrive would hand the free slots to the least urgent ones.
        if (!pumpScheduled) {
            pumpScheduled = true;
            queueMicrotask(() => {
                pumpScheduled = false;
                pump();
            });
        }
    }

    /** Drops a request that hasn't started, e.g. for a card scrolled out of the rendered range. In-flight and loaded images stay. */
    function release(kind: ScreenImageKind, buildId: string, screenId: string) {
        queued.delete(keyOf(kind, buildId, screenId));
    }

    /**
     * Marks the images `owner` is showing (or about to), replacing what it held before. Held images are never
     * unloaded; an unloaded image only comes back when asked for again, so anything on screen must be held.
     */
    function hold(owner: string, refs: Iterable<ScreenImageRef>) {
        holds.set(owner, new Set(Array.from(refs, ref => keyOf(...ref))));
        evict();
    }

    function evict() {
        if (loadedBytes <= MAX_LOADED_BYTES) return;
        const held = new Set<string>();
        for (const keys of holds.values()) for (const key of keys) held.add(key);
        for (const [key, size] of loadedSizes) {
            if (loadedBytes <= MAX_LOADED_BYTES) break;
            if (held.has(key)) continue;
            loadedSizes.delete(key);
            loadedBytes -= size;
            const url = sources.get(key);
            if (url) {
                URL.revokeObjectURL(url);
                objectUrls.delete(url);
            }
            sources.delete(key);
        }
    }

    function get(kind: ScreenImageKind, buildId: string, screenId: string): ScreenImageSrc {
        return sources.get(keyOf(kind, buildId, screenId));
    }

    function dispose() {
        disposed = true;
        queued.clear();
        objectUrls.forEach(url => URL.revokeObjectURL(url));
        objectUrls.clear();
        sources.clear();
        loadedSizes.clear();
        loadedBytes = 0;
        holds.clear();
    }

    onBeforeUnmount(dispose);

    return { request, release, hold, get };
}

export type ScreenImages = ReturnType<typeof useScreenImages>;
