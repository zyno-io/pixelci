import { decodeRgba, encodePng, IRgbaImage } from './Image';
import { S3Service } from './S3.service';

/** Thumbnails are at most this wide: enough for a gallery tile on a high-density display. */
export const THUMBNAIL_MAX_WIDTH = 640;
/** ...and at most this many times taller than wide. A tile shows the top of a long page; the rest is cropped. */
export const THUMBNAIL_MAX_ASPECT = 2.5;

/**
 * For each output pixel along one axis, the source pixels it covers and how much of each: an area
 * average, so thin lines and text fade evenly instead of dropping out as they would with sampling.
 */
function axisWeights(srcSize: number, dstSize: number) {
    const scale = srcSize / dstSize;
    const starts = new Int32Array(dstSize);
    const counts = new Int32Array(dstSize);
    const weights: number[] = [];
    const offsets = new Int32Array(dstSize);
    for (let d = 0; d < dstSize; d++) {
        const from = d * scale;
        const to = Math.min(srcSize, (d + 1) * scale);
        const first = Math.floor(from);
        const last = Math.min(srcSize - 1, Math.ceil(to) - 1);
        starts[d] = first;
        counts[d] = last - first + 1;
        offsets[d] = weights.length;
        for (let s = first; s <= last; s++) {
            weights.push((Math.min(to, s + 1) - Math.max(from, s)) / (to - from));
        }
    }
    return { starts, counts, offsets, weights: Float64Array.from(weights) };
}

/**
 * Scales a screenshot down to a gallery thumbnail. Never scales up; an already small image is only
 * re-encoded. Colour profiles are applied (converted to sRGB), so the tile looks like the full-size
 * image does in the browser. The scaling is our own area average: libvips' kernels ring and darken
 * the edge columns of fine 1px detail, which is most of what a screenshot is.
 */
export async function makeThumbnail(source: Uint8Array): Promise<Buffer> {
    const src = await decodeRgba(source, { toSrgb: true });
    const dstWidth = Math.min(src.width, THUMBNAIL_MAX_WIDTH);
    const scale = src.width / dstWidth;
    // crop from the top before scaling, so a very long page costs no more than a tall one
    const srcHeight = Math.min(src.height, Math.max(1, Math.floor(dstWidth * THUMBNAIL_MAX_ASPECT * scale)));
    const dstHeight = Math.max(1, Math.round(srcHeight / scale));

    const xs = axisWeights(src.width, dstWidth);
    const ys = axisWeights(srcHeight, dstHeight);

    // Horizontal pass into premultiplied floats, so transparent pixels don't bleed their colour.
    const rows = new Float32Array(dstWidth * srcHeight * 4);
    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < dstWidth; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            const start = xs.starts[x];
            for (let i = 0; i < xs.counts[x]; i++) {
                const w = xs.weights[xs.offsets[x] + i];
                const p = (y * src.width + start + i) * 4;
                const alpha = src.data[p + 3] * w;
                r += src.data[p] * alpha;
                g += src.data[p + 1] * alpha;
                b += src.data[p + 2] * alpha;
                a += alpha;
            }
            const o = (y * dstWidth + x) * 4;
            rows[o] = r;
            rows[o + 1] = g;
            rows[o + 2] = b;
            rows[o + 3] = a;
        }
    }

    const dst: IRgbaImage = { width: dstWidth, height: dstHeight, data: Buffer.alloc(dstWidth * dstHeight * 4) };
    for (let y = 0; y < dstHeight; y++) {
        const start = ys.starts[y];
        for (let x = 0; x < dstWidth; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let i = 0; i < ys.counts[y]; i++) {
                const w = ys.weights[ys.offsets[y] + i];
                const p = ((start + i) * dstWidth + x) * 4;
                r += rows[p] * w;
                g += rows[p + 1] * w;
                b += rows[p + 2] * w;
                a += rows[p + 3] * w;
            }
            const o = (y * dstWidth + x) * 4;
            if (a > 0) {
                dst.data[o] = Math.round(r / a);
                dst.data[o + 1] = Math.round(g / a);
                dst.data[o + 2] = Math.round(b / a);
            }
            dst.data[o + 3] = Math.round(a);
        }
    }

    return encodePng(dst);
}

export class ThumbnailService {
    // Storage is the only record of which thumbnails exist, so any number of API and worker processes
    // agree. These two fields only coordinate work inside one process; if two processes generate the
    // same thumbnail at once they write identical bytes to the same key.
    private inFlight = new Map<string, Promise<void>>();
    // Scaling is synchronous CPU work on the API process (decode and encode run off it, in sharp): one
    // at a time, with a turn of the event loop between them, so a gallery's first load doesn't starve
    // other requests.
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private s3Svc: S3Service) {}

    /**
     * Makes sure a screen's thumbnail is in storage, generating it from the full screenshot the first
     * time it is asked for, and returns its storage path. Rejects if the screenshot itself is missing.
     * `buildScreenId` identifies the upload, so a screenshot replaced in place gets a fresh thumbnail.
     * `sourceBuildId` names the build whose upload to scale when it is not `buildId` itself (a row whose own upload was cleaned up).
     */
    async ensure(appId: string, buildId: string, screenId: string, buildScreenId: string, sourceBuildId: string = buildId): Promise<string> {
        const path = this.s3Svc.getPathForThumbnail(appId, buildId, screenId, buildScreenId);
        let pending = this.inFlight.get(path);
        if (!pending) {
            pending = this.generateIfMissing(path, this.s3Svc.getPathForScreen(appId, sourceBuildId, screenId)).finally(() =>
                this.inFlight.delete(path)
            );
            this.inFlight.set(path, pending);
        }
        await pending;
        return path;
    }

    private async generateIfMissing(path: string, sourcePath: string) {
        if (await this.s3Svc.exists(path)) return;
        const source = await this.s3Svc.getBuffer(sourcePath);
        const run = this.queue.then(async () => {
            await new Promise(resolve => setImmediate(resolve));
            return makeThumbnail(source);
        });
        this.queue = run.catch(() => undefined);
        await this.s3Svc.uploadFile(await run, path, 'image/png');
    }
}
