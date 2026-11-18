import type { AppConfig } from '../../config';

export type StorageGcMode = 'off' | 'dry-run' | 'delete';

export interface IStorageGcSettings {
    mode: StorageGcMode;
    graceMs: number;
    sweepIntervalMs: number;
    maxRunMs: number;
    deleteUnknownApps: boolean;
    purgeAfterDays: number;
    warnings: string[];
}

const HOUR_MS = 3_600_000;
const MIN_GRACE_HOURS = 6;

type IStorageGcConfig = Pick<
    AppConfig,
    | 'STORAGE_GC_MODE'
    | 'STORAGE_GC_GRACE_HOURS'
    | 'STORAGE_GC_SWEEP_INTERVAL_HOURS'
    | 'STORAGE_GC_MAX_RUN_MINUTES'
    | 'STORAGE_GC_DELETE_UNKNOWN_APPS'
    | 'APP_PURGE_AFTER_DAYS'
>;

/**
 * Reads the storage cleanup settings. Never throws: an unusable value falls back to its default (or its limit) and is reported in
 * `warnings`. An unrecognised mode becomes 'dry-run', never 'delete'.
 */
export function resolveStorageGcSettings(config: IStorageGcConfig): IStorageGcSettings {
    const warnings: string[] = [];

    const rawMode = String(config.STORAGE_GC_MODE ?? '')
        .trim()
        .toLowerCase();
    let mode: StorageGcMode;
    if (rawMode === 'off' || rawMode === 'dry-run' || rawMode === 'delete') {
        mode = rawMode;
    } else {
        mode = 'dry-run';
        warnings.push(`STORAGE_GC_MODE "${config.STORAGE_GC_MODE}" is not off, dry-run or delete; using dry-run`);
    }

    const num = (name: string, value: unknown, fallback: number, min: number): number => {
        const n = typeof value === 'number' ? value : Number(value);
        if (value === undefined || value === null || value === '' || !Number.isFinite(n)) {
            warnings.push(`${name} "${String(value)}" is not a number; using ${fallback}`);
            return fallback;
        }
        if (n < min) {
            warnings.push(`${name} ${n} is below the minimum; using ${min}`);
            return min;
        }
        return n;
    };

    const graceHours = num('STORAGE_GC_GRACE_HOURS', config.STORAGE_GC_GRACE_HOURS, 24, MIN_GRACE_HOURS);
    const sweepHours = num('STORAGE_GC_SWEEP_INTERVAL_HOURS', config.STORAGE_GC_SWEEP_INTERVAL_HOURS, 24, 1);
    const maxRunMinutes = num('STORAGE_GC_MAX_RUN_MINUTES', config.STORAGE_GC_MAX_RUN_MINUTES, 10, 1);
    // A negative value must not read as "purge now": it is not clamped to 0 but replaced by the default.
    let purgeAfterDays = num('APP_PURGE_AFTER_DAYS', config.APP_PURGE_AFTER_DAYS, 30, -Infinity);
    if (purgeAfterDays < 0) {
        warnings.push(`APP_PURGE_AFTER_DAYS ${purgeAfterDays} is negative; using 30`);
        purgeAfterDays = 30;
    }

    return {
        mode,
        graceMs: graceHours * HOUR_MS,
        sweepIntervalMs: sweepHours * HOUR_MS,
        maxRunMs: maxRunMinutes * 60_000,
        deleteUnknownApps: config.STORAGE_GC_DELETE_UNKNOWN_APPS === true,
        purgeAfterDays,
        warnings
    };
}
