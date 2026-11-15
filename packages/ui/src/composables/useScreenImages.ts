import { handleError } from '@zyno-io/vue-foundation';
import { onBeforeUnmount, reactive } from 'vue';

import { BuildScreensApi } from '@/openapi-client-generated';

/** `thumb` is a scaled-down screenshot for gallery tiles; `image` is the full-size one. */
export type ScreenImageKind = 'image' | 'thumb' | 'diff';

/** A loaded object URL, `false` when the image could not be loaded, `undefined` while pending. */
export type ScreenImageSrc = string | false | undefined;

const MAX_CONCURRENT = 6;

/**
 * Loads screenshots and diffs as blobs (the image endpoints need the session's auth header, so a
 * plain <img src> can't fetch them) and hands out object URLs. Requests are de-duplicated, capped
 * at a few at a time so a large gallery doesn't open hundreds of connections, and newest-first so
 * what the user just scrolled to or opened jumps the queue. URLs are revoked when the owner unmounts.
 */
export function useScreenImages(appId: () => string) {
    const sources = reactive(new Map<string, string | false>());
    const queued = new Map<string, () => Promise<void>>();
    const loading = new Set<string>();
    const objectUrls = new Set<string>();
    let disposed = false;

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
        if (disposed || sources.has(key) || loading.has(key)) return;

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
                const url = URL.createObjectURL(response.data as Blob);
                objectUrls.add(url);
                sources.set(key, url);
            } catch (err) {
                handleError(err);
                if (!disposed) sources.set(key, false);
            }
        });
        pump();
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
    }

    onBeforeUnmount(dispose);

    return { request, get };
}

export type ScreenImages = ReturnType<typeof useScreenImages>;
