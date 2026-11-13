import { AppError } from './error.js';

export interface IShard {
    index: number;
    total: number;
}

export const DEFAULT_TIMEOUT_MINUTES = 15;
export const MAX_SHARDS = 64;

type Env = Record<string, string | undefined>;

export function parseTimeoutMs(env: Env = process.env): number {
    const raw = env.PIXELCI_TIMEOUT_MINUTES?.trim();
    if (!raw) return DEFAULT_TIMEOUT_MINUTES * 60_000;
    const mins = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(mins) || mins < 1 || mins > 120) {
        throw new AppError(`Invalid PIXELCI_TIMEOUT_MINUTES "${raw}": expected a number between 1 and 120`);
    }
    return Math.round(mins * 60_000);
}

export function parseShard(env: Env = process.env): IShard | undefined {
    const raw = env.PIXELCI_SHARD?.trim();
    if (!raw) return undefined;
    const m = /^(\d+)\/(\d+)$/.exec(raw);
    const index = m ? Number(m[1]) : NaN;
    const total = m ? Number(m[2]) : NaN;
    if (!m || index < 1 || total > MAX_SHARDS || index > total) {
        throw new AppError(`Invalid PIXELCI_SHARD "${raw}": expected <index>/<total> (1-based, 1 <= index <= total <= ${MAX_SHARDS}), e.g. 2/4`);
    }
    return { index, total };
}

/** Returns a warning when the CI looks parallelised but PIXELCI_SHARD isn't set. */
export function shardWarning(env: Env = process.env): string | undefined {
    if (env.PIXELCI_SHARD?.trim()) return undefined;
    const nodeTotal = Number(env.CI_NODE_TOTAL);
    if (Number.isFinite(nodeTotal) && nodeTotal > 1) {
        return `CI_NODE_TOTAL is ${nodeTotal} but PIXELCI_SHARD is not set. If each job uploads a different part of the suite, set PIXELCI_SHARD=<index>/<total> (e.g. $CI_NODE_INDEX/$CI_NODE_TOTAL); otherwise the jobs' screenshots will conflict.`;
    }
    return undefined;
}
