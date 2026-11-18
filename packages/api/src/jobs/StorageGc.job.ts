import { BaseJob, ScopedLogger, WorkerJob } from '@zyno-io/ts-server-foundation';

import { createGcContext, StorageGcService } from '../services/storage/StorageGc.service';

/**
 * Hourly: removes S3 objects nothing references any more, purges long-deleted apps and reports unknown app prefixes.
 * What it does is set by STORAGE_GC_MODE (off, dry-run, delete); each run stops at STORAGE_GC_MAX_RUN_MINUTES and resumes next time.
 */
// Own queue: `maintenance` runs one job at a time, and a long cleanup must not hold up the stuck-build reaper.
@WorkerJob({ cronSchedule: '23 * * * *', queueName: 'storage' })
export class StorageGcJob extends BaseJob<void> {
    constructor(
        private gc: StorageGcService,
        private logger: ScopedLogger
    ) {
        super();
    }

    async handle() {
        const settings = this.gc.getSettings();
        if (settings.mode === 'off') return;
        const ran = await this.gc.withLock(async () => {
            await this.gc.run(createGcContext(settings));
        });
        if (!ran) this.logger.info('Storage cleanup skipped: another run holds the lock');
    }
}
