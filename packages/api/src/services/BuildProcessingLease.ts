import { DatabaseSession, ScopedLogger, uuid7 } from '@zyno-io/ts-server-foundation';

import { Db } from '../database';
import { BuildEntity } from '../entities/Build.entity';

/** Heartbeat period of a running attempt. */
export const HEARTBEAT_MS = 15_000;
/** A lease whose last heartbeat is older than this is considered dead. */
export const LEASE_MS = 120_000;
/** A build may be claimed at most this many times before it is failed. */
export const MAX_ATTEMPTS = 3;
/** Hard cap on total time in `processing`, regardless of heartbeats (guards against a hung await that keeps heartbeating). */
export const MAX_PROCESSING_MS = 60 * 60 * 1000;

export class LeaseLostError extends Error {
    constructor() {
        super('Build processing lease was lost');
        this.name = 'LeaseLostError';
    }
}

/**
 * A claim on processing one build. The DB row is the mutex (safe across pods and through PgBouncer); the attempt id fences
 * every write the holder makes. No transaction is ever held across the actual work.
 */
export class Lease {
    /** Set once a heartbeat finds the lease revoked. */
    lost = false;
    private timer?: NodeJS.Timeout;

    constructor(
        readonly buildId: string,
        readonly attemptId: string,
        private readonly logger: ScopedLogger
    ) {}

    startHeartbeat() {
        this.timer = setInterval(() => void this.beat(), HEARTBEAT_MS);
        this.timer.unref();
    }

    stopHeartbeat() {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private async beat() {
        try {
            const res = await BuildEntity.query()
                .filter({ id: this.buildId, status: 'processing', processingAttemptId: this.attemptId })
                .patchOne({ processingHeartbeatAt: new Date() });
            if (res.affectedRows === 0) {
                this.lost = true;
                this.logger.warn('Processing lease lost', { buildId: this.buildId, attemptId: this.attemptId });
            }
        } catch (err) {
            // A transient DB error must not abort the attempt; if it persists the lease goes stale and is handed off.
            this.logger.error('Processing heartbeat failed', err as Error);
        }
    }

    /** Re-checks ownership under a row lock inside the caller's transaction and returns the locked row. */
    async assertHeld(txn: DatabaseSession): Promise<BuildEntity> {
        const locked = await txn.query(BuildEntity).filter({ id: this.buildId }).forUpdate().findOneOrUndefined();
        if (!locked || locked.status !== 'processing' || locked.processingAttemptId !== this.attemptId) throw new LeaseLostError();
        return locked;
    }

    /** Marks the build failed if (and only if) this attempt still owns it. */
    async fail() {
        await BuildEntity.query()
            .filter({ id: this.buildId, status: 'processing', processingAttemptId: this.attemptId })
            .patchOne({ status: 'failed', processingAttemptId: null, processingHeartbeatAt: null });
    }
}

/** Claims the build for processing, or returns undefined if it isn't claimable (not processing, live lease, or out of attempts). */
export async function claimBuildLease(db: Db, buildId: string, logger: ScopedLogger): Promise<Lease | undefined> {
    return db.transaction(async txn => {
        const build = await txn.query(BuildEntity).filter({ id: buildId }).forUpdate().findOneOrUndefined();
        if (!build || build.status !== 'processing') return undefined;

        const now = Date.now();
        const live =
            build.processingAttemptId !== null && build.processingHeartbeatAt !== null && build.processingHeartbeatAt.getTime() > now - LEASE_MS;
        if (live) return undefined;

        if (build.processingAttempts >= MAX_ATTEMPTS) {
            build.status = 'failed';
            build.processingAttemptId = null;
            build.processingHeartbeatAt = null;
            txn.add(build);
            logger.error('Build exceeded max processing attempts', { buildId, attempts: build.processingAttempts });
            return undefined;
        }

        const attemptId = uuid7();
        build.processingAttemptId = attemptId;
        build.processingHeartbeatAt = new Date(now);
        build.processingAttempts += 1;
        txn.add(build);
        return new Lease(buildId, attemptId, logger);
    });
}
