/*
 * Anti-aliasing detection with masked pixels treated as absent.
 *
 * `antialiased`, `hasManySiblings` and `brightnessDelta` are ported from pixelmatch 8.0.0
 * (https://github.com/mapbox/pixelmatch), adapted to skip masked pixels.
 *
 * ISC License
 *
 * Copyright (c) 2025, Mapbox
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 */

/** Gamma-space Rec.601 luma delta between the pixel at offset `m` and a centre pixel, composited over white (pixelmatch's `brightnessDelta`). */
function brightnessDelta(img: Uint8Array, m: number, r1: number, g1: number, b1: number, a1: number): number {
    const r2 = img[m];
    const g2 = img[m + 1];
    const b2 = img[m + 2];
    const a2 = img[m + 3];

    let dr = r1 - r2;
    let dg = g1 - g2;
    let db = b1 - b2;
    const da = a1 - a2;

    if (!dr && !dg && !db && !da) return 0;

    if (a1 < 255 || a2 < 255) {
        dr = (r1 * a1 - r2 * a2 - 255 * da) / 255;
        dg = (g1 * a1 - g2 * a2 - 255 * da) / 255;
        db = (b1 * a1 - b2 * a2 - 255 * da) / 255;
        const d = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
        return d === 0 && da ? da / 2 : d;
    }

    return dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
}

/** pixelmatch's `hasManySiblings`: 3+ adjacent pixels of the same colour, where masked pixels aren't counted. Out-of-image edges still count as one. */
function hasManySiblings(img: Uint32Array, x1: number, y1: number, width: number, height: number, mask: Uint8Array): boolean {
    const val = img[y1 * width + x1];
    const x0 = x1 > 0 ? x1 - 1 : 0;
    const y0 = y1 > 0 ? y1 - 1 : 0;
    const x2 = x1 < width - 1 ? x1 + 1 : width - 1;
    const y2 = y1 < height - 1 ? y1 + 1 : height - 1;
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;

    for (let x = x0; x <= x2; x++) {
        for (let y = y0; y <= y2; y++) {
            if (x === x1 && y === y1) continue;
            const pos = y * width + x;
            if (mask[pos]) continue;
            if (val === img[pos]) zeroes++;
            if (zeroes > 2) return true;
        }
    }
    return false;
}

/** pixelmatch's `antialiased` ("Anti-aliased Pixel and Intensity Slope Detector", V. Vysniauskas, 2009), with masked pixels absent. */
function antialiased(img: Uint8Array, x1: number, y1: number, width: number, height: number, a32: Uint32Array, b32: Uint32Array, mask: Uint8Array) {
    const x0 = x1 > 0 ? x1 - 1 : 0;
    const y0 = y1 > 0 ? y1 - 1 : 0;
    const x2 = x1 < width - 1 ? x1 + 1 : width - 1;
    const y2 = y1 < height - 1 ? y1 + 1 : height - 1;
    const pos4 = (y1 * width + x1) * 4;
    const cr = img[pos4];
    const cg = img[pos4 + 1];
    const cb = img[pos4 + 2];
    const ca = img[pos4 + 3];
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
    let min = 0;
    let max = 0;
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;

    for (let x = x0; x <= x2; x++) {
        for (let y = y0; y <= y2; y++) {
            if (x === x1 && y === y1) continue;
            const n = y * width + x;
            if (mask[n]) continue;

            const delta = brightnessDelta(img, n * 4, cr, cg, cb, ca);
            if (delta === 0) {
                zeroes++;
                if (zeroes > 2) return false;
            } else if (delta < min) {
                min = delta;
                minX = x;
                minY = y;
            } else if (delta > max) {
                max = delta;
                maxX = x;
                maxY = y;
            }
        }
    }

    if (min === 0 || max === 0) return false;

    return (
        (hasManySiblings(a32, minX, minY, width, height, mask) && hasManySiblings(b32, minX, minY, width, height, mask)) ||
        (hasManySiblings(a32, maxX, maxY, width, height, mask) && hasManySiblings(b32, maxX, maxY, width, height, mask))
    );
}

/** Whether pixelmatch would exclude the differing pixel (x, y) as anti-aliasing, ignoring every masked pixel. */
export function isAntialiasedIgnoringMask(
    img1: Uint8Array,
    img2: Uint8Array,
    a32: Uint32Array,
    b32: Uint32Array,
    x: number,
    y: number,
    width: number,
    height: number,
    mask: Uint8Array
): boolean {
    return antialiased(img1, x, y, width, height, a32, b32, mask) || antialiased(img2, x, y, width, height, b32, a32, mask);
}

/** Whether any masked pixel lies within `radius` (Chebyshev distance) of (x, y). */
export function maskedWithin(mask: Uint8Array, x: number, y: number, width: number, height: number, radius: number): boolean {
    const yMax = Math.min(height - 1, y + radius);
    const xMax = Math.min(width - 1, x + radius);
    for (let ny = Math.max(0, y - radius); ny <= yMax; ny++) {
        for (let nx = Math.max(0, x - radius); nx <= xMax; nx++) {
            if (mask[ny * width + nx]) return true;
        }
    }
    return false;
}
