import { HttpBadRequestError } from '@zyno-io/ts-server-foundation';

import { AppConfig } from '../config';

export interface ITolerances {
    /** Per-pixel colour tolerance passed to pixelmatch (0..1). */
    colorTolerance: number;
    /** Radius in px within which shifted content is not counted as a diff (integer 0..5). */
    shiftTolerance: number;
    /** True percentage (0..100) of differing pixels above which a screen is flagged. */
    diffPctTolerance: number;
}

export type IToleranceOverrides = { colorTolerance: number | null; shiftTolerance: number | null; diffPctTolerance: number | null };

export function instanceTolerances(config: AppConfig): ITolerances {
    return {
        colorTolerance: config.DEFAULT_PIXEL_MATCH_THRESHOLD,
        shiftTolerance: config.DEFAULT_PIXEL_SHIFT_TOLERANCE,
        diffPctTolerance: config.DEFAULT_PIXEL_DIFF_PCT_THRESHOLD
    };
}

/** Field-wise: screen override, then app override, then instance config. */
export function resolveTolerances(config: AppConfig, app: IToleranceOverrides, screen?: IToleranceOverrides | null): ITolerances {
    const base = instanceTolerances(config);
    return {
        colorTolerance: screen?.colorTolerance ?? app.colorTolerance ?? base.colorTolerance,
        shiftTolerance: screen?.shiftTolerance ?? app.shiftTolerance ?? base.shiftTolerance,
        diffPctTolerance: screen?.diffPctTolerance ?? app.diffPctTolerance ?? base.diffPctTolerance
    };
}

function isFiniteInRange(v: unknown, min: number, max: number): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** null/undefined mean "inherit" and are allowed. */
export function validateToleranceOverrides(input: Partial<IToleranceOverrides>): void {
    const { colorTolerance, shiftTolerance, diffPctTolerance } = input ?? {};
    if (colorTolerance != null && !isFiniteInRange(colorTolerance, 0, 1)) {
        throw new HttpBadRequestError('colorTolerance must be a number between 0 and 1');
    }
    if (shiftTolerance != null && !(isFiniteInRange(shiftTolerance, 0, 5) && Number.isInteger(shiftTolerance))) {
        throw new HttpBadRequestError('shiftTolerance must be an integer between 0 and 5');
    }
    if (diffPctTolerance != null && !isFiniteInRange(diffPctTolerance, 0, 100)) {
        throw new HttpBadRequestError('diffPctTolerance must be a number between 0 and 100');
    }
}

/** Like validateToleranceOverrides, but all three values are required (no nulls). */
export function validateTolerances(input: Partial<ITolerances>): asserts input is ITolerances {
    for (const key of ['colorTolerance', 'shiftTolerance', 'diffPctTolerance'] as const) {
        if (input?.[key] == null) throw new HttpBadRequestError(`${key} is required`);
    }
    validateToleranceOverrides(input);
}
