import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';

/** A rectangle, in pixels from the top-left of a screenshot, whose pixels never affect a comparison. */
export interface IMaskRect {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label: string | null;
}

export const MAX_MASKS = 50;
export const MAX_MASK_EXTENT = 100_000;
export const MAX_MASK_LABEL_LENGTH = 80;

/** Painted into both images under a mask, so the comparison sees identical, opaque content there. */
export const MASK_FILL = [128, 128, 128, 255] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Throws HttpBadRequestError unless `masks` is a valid list: at most 50, integer geometry within bounds, unique uuid ids, short labels. */
export function validateMasks(masks: unknown): asserts masks is IMaskRect[] {
    if (!Array.isArray(masks)) throw new HttpBadRequestError('masks must be an array');
    if (masks.length > MAX_MASKS) throw new HttpBadRequestError(`at most ${MAX_MASKS} masks are allowed`);

    const ids = new Set<string>();
    for (const [i, mask] of masks.entries()) {
        const at = `masks[${i}]`;
        if (!mask || typeof mask !== 'object') throw new HttpBadRequestError(`${at} must be an object`);
        const { id, x, y, width, height, label } = mask as Record<string, unknown>;

        if (typeof id !== 'string' || !UUID_RE.test(id)) throw new HttpBadRequestError(`${at}.id must be a uuid`);
        if (ids.has(id.toLowerCase())) throw new HttpBadRequestError(`${at}.id is a duplicate`);
        ids.add(id.toLowerCase());

        if (!isInt(x) || x < 0) throw new HttpBadRequestError(`${at}.x must be an integer >= 0`);
        if (!isInt(y) || y < 0) throw new HttpBadRequestError(`${at}.y must be an integer >= 0`);
        if (!isInt(width) || width < 1) throw new HttpBadRequestError(`${at}.width must be an integer >= 1`);
        if (!isInt(height) || height < 1) throw new HttpBadRequestError(`${at}.height must be an integer >= 1`);
        if (x + width > MAX_MASK_EXTENT) throw new HttpBadRequestError(`${at} extends past ${MAX_MASK_EXTENT} px horizontally`);
        if (y + height > MAX_MASK_EXTENT) throw new HttpBadRequestError(`${at} extends past ${MAX_MASK_EXTENT} px vertically`);

        if (label !== null && label !== undefined) {
            if (typeof label !== 'string') throw new HttpBadRequestError(`${at}.label must be a string or null`);
            if (label.length > MAX_MASK_LABEL_LENGTH)
                throw new HttpBadRequestError(`${at}.label must be at most ${MAX_MASK_LABEL_LENGTH} characters`);
        }
    }
}

/** Keeps only the known fields and normalises a missing label to null, so stored masks never carry extras. */
export function normalizeMasks(masks: IMaskRect[]): IMaskRect[] {
    return masks.map(m => ({ id: m.id, x: m.x, y: m.y, width: m.width, height: m.height, label: m.label ?? null }));
}

/** The masks in effect for a screen: the app's (unless the screen opts out), then the screen's own. */
export function resolveMasks(
    app: { masks: IMaskRect[] | null },
    screen?: { masks: IMaskRect[] | null; inheritAppMasks: boolean } | null
): IMaskRect[] {
    const inherit = screen?.inheritAppMasks ?? true;
    return [...(inherit ? (app.masks ?? []) : []), ...(screen?.masks ?? [])];
}

export interface IMaskRaster {
    /** One byte per pixel, row-major: 1 under a mask. */
    bitmap: Uint8Array;
    /** Distinct masked pixels; overlapping masks count once. */
    maskedPixels: number;
}

/**
 * Rasterises masks onto a `width` x `height` canvas, clipping to it. Returns null when no pixel is masked,
 * so callers allocate nothing and take the unmasked path.
 */
export function rasterizeMasks(masks: readonly IMaskRect[], width: number, height: number): IMaskRaster | null {
    if (!masks.length) return null;

    let bitmap: Uint8Array | undefined;
    let maskedPixels = 0;
    for (const mask of masks) {
        const x0 = Math.max(0, mask.x);
        const y0 = Math.max(0, mask.y);
        const x1 = Math.min(width, mask.x + mask.width);
        const y1 = Math.min(height, mask.y + mask.height);
        if (x1 <= x0 || y1 <= y0) continue;

        bitmap ??= new Uint8Array(width * height);
        for (let y = y0; y < y1; y++) {
            const row = y * width;
            for (let x = x0; x < x1; x++) {
                if (!bitmap[row + x]) {
                    bitmap[row + x] = 1;
                    maskedPixels++;
                }
            }
        }
    }
    return bitmap ? { bitmap, maskedPixels } : null;
}
