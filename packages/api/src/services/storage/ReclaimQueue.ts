import { ScopedLogger, WorkerService } from '@zyno-io/ts-server-foundation';

import type { AppConfig } from '../../config';

import { ReclaimBuildStorageJob } from '../../jobs/ReclaimBuildStorage.job';
import { resolveStorageGcSettings } from './StorageGcSettings';

/**
 * Asks for a build's storage to be reclaimed once the grace period has passed. Best effort: it is only a shortcut for the hourly
 * sweep, so a failure to queue is logged and never fails the request or job that called it. Call after the transaction commits.
 */
export async function queueBuildReclaims(
    workerSvc: WorkerService,
    config: AppConfig,
    logger: ScopedLogger,
    appId: string,
    buildIds: Iterable<string>
): Promise<void> {
    const ids = [...new Set(buildIds)];
    if (!ids.length) return;
    try {
        const settings = resolveStorageGcSettings(config);
        if (settings.mode === 'off') return;
        for (const buildId of ids) {
            await workerSvc.queueJob(ReclaimBuildStorageJob, { appId, buildId }, { delay: settings.graceMs });
        }
    } catch (err) {
        logger.warn('Could not queue build storage reclaim', { appId, buildIds: ids, error: String((err as Error)?.message ?? err) });
    }
}
