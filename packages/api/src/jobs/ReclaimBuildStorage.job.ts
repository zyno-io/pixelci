import { BaseJob, ScopedLogger, WorkerJob } from '@zyno-io/ts-server-foundation';

import { createGcContext, StorageGcService } from '../services/storage/StorageGc.service';

interface IReclaimBuildStorageData {
    appId: string;
    buildId: string;
}

/**
 * Queued (after the grace period) when a build has just stopped needing some of its uploads: a processed build whose rows now
 * point at another build's images, or a build whose rows were dropped by a takeover. A best-effort shortcut for the hourly sweep,
 * which would find the same objects eventually.
 */
@WorkerJob({ queueName: 'storage' })
export class ReclaimBuildStorageJob extends BaseJob<IReclaimBuildStorageData> {
    constructor(
        private gc: StorageGcService,
        private logger: ScopedLogger
    ) {
        super();
    }

    async handle({ appId, buildId }: IReclaimBuildStorageData) {
        const settings = this.gc.getSettings();
        if (settings.mode === 'off') return;
        const ctx = createGcContext(settings);
        const ran = await this.gc.withLock(async () => {
            await this.gc.reclaimBuild(appId, buildId, undefined, ctx);
            this.logger.info('Build storage reclaimed', { appId, buildId, mode: ctx.mode, ...ctx.stats });
        });
        if (!ran) this.logger.info('Build storage reclaim skipped: another cleanup holds the lock', { buildId });
    }
}
