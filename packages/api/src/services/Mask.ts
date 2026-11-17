import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';
import { keyBy, uniq } from 'lodash';

import { UserEntity } from '../entities/User.entity';

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

/**
 * Throws HttpBadRequestError unless `masks` is a valid list: at most `max` (50), integer geometry within bounds, unique uuid ids,
 * short labels. The compare preview passes a higher `max` and `allowDuplicateIds`, as it carries the app's masks and the screen's
 * together and each list is saved (and so validated) on its own, so the two may legitimately share an id.
 */
export function validateMasks(masks: unknown, max = MAX_MASKS, opts: { allowDuplicateIds?: boolean } = {}): asserts masks is IMaskRect[] {
    if (!Array.isArray(masks)) throw new HttpBadRequestError('masks must be an array');
    if (masks.length > max) throw new HttpBadRequestError(`at most ${max} masks are allowed`);

    const ids = new Set<string>();
    for (const [i, mask] of masks.entries()) {
        const at = `masks[${i}]`;
        if (!mask || typeof mask !== 'object') throw new HttpBadRequestError(`${at} must be an object`);
        const { id, x, y, width, height, label } = mask as Record<string, unknown>;

        if (typeof id !== 'string' || !UUID_RE.test(id)) throw new HttpBadRequestError(`${at}.id must be a uuid`);
        if (!opts.allowDuplicateIds) {
            if (ids.has(id.toLowerCase())) throw new HttpBadRequestError(`${at}.id is a duplicate`);
            ids.add(id.toLowerCase());
        }

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
    for (const mask of masks) {
        const x0 = Math.max(0, mask.x);
        const y0 = Math.max(0, mask.y);
        const x1 = Math.min(width, mask.x + mask.width);
        const y1 = Math.min(height, mask.y + mask.height);
        if (x1 <= x0 || y1 <= y0) continue;

        bitmap ??= new Uint8Array(width * height);
        for (let y = y0; y < y1; y++) bitmap.fill(1, y * width + x0, y * width + x1);
    }
    if (!bitmap) return null;

    let maskedPixels = 0;
    for (let i = 0; i < bitmap.length; i++) maskedPixels += bitmap[i];
    return { bitmap, maskedPixels };
}

/** A screen's own masks, as the API returns them. */
export interface IScreenMasksResponse {
    masks: IMaskRect[];
    inheritAppMasks: boolean;
    version: number;
    updatedAt: Date | null;
    updatedByName: string | null;
}

/** An app's masks, as the API returns them. */
export interface IAppMasksResponse {
    masks: IMaskRect[];
    version: number;
    updatedAt: Date | null;
    updatedByName: string | null;
}

type IMaskOwner = { masks: IMaskRect[] | null; masksVersion: number; masksUpdatedAt: Date | null; masksUpdatedById: string | null };

export async function loadUserNames(ids: (string | null | undefined)[]): Promise<Record<string, string>> {
    const userIds = uniq(ids.filter((id): id is string => !!id));
    if (!userIds.length) return {};
    const users = await UserEntity.query()
        .filter({ id: { $in: userIds } })
        .select('id', 'name')
        .find();
    const byId = keyBy(users, 'id');
    return Object.fromEntries(userIds.map(id => [id, byId[id]?.name ?? '']).filter(([, name]) => name));
}

export function toScreenMasksResponse(screen: IMaskOwner & { inheritAppMasks: boolean }, names: Record<string, string>): IScreenMasksResponse {
    return {
        masks: screen.masks ?? [],
        inheritAppMasks: screen.inheritAppMasks,
        version: screen.masksVersion,
        updatedAt: screen.masksUpdatedAt,
        updatedByName: screen.masksUpdatedById ? (names[screen.masksUpdatedById] ?? null) : null
    };
}

export function toAppMasksResponse(app: IMaskOwner, names: Record<string, string>): IAppMasksResponse {
    return {
        masks: app.masks ?? [],
        version: app.masksVersion,
        updatedAt: app.masksUpdatedAt,
        updatedByName: app.masksUpdatedById ? (names[app.masksUpdatedById] ?? null) : null
    };
}
