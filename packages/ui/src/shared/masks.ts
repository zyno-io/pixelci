/**
 * Masks: rectangles, in pixels from the top-left of a screenshot, whose pixels never affect a
 * comparison. A screen's effective masks are the app's (unless the screen opts out) plus its own.
 * Coordinates are integers and never scale: a mask keeps its pixel position when a screenshot's
 * size changes.
 */
import type { IMaskRect } from '@/openapi-client-generated';

export type { IMaskRect };

export const MAX_MASKS = 50;
export const MAX_MASK_LABEL_LENGTH = 80;
/** Mirrors the API's limit on x + width and y + height. */
export const MAX_MASK_EXTENT = 100_000;
/** A mask covering more than this share of a screenshot is called out: it may hide real changes. */
export const COVERAGE_WARNING_PCT = 50;

export type MaskField = 'x' | 'y' | 'width' | 'height';
export const MASK_FIELDS: { key: MaskField; label: string; min: number }[] = [
    { key: 'x', label: 'X', min: 0 },
    { key: 'y', label: 'Y', min: 0 },
    { key: 'width', label: 'W', min: 1 },
    { key: 'height', label: 'H', min: 1 }
];

export function newMaskId(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // insecure contexts (plain http on a LAN) have no randomUUID
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)
    );
}

export function cloneMasks(masks: readonly IMaskRect[] | null | undefined): IMaskRect[] {
    return (masks ?? []).map(m => ({ id: m.id, x: m.x, y: m.y, width: m.width, height: m.height, label: m.label ?? null }));
}

export function sameMasks(a: readonly IMaskRect[], b: readonly IMaskRect[]): boolean {
    return (
        a.length === b.length &&
        a.every((m, i) => {
            const o = b[i];
            return (
                m.id === o.id && m.x === o.x && m.y === o.y && m.width === o.width && m.height === o.height && (m.label ?? null) === (o.label ?? null)
            );
        })
    );
}

/** Whether the geometry is something the API accepts. Returns a message, or '' when valid. */
export function maskError(mask: IMaskRect): string {
    const ints = [mask.x, mask.y, mask.width, mask.height];
    if (!ints.every(Number.isSafeInteger)) return 'Use whole pixels';
    if (mask.x < 0 || mask.y < 0) return 'X and Y start at 0';
    if (mask.width < 1 || mask.height < 1) return 'Width and height are at least 1';
    if (mask.x + mask.width > MAX_MASK_EXTENT || mask.y + mask.height > MAX_MASK_EXTENT) return `Stay within ${MAX_MASK_EXTENT.toLocaleString()} px`;
    if ((mask.label?.length ?? 0) > MAX_MASK_LABEL_LENGTH) return `Labels are at most ${MAX_MASK_LABEL_LENGTH} characters`;
    return '';
}

export function listError(masks: readonly IMaskRect[]): string {
    if (masks.length > MAX_MASKS) return `At most ${MAX_MASKS} masks`;
    for (const mask of masks) {
        const error = maskError(mask);
        if (error) return error;
    }
    return '';
}

/** "Mask 2, x 40, y 12, 200 × 32 px", with the label when there is one. */
export function describeMask(mask: IMaskRect, index: number): string {
    const name = mask.label ? `Mask ${index + 1} (${mask.label})` : `Mask ${index + 1}`;
    return `${name}, x ${mask.x}, y ${mask.y}, ${mask.width} × ${mask.height} px`;
}

/** How a mask sits against a screenshot of the given size. */
export function maskBounds(mask: IMaskRect, width: number, height: number): 'inside' | 'partly' | 'outside' {
    const x1 = mask.x + mask.width;
    const y1 = mask.y + mask.height;
    if (mask.x >= width || mask.y >= height) return 'outside';
    return x1 > width || y1 > height ? 'partly' : 'inside';
}

/** Masks reaching past the screenshot are clipped by the comparison, so say so. */
export function outsideSummary(masks: readonly IMaskRect[], width: number, height: number): { partly: number; outside: number } {
    let partly = 0;
    let outside = 0;
    for (const mask of masks) {
        const bounds = maskBounds(mask, width, height);
        if (bounds === 'partly') partly++;
        else if (bounds === 'outside') outside++;
    }
    return { partly, outside };
}

/** The share, 0 to 100, of a width x height screenshot covered by the union of the masks. */
export function coveragePct(masks: readonly IMaskRect[], width: number, height: number): number {
    if (!masks.length || width <= 0 || height <= 0) return 0;
    const clipped = masks
        .map(m => ({ x0: Math.max(0, m.x), y0: Math.max(0, m.y), x1: Math.min(width, m.x + m.width), y1: Math.min(height, m.y + m.height) }))
        .filter(r => r.x1 > r.x0 && r.y1 > r.y0);
    if (!clipped.length) return 0;

    // union area by coordinate compression on x
    const xs = [...new Set(clipped.flatMap(r => [r.x0, r.x1]))].sort((a, b) => a - b);
    let area = 0;
    for (let i = 0; i < xs.length - 1; i++) {
        const left = xs[i];
        const right = xs[i + 1];
        const spans = clipped
            .filter(r => r.x0 <= left && r.x1 >= right)
            .map(r => [r.y0, r.y1] as const)
            .sort((a, b) => a[0] - b[0]);
        let covered = 0;
        let end = -Infinity;
        for (const [y0, y1] of spans) {
            if (y1 <= end) continue;
            covered += y1 - Math.max(y0, end);
            end = y1;
        }
        area += covered * (right - left);
    }
    return (area / (width * height)) * 100;
}

export function formatMaskCount(count: number): string {
    return `${count} ${count === 1 ? 'mask' : 'masks'}`;
}
