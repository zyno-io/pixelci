import { ScopedLogger } from '@zyno-io/ts-server-foundation';
import { memoize } from 'lodash';
import { PNG } from 'pngjs/browser';

const loadPixelMatch = memoize(async () => {
    return (await import('pixelmatch')).default;
});

export interface IPixelMatchDiffResult {
    totalPixels: number;
    diffPixels: number;
    diffPct: number;
    /** pixels that differed in place but were explained by a small positional shift (not counted in diffPixels) */
    shiftTolerantPixels: number;
    getDiffPng: () => Buffer;
}

function normalizeToCanvas(img: PNG, targetWidth: number, targetHeight: number): PNG {
    const canvas = new PNG({ width: targetWidth, height: targetHeight, fill: true });
    // fill with magenta (255, 0, 255, 255) so size differences are obvious
    for (let i = 0; i < canvas.data.length; i += 4) {
        canvas.data[i] = 255;
        canvas.data[i + 1] = 0;
        canvas.data[i + 2] = 255;
        canvas.data[i + 3] = 255;
    }
    // copy the original image onto the top-left of the canvas
    PNG.bitblt(img, canvas, 0, 0, img.width, img.height, 0, 0);
    return canvas;
}

// ── Colour similarity, matching pixelmatch 8 ──
// pixelmatch decides "same or different" with the HyAB distance in OKLab (|ΔLr| + √(Δa² + Δb²), with
// Ottosson's toe-corrected lightness) compared directly against the threshold. The shift pass has to
// make the same call, or it would forgive pixels pixelmatch flagged without any shift being involved.
// These constants and formulas mirror pixelmatch's opaque path; re-check them when upgrading it.
const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const TOE_K1 = 0.206;
const TOE_K2 = 0.03;
const TOE_K3 = (1 + TOE_K1) / (1 + TOE_K2);

// Direct-mapped cache of opaque RGB -> cube-rooted LMS + lightness. Screenshots reuse few colours.
const LAB_CACHE_BITS = 14;
const LAB_CACHE_SHIFT = 32 - LAB_CACHE_BITS;
const LAB_KEYS = new Uint32Array(1 << LAB_CACHE_BITS);
const LAB_VALUES = new Float64Array((1 << LAB_CACHE_BITS) * 4);

/** Offset into LAB_VALUES of [l, m, s, Lr] for an opaque colour. Only valid until the next call. */
function labOffset(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    const slot = Math.imul(key, 0x9e3779b1) >>> LAB_CACHE_SHIFT;
    const offset = slot * 4;
    if (LAB_KEYS[slot] !== key + 1) {
        const lr = LIN[r];
        const lg = LIN[g];
        const lb = LIN[b];
        const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
        const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
        const sv = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
        const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * sv;
        const x = TOE_K3 * L - TOE_K1;
        LAB_KEYS[slot] = key + 1;
        LAB_VALUES[offset] = l;
        LAB_VALUES[offset + 1] = m;
        LAB_VALUES[offset + 2] = sv;
        LAB_VALUES[offset + 3] = 0.5 * (x + Math.sqrt(x * x + 4 * TOE_K2 * TOE_K3 * L));
    }
    return offset;
}

/**
 * Whether the pixel at (x, y) in `src` has a similar pixel within `radius` of the same spot in `other`,
 * not counting the spot itself (pixelmatch already compared that one and called it different).
 * Semi-transparent pixels only match an identical pixel: pixelmatch judges them over a background
 * that depends on position, so its verdict can't be carried to another offset.
 */
function hasNearbyMatch(
    src: Uint8Array,
    src32: Uint32Array,
    other: Uint8Array,
    other32: Uint32Array,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    maxDelta: number
) {
    const i = y * width + x;
    const rgba = src32[i];
    const opaque = src[i * 4 + 3] === 255;

    let l = 0;
    let m = 0;
    let s = 0;
    let lr = 0;
    if (opaque) {
        // copied out: a neighbour's lookup may reuse this cache slot
        const o = labOffset(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]);
        l = LAB_VALUES[o];
        m = LAB_VALUES[o + 1];
        s = LAB_VALUES[o + 2];
        lr = LAB_VALUES[o + 3];
    }

    const yMin = Math.max(0, y - radius);
    const yMax = Math.min(height - 1, y + radius);
    const xMin = Math.max(0, x - radius);
    const xMax = Math.min(width - 1, x + radius);

    for (let ny = yMin; ny <= yMax; ny++) {
        for (let nx = xMin; nx <= xMax; nx++) {
            const j = ny * width + nx;
            if (j === i) continue;
            if (other32[j] === rgba) return true;
            if (!opaque || other[j * 4 + 3] !== 255) continue;

            const o = labOffset(other[j * 4], other[j * 4 + 1], other[j * 4 + 2]);
            const rest = maxDelta - Math.abs(lr - LAB_VALUES[o + 3]);
            if (rest < 0) continue;
            const dl = l - LAB_VALUES[o];
            const dm = m - LAB_VALUES[o + 1];
            const ds = s - LAB_VALUES[o + 2];
            const da = 1.9779984951 * dl - 2.428592205 * dm + 0.4505937099 * ds;
            const db = 0.0259040371 * dl + 0.7827717662 * dm - 0.808675766 * ds;
            if (da * da + db * db <= rest * rest) return true;
        }
    }
    return false;
}

const YIELD_AFTER_MS = 12;
// Upper bound on neighbour comparisons in one shift pass (diff pixels x neighbourhood size). Past it
// the images differ so widely, at so large a radius, that the pass would take many seconds; the
// diff is then reported unforgiven. The rule depends only on the inputs, so a preview and the real
// processing of the same pair always agree.
const MAX_SHIFT_CHECKS = 300_000_000;

/**
 * Forgives diff pixels that are explained by content moving up to `radius` pixels: a pixel is
 * forgiven only if its colour in each image exists within `radius` of the same spot in the other
 * image. New, removed or recoloured content fails one direction and stays a diff. Because the test
 * is per pixel, an edge that grows or shrinks by up to `radius` next to its own colour (a 1px border
 * becoming 2px) is forgiven as well. Forgiven pixels are repainted yellow (pixelmatch's "detected
 * but ignored" colour) in the diff image.
 *
 * The scan gives the event loop a turn every few milliseconds, so a large comparison run inside the
 * API process (the tolerance preview) doesn't stall other requests.
 */
async function applyShiftTolerance(
    img1: Uint8Array,
    img2: Uint8Array,
    diff: Uint8Array,
    width: number,
    height: number,
    radius: number,
    threshold: number
) {
    const len = width * height;
    const a32 = new Uint32Array(img1.buffer, img1.byteOffset, len);
    const b32 = new Uint32Array(img2.buffer, img2.byteOffset, len);
    let forgiven = 0;
    let lastYield = performance.now();

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) << 2;
            // pixelmatch paints counted diffs pure red; unchanged pixels are gray and AA pixels yellow
            if (diff[idx] !== 255 || diff[idx + 1] !== 0 || diff[idx + 2] !== 0) continue;

            if (
                hasNearbyMatch(img1, a32, img2, b32, x, y, width, height, radius, threshold) &&
                hasNearbyMatch(img2, b32, img1, a32, x, y, width, height, radius, threshold)
            ) {
                diff[idx + 1] = 255;
                forgiven++;
            }
        }

        if (performance.now() - lastYield > YIELD_AFTER_MS) {
            await new Promise<void>(resolve => setImmediate(resolve));
            lastYield = performance.now();
        }
    }

    return forgiven;
}

export class PixelMatchService {
    constructor(private logger: ScopedLogger) {}

    private exclusive: Promise<unknown> = Promise.resolve();

    /**
     * Runs a comparison after any other queued through here has finished. For comparisons started by
     * API requests (the tolerance preview), so a burst of them is worked through one at a time
     * instead of piling CPU work onto the process that serves every other request.
     */
    getDiffExclusive(...args: Parameters<PixelMatchService['getDiff']>): Promise<IPixelMatchDiffResult> {
        const run = this.exclusive.then(() => this.getDiff(...args));
        this.exclusive = run.catch(() => undefined);
        return run;
    }

    async getDiff(img1Buf: Buffer, img2Buf: Buffer, pixelMatchThreshold = 0.2, shiftTolerance = 0): Promise<IPixelMatchDiffResult> {
        const pixelmatch = await loadPixelMatch();

        const diffStart = performance.now();

        const img1 = PNG.sync.read(img1Buf);
        const img2 = PNG.sync.read(img2Buf);

        const sizesDiffer = img1.width !== img2.width || img1.height !== img2.height;

        const width = Math.max(img1.width, img2.width);
        const height = Math.max(img1.height, img2.height);

        const norm1 = sizesDiffer ? normalizeToCanvas(img1, width, height) : img1;
        const norm2 = sizesDiffer ? normalizeToCanvas(img2, width, height) : img2;

        const diffTarget = new PNG({ width, height });
        const rawDiffPixels = pixelmatch(norm1.data, norm2.data, diffTarget.data, width, height, {
            threshold: pixelMatchThreshold,
            includeAA: false
        });

        const shiftRadius = Math.max(0, Math.floor(shiftTolerance));
        const shiftChecks = rawDiffPixels * ((2 * shiftRadius + 1) ** 2 - 1);
        if (shiftRadius > 0 && shiftChecks > MAX_SHIFT_CHECKS) {
            this.logger.info('Skipping shift tolerance: too many differing pixels for this radius', { rawDiffPixels, shiftRadius });
        }
        const shiftTolerantPixels =
            shiftRadius > 0 && rawDiffPixels > 0 && shiftChecks <= MAX_SHIFT_CHECKS
                ? await applyShiftTolerance(norm1.data, norm2.data, diffTarget.data, width, height, shiftRadius, pixelMatchThreshold)
                : 0;
        const diffPixels = rawDiffPixels - shiftTolerantPixels;

        const totalPixels = width * height;
        const diffPct = (diffPixels / totalPixels) * 100;

        const diffEnd = performance.now();
        const diffTime = diffEnd - diffStart;

        this.logger.info('Diff completed', { sizesDiffer, diffTime, totalPixels, diffPixels, diffPct, shiftTolerantPixels });

        return {
            totalPixels,
            diffPixels,
            diffPct,
            shiftTolerantPixels,
            getDiffPng: () => PNG.sync.write(diffTarget)
        };
    }
}
