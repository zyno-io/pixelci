import { AnyResponse, BaseJob, ScopedLogger, WorkerJob, WorkerService } from '@zyno-io/ts-server-foundation';

import { AppEntity } from '../entities/App.entity';
import { BuildEntity } from '../entities/Build.entity';
import { UserEntity } from '../entities/User.entity';
import { VcsService } from '../services/Vcs.service';

export interface IRerunCiJobJobData {
    buildId: string;
    userId: string;
    /** The build's ciJobId when the re-run was requested; a different value means the build was superseded. */
    ciJobId: string;
    /** The run's attempt number when the re-run was deferred; a different current value means someone already re-ran it. */
    runAttempt?: number;
    attempt: number;
}

export const RERUN_RETRY_DELAY_MS = 60_000;
/** ~6 hours at one attempt per minute. */
export const RERUN_MAX_ATTEMPTS = 360;
export const RERUN_DEFERRED_NOTICE =
    "The workflow is still running. PixelCI will re-run the job automatically when it finishes. If it hasn't re-run a few minutes after that, re-run it from GitHub.";

/**
 * Re-runs a build's CI job once its workflow run has finished (GitHub refuses re-runs while a run is in progress).
 * Never throws for expected outcomes, so the framework doesn't retry it.
 */
@WorkerJob()
export class RerunCiJobJob extends BaseJob<IRerunCiJobJobData> {
    constructor(
        private logger: ScopedLogger,
        private vcsSvc: VcsService,
        private workerSvc: WorkerService
    ) {
        super();
    }

    async handle(data: IRerunCiJobJobData): AnyResponse {
        const logger = this.logger.scoped(data.buildId);
        try {
            const build = await BuildEntity.query().filter({ id: data.buildId }).findOneOrUndefined();
            if (!build || build.status !== 'changes approved' || build.ciJobId !== data.ciJobId) {
                logger.info('Skipping deferred CI re-run: build changed', { id: data.buildId });
                return;
            }

            const user = await UserEntity.query().filter({ id: data.userId }).findOneOrUndefined();
            const app = await AppEntity.query().filter({ id: build.appId }).findOneOrUndefined();
            if (!user || !app || app.deletedAt) {
                logger.info('Skipping deferred CI re-run: user or app is gone', { id: data.buildId });
                return;
            }

            // The provider refreshes the user's VCS session as needed (ensureFreshVcsSession).
            const result = await this.vcsSvc.rerunCiJob(user, app, data.ciJobId, { expectedRunAttempt: data.runAttempt });
            if (result.ok) {
                logger.info('Re-ran CI job after workflow finished', { id: data.buildId, attempt: data.attempt, url: result.url });
            } else if (result.superseded) {
                logger.info('Skipping deferred CI re-run: workflow was already re-run', { id: data.buildId, attempt: data.attempt });
            } else if (result.deferred || result.retryable) {
                if (data.attempt >= RERUN_MAX_ATTEMPTS) {
                    logger.warn('Giving up deferred CI re-run after max attempts', { id: data.buildId, attempt: data.attempt, error: result.error });
                    return;
                }
                await this.workerSvc.queueJob(RerunCiJobJob, { ...data, attempt: data.attempt + 1 }, { delay: RERUN_RETRY_DELAY_MS });
            } else {
                logger.warn('Deferred CI re-run failed', { id: data.buildId, attempt: data.attempt, error: result.error });
            }
        } catch (err) {
            logger.warn('Deferred CI re-run errored', { id: data.buildId, error: String(err) });
        }
    }
}
