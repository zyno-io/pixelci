import { BaseJob, ScopedLogger, WorkerJob, WorkerService } from '@zyno-io/ts-server-foundation';

import { BuildEntity } from '../entities/Build.entity';
import { LEASE_MS, MAX_ATTEMPTS, MAX_PROCESSING_MS } from '../services/BuildProcessingLease';
import { ProcessBuildJob } from './ProcessBuild.job';

/**
 * Cluster-wide, once a minute: fails builds that exceeded the processing cap or attempt limit, and re-enqueues builds whose
 * processing attempt died (or whose enqueue was lost). Every state change is a single-row compare-and-set (patchOne).
 */
// Own queue: the default queue's worker runs one job at a time, so a hung ProcessBuildJob must not be able to starve the reaper.
@WorkerJob({ cronSchedule: '* * * * *', queueName: 'maintenance' })
export class ReapStuckBuildsJob extends BaseJob<void> {
    constructor(
        private logger: ScopedLogger,
        private workerSvc: WorkerService
    ) {
        super();
    }

    async handle() {
        // Rows without processingStartedAt (never entered processing through the API) are ignored.
        const builds = await BuildEntity.query()
            .filter({ status: 'processing', processingStartedAt: { $ne: null } })
            .find();

        const now = Date.now();
        const hardCutoff = new Date(now - MAX_PROCESSING_MS);
        const staleCutoff = new Date(now - LEASE_MS);

        for (const build of builds) {
            try {
                await this.reap(build, hardCutoff, staleCutoff);
            } catch (err) {
                this.logger.error('Failed to reap build', err as Error, { buildId: build.id });
            }
        }
    }

    private async reap(build: BuildEntity, hardCutoff: Date, staleCutoff: Date) {
        const failPatch = { status: 'failed' as const, processingAttemptId: null, processingHeartbeatAt: null };

        if (build.processingStartedAt && build.processingStartedAt < hardCutoff) {
            const res = await BuildEntity.query()
                .filter({ id: build.id, status: 'processing', processingStartedAt: { $lt: hardCutoff } })
                .patchOne(failPatch);
            if (res.affectedRows) this.logger.error('Build exceeded max processing time; failed', { buildId: build.id });
            return;
        }

        const stale = build.processingHeartbeatAt === null || build.processingHeartbeatAt < staleCutoff;
        if (!stale) return;

        if (build.processingAttempts >= MAX_ATTEMPTS) {
            const res = await BuildEntity.query()
                .filter({
                    id: build.id,
                    status: 'processing',
                    processingAttempts: { $gte: MAX_ATTEMPTS },
                    processingHeartbeatAt: build.processingHeartbeatAt === null ? null : { $lt: staleCutoff }
                })
                .patchOne(failPatch);
            if (res.affectedRows)
                this.logger.error('Build exhausted processing attempts; failed', { buildId: build.id, attempts: build.processingAttempts });
            return;
        }

        // Clearing the attempt id revokes the dead (or blocked) attempt: its heartbeat and final write are fenced out.
        const res = await BuildEntity.query()
            .filter({
                id: build.id,
                status: 'processing',
                processingAttempts: { $lt: MAX_ATTEMPTS },
                processingHeartbeatAt: build.processingHeartbeatAt === null ? null : { $lt: staleCutoff }
            })
            .patchOne({ processingHeartbeatAt: new Date(), processingAttemptId: null });
        if (res.affectedRows) {
            this.logger.warn('Re-enqueueing build with stale processing lease', { buildId: build.id, attempts: build.processingAttempts });
            await this.workerSvc.queueJob(ProcessBuildJob, { buildId: build.id });
        }
    }
}
