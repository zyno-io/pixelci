import { ScopedLogger } from '@zyno-io/ts-server-foundation';
import { memoize } from 'lodash';

import { decodeRgba, encodePng, IRgbaImage } from './Image';
import { IMaskRect, MASK_FILL, rasterizeMasks } from './Mask';

/** Mask tint on the stored diff image: mid grey at 40%, matching the UI's `--mask-fill`. */
const MASK_TINT_GREY = 128;
const MASK_TINT_ALPHA = 0.4;
/** Thin diagonal lines over the tint, matching the UI's `--mask-line`: a darker grey at a higher alpha, 8 px apart along x. */
const MASK_LINE_GREY = 70;
const MASK_LINE_ALPHA = 0.6;
const MASK_LINE_SPACING = 8;
import { isAntialiasedIgnoringMask } from './MaskedAntialias';

const loadPixelMatch = memoize(async () => {
    return (await import('pixelmatch')).default;
});

export interface IPixelMatchDiffResult {
    totalPixels: number;
    diffPixels: number;
    diffPct: number;
    /** pixels that differed in place but were explained by a small positional shift (not counted in diffPixels) */
    shiftTolerantPixels: number;
    /** pixels under a mask: excluded from the comparison and from the denominator of diffPct */
    maskedPixels: number;
    getDiffPng: () => Promise<Buffer>;
}

function normalizeToCanvas(img: IRgbaImage, targetWidth: number, targetHeight: number): IRgbaImage {
    const data = Buffer.alloc(targetWidth * targetHeight * 4);
    // fill with magenta (255, 0, 255, 255) so size differences are obvious
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 255;
        data[i + 1] = 0;
        data[i + 2] = 255;
        data[i + 3] = 255;
    }
    // copy the original image onto the top-left of the canvas
    const rowBytes = img.width * 4;
    for (let y = 0; y < img.height; y++) {
        img.data.copy(data, y * targetWidth * 4, y * rowBytes, y * rowBytes + rowBytes);
    }
    return { width: targetWidth, height: targetHeight, data };
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
    maxDelta: number,
    mask: Uint8Array | null
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
            if (mask && mask[j]) continue; // masked content can't excuse an unmasked pixel
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
    threshold: number,
    mask: Uint8Array | null
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
                hasNearbyMatch(img1, a32, img2, b32, x, y, width, height, radius, threshold, mask) &&
                hasNearbyMatch(img2, b32, img1, a32, x, y, width, height, radius, threshold, mask)
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

const AA_RADIUS = 2;

/**
 * Policy: a mask must never excuse a pixel that plain pixelmatch, run with the fill painted, counted as changed. Near a mask a
 * pixel is excused only if pixelmatch (with the fill) and the masked-absent test both call it anti-aliasing. So the only flip
 * is yellow to red: a pixel pixelmatch excused as anti-aliasing which, with masked pixels treated as absent, is not. False
 * positives at mask edges are accepted (the docs advise padding masks).
 *
 * Only pixels within AA_RADIUS (Chebyshev distance) of a masked pixel can be skewed by the fill, so this visits only each mask
 * rectangle grown by AA_RADIUS and clipped to the canvas, skipping masked pixels. Cost is proportional to the masks' grown
 * area, not to the number of differing pixels. Overlapping rectangles need no visited bitmap: a flipped pixel is repainted red,
 * so a second visit no longer sees it as yellow and cannot count it twice. Returns the number of pixels newly counted.
 * Same-coloured pixels are gray in the output and are left alone.
 */
function reclassifyNearMask(
    img1: Uint8Array,
    img2: Uint8Array,
    diff: Uint8Array,
    width: number,
    height: number,
    mask: Uint8Array,
    rects: readonly IMaskRect[]
): number {
    const len = width * height;
    const a32 = new Uint32Array(img1.buffer, img1.byteOffset, len);
    const b32 = new Uint32Array(img2.buffer, img2.byteOffset, len);
    let change = 0;

    for (const rect of rects) {
        const x0 = Math.max(0, rect.x - AA_RADIUS);
        const y0 = Math.max(0, rect.y - AA_RADIUS);
        const x1 = Math.min(width, rect.x + rect.width + AA_RADIUS);
        const y1 = Math.min(height, rect.y + rect.height + AA_RADIUS);

        for (let y = y0; y < y1; y++) {
            for (let x = x0, i = y * width + x0; x < x1; x++, i++) {
                const o = i << 2;
                // yellow only (255, 255, 0); masked pixels are never compared
                if (diff[o] !== 255 || diff[o + 1] !== 255 || diff[o + 2] !== 0 || mask[i]) continue;
                if (!isAntialiasedIgnoringMask(img1, img2, a32, b32, x, y, width, height, mask)) {
                    diff[o + 1] = 0; // red
                    change++;
                }
            }
        }
    }
    return change;
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

    async getDiff(
        img1Buf: Buffer,
        img2Buf: Buffer,
        pixelMatchThreshold = 0.2,
        shiftTolerance = 0,
        masks: readonly IMaskRect[] = []
    ): Promise<IPixelMatchDiffResult> {
        const pixelmatch = await loadPixelMatch();

        const diffStart = performance.now();

        const [img1, img2] = await Promise.all([decodeRgba(img1Buf), decodeRgba(img2Buf)]);

        const sizesDiffer = img1.width !== img2.width || img1.height !== img2.height;

        const width = Math.max(img1.width, img2.width);
        const height = Math.max(img1.height, img2.height);

        const norm1 = sizesDiffer ? normalizeToCanvas(img1, width, height) : img1;
        const norm2 = sizesDiffer ? normalizeToCanvas(img2, width, height) : img2;

        // Masked pixels are painted identically into both images, so pixelmatch (and its anti-aliasing checks next to a
        // mask edge) sees no difference there, and nothing under a mask can influence a result.
        const raster = rasterizeMasks(masks, width, height);
        const mask = raster?.bitmap ?? null;
        const maskedPixels = raster?.maskedPixels ?? 0;
        if (mask) {
            for (let i = 0; i < mask.length; i++) {
                if (!mask[i]) continue;
                const o = i << 2;
                norm1.data[o] = norm2.data[o] = MASK_FILL[0];
                norm1.data[o + 1] = norm2.data[o + 1] = MASK_FILL[1];
                norm1.data[o + 2] = norm2.data[o + 2] = MASK_FILL[2];
                norm1.data[o + 3] = norm2.data[o + 3] = MASK_FILL[3];
            }
        }

        const diffTarget: IRgbaImage = { width, height, data: Buffer.alloc(width * height * 4) };
        let rawDiffPixels = pixelmatch(norm1.data, norm2.data, diffTarget.data, width, height, {
            threshold: pixelMatchThreshold,
            includeAA: false
        });

        // The uniform fill under a mask has many "siblings" and so can make pixelmatch excuse a pixel up to 2 px away as
        // anti-aliasing. Re-test those with masked pixels absent; only ever yellow to red, never the other way.
        if (mask) rawDiffPixels += reclassifyNearMask(norm1.data, norm2.data, diffTarget.data, width, height, mask, masks);

        const shiftRadius = Math.max(0, Math.floor(shiftTolerance));
        const shiftChecks = rawDiffPixels * ((2 * shiftRadius + 1) ** 2 - 1);
        if (shiftRadius > 0 && shiftChecks > MAX_SHIFT_CHECKS) {
            this.logger.info('Skipping shift tolerance: too many differing pixels for this radius', { rawDiffPixels, shiftRadius });
        }
        const shiftTolerantPixels =
            shiftRadius > 0 && rawDiffPixels > 0 && shiftChecks <= MAX_SHIFT_CHECKS
                ? await applyShiftTolerance(norm1.data, norm2.data, diffTarget.data, width, height, shiftRadius, pixelMatchThreshold, mask)
                : 0;
        const diffPixels = rawDiffPixels - shiftTolerantPixels;

        const totalPixels = width * height;
        const comparedPixels = totalPixels - maskedPixels;
        const diffPct = comparedPixels > 0 ? (diffPixels / comparedPixels) * 100 : 0;

        // masked pixels get the translucent neutral tint (the UI's mask fill) composited over whatever the diff already
        // has there, so red, yellow and magenta keep their meanings. Display only: the counts above already exclude them.
        if (mask) {
            for (let i = 0; i < mask.length; i++) {
                if (!mask[i]) continue;
                const o = i << 2;
                // on a line (x + y a multiple of the spacing): the darker line colour, else the plain tint
                const onLine = ((i % width) + Math.floor(i / width)) % MASK_LINE_SPACING === 0;
                const grey = onLine ? MASK_LINE_GREY : MASK_TINT_GREY;
                const alpha = onLine ? MASK_LINE_ALPHA : MASK_TINT_ALPHA;
                const dstA = diffTarget.data[o + 3] / 255;
                const outA = alpha + dstA * (1 - alpha);
                for (let c = 0; c < 3; c++) {
                    const blended = (grey * alpha + diffTarget.data[o + c] * dstA * (1 - alpha)) / outA;
                    diffTarget.data[o + c] = Math.round(blended);
                }
                diffTarget.data[o + 3] = Math.round(outA * 255);
            }
        }

        const diffEnd = performance.now();
        const diffTime = diffEnd - diffStart;

        this.logger.info('Diff completed', { sizesDiffer, diffTime, totalPixels, diffPixels, diffPct, shiftTolerantPixels, maskedPixels });

        return {
            totalPixels,
            diffPixels,
            diffPct,
            shiftTolerantPixels,
            maskedPixels,
            getDiffPng: () => encodePng(diffTarget)
        };
    }
}
