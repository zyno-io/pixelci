/**
 * Comparison tolerances. Each value can be set per screen, per app, or left to the instance
 * default; the most specific one that is set wins. A null override means "inherit".
 */
export interface ITolerances {
    colorTolerance: number;
    shiftTolerance: number;
    diffPctTolerance: number;
}

export type ToleranceKey = keyof ITolerances;
export type IToleranceOverrides = Record<ToleranceKey, number | null>;

export interface IToleranceField {
    key: ToleranceKey;
    label: string;
    hint: string;
    suffix?: string;
    min: number;
    max: number;
    step: number;
    integer?: boolean;
}

export const TOLERANCE_FIELDS: IToleranceField[] = [
    {
        key: 'colorTolerance',
        label: 'Color tolerance',
        hint: "How far a pixel's color may drift before it counts as changed. 0 is an exact match.",
        min: 0,
        max: 1,
        step: 0.05
    },
    {
        key: 'shiftTolerance',
        label: 'Shift tolerance',
        hint: 'Content that only moved by up to this many pixels is not counted.',
        suffix: 'px',
        min: 0,
        max: 5,
        step: 1,
        integer: true
    },
    {
        key: 'diffPctTolerance',
        label: 'Changed pixels allowed',
        hint: 'Share of the screenshot that may still differ before the screen is flagged.',
        suffix: '%',
        min: 0,
        max: 100,
        step: 0.01
    }
];

export const NO_OVERRIDES: IToleranceOverrides = { colorTolerance: null, shiftTolerance: null, diffPctTolerance: null };

export function pickOverrides(source: Partial<IToleranceOverrides> | null | undefined): IToleranceOverrides {
    return {
        colorTolerance: source?.colorTolerance ?? null,
        shiftTolerance: source?.shiftTolerance ?? null,
        diffPctTolerance: source?.diffPctTolerance ?? null
    };
}

/** The values a comparison would use: each override where set, otherwise the inherited value. */
export function resolveTolerances(overrides: Partial<IToleranceOverrides> | null | undefined, inherited: ITolerances): ITolerances {
    return {
        colorTolerance: overrides?.colorTolerance ?? inherited.colorTolerance,
        shiftTolerance: overrides?.shiftTolerance ?? inherited.shiftTolerance,
        diffPctTolerance: overrides?.diffPctTolerance ?? inherited.diffPctTolerance
    };
}

export function hasOverride(overrides: Partial<IToleranceOverrides> | null | undefined): boolean {
    return !!overrides && TOLERANCE_FIELDS.some(field => overrides[field.key] != null);
}

export function sameOverrides(a: IToleranceOverrides, b: IToleranceOverrides): boolean {
    return TOLERANCE_FIELDS.every(field => a[field.key] === b[field.key]);
}

/** Plain decimal, never exponent notation, with float noise trimmed (0.1 + 0.2 reads as 0.3). */
export function formatNumber(value: number): string {
    return String(Number(value.toFixed(6)));
}

export function formatTolerance(key: ToleranceKey, value: number): string {
    const field = TOLERANCE_FIELDS.find(f => f.key === key)!;
    const number = formatNumber(value);
    if (!field.suffix) return number;
    return field.suffix === '%' ? `${number}%` : `${number} ${field.suffix}`;
}

/** A measured percentage, with enough digits that a tiny diff doesn't read as zero. */
export function formatPct(value: number): string {
    if (value === 0) return '0%';
    if (value < 0.0001) return '<0.0001%';
    if (value < 0.01) return `${value.toFixed(4)}%`;
    if (value < 1) return `${value.toFixed(3)}%`;
    return `${value.toFixed(2)}%`;
}
