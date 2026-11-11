import { ScopedLogger } from '@zyno-io/ts-server-foundation';
import { AnyResponse, BaseJob, WorkerJob } from '@zyno-io/ts-server-foundation';
import { keyBy } from 'lodash';

import { AppConfig } from '../config';
import { Db } from '../database';
import { AppEntity } from '../entities/App.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { claimBuildLease, Lease, LeaseLostError } from '../services/BuildProcessingLease';
import { PixelMatchService } from '../services/PixelMatch.service';
import { computeRemovals } from '../services/RemovedScreens';
import { S3Service } from '../services/S3.service';

interface IProcessBuildJobData {
    buildId: string;
}

// todo: on reference branch, find all approved versions of a screen not on the reference branch _after_ the lastest approved version for "what's been approved since" comparison
// we're probably going to have to track last changed build screen ID for each screen to know how to look forward

@WorkerJob()
export class ProcessBuildJob extends BaseJob<IProcessBuildJobData> {
    constructor(
        private logger: ScopedLogger,
        private appConfig: AppConfig,
        private db: Db,
        private s3Svc: S3Service,
        private pixelMatch: PixelMatchService
    ) {
        super();
    }

    async handle(data: IProcessBuildJobData): AnyResponse {
        const logger = this.logger.scoped(data.buildId);
        logger.info('Processing build', { id: data.buildId });

        const lease = await claimBuildLease(this.db, data.buildId, logger);
        if (!lease) {
            logger.info('Build is not claimable (not processing, already being processed, or out of attempts); skipping', { id: data.buildId });
            return;
        }
        lease.startHeartbeat();

        try {
            const work = this.processScreens(data.buildId, lease);
            work.catch(() => undefined); // if the race below is lost, the orphaned attempt's rejection is irrelevant
            await Promise.race([work, lease.lostSignal]);
        } catch (err) {
            if (err instanceof LeaseLostError) {
                logger.warn('Processing lease lost; abandoning attempt', { id: data.buildId });
                return;
            }
            logger.error('Build processing failed', err as Error);
            try {
                await lease.fail();
            } catch (failErr) {
                logger.error('Failed to mark build as failed', failErr as Error);
            }
            throw err;
        } finally {
            lease.stopHeartbeat();
        }
    }

    private async processScreens(buildId: string, lease: Lease): AnyResponse {
        const logger = this.logger.scoped(buildId);
        const diffThreshold = this.appConfig.DEFAULT_PIXEL_DIFF_PCT_THRESHOLD / 100;
        logger.info('Using diff threshold', { diffThreshold });

        const currentBuild = await BuildEntity.query().filter({ id: buildId }).findOne();

        const app = await AppEntity.query().filter({ id: currentBuild.appId }).findOne();
        const appId = app.id;

        const currentBuildScreens = await BuildScreenEntity.query().filter({ appId, buildId: currentBuild.id }).find();

        const isDefaultBranch = currentBuild.branchId === app.defaultBranchId;
        const previousBuild = isDefaultBranch
            ? undefined
            : await BuildEntity.query()
                  .filter({
                      appId,
                      branchId: currentBuild.branchId,
                      status: 'changes approved',
                      id: { $lt: currentBuild.id }
                  })
                  .orderBy('id', 'desc')
                  .findOneOrUndefined();
        const previousBuildScreens = previousBuild ? await BuildScreenEntity.query().filter({ appId, buildId: previousBuild.id }).find() : [];
        const previousBuildScreensById = keyBy(
            previousBuildScreens.filter(bs => !bs.isRemoved),
            'screenId'
        );
        const previousTombstonesById = keyBy(
            previousBuildScreens.filter(bs => bs.isRemoved),
            'screenId'
        );

        const referenceBuild = app.defaultBranchId
            ? await BuildEntity.query()
                  .filter({ appId, branchId: app.defaultBranchId, status: 'changes approved', id: { $lt: currentBuild.id } })
                  .orderBy('id', 'desc')
                  .findOneOrUndefined()
            : undefined;
        const referenceBuildScreens = referenceBuild
            ? await BuildScreenEntity.query().filter({ appId, buildId: referenceBuild.id, isRemoved: false }).find()
            : [];
        const referenceBuildScreensById = keyBy(referenceBuildScreens, 'screenId');

        if (previousBuild) logger.info('Found previous build', { id: previousBuild.id });
        else logger.info('No previous build found for branch');

        if (referenceBuild) logger.info('Found reference build', { id: referenceBuild.id });
        else logger.info('No reference build found');

        const screens = currentBuildScreens
            .filter(bs => !bs.isRemoved)
            .map(currentBuildScreen => ({
                screenId: currentBuildScreen.screenId,
                currentBuildScreen,
                previousBuildScreen: previousBuildScreensById[currentBuildScreen.screenId] as BuildScreenEntity | undefined,
                referenceBuildScreen: referenceBuildScreensById[currentBuildScreen.screenId] as BuildScreenEntity | undefined
            }));

        screenLoop: for (const screen of screens) {
            if (lease.lost) throw new LeaseLostError();
            // if the previous screen has approved changes, compare the current screen with the already approved changes.
            // if the current build's screen matches, then it's automatically approved too.
            if (screen.previousBuildScreen?.status === 'changes approved') {
                logger.info('Screen in previous build with approved changes', { screenId: screen.screenId });

                const isMatch = await this.performDiff(
                    appId,
                    screen.previousBuildScreen.matchedBuildId ?? screen.previousBuildScreen.buildId,
                    currentBuild.id,
                    screen.screenId,
                    diffThreshold
                );

                if (isMatch) {
                    logger.info('Current build screen matches approved changes', { screenId: screen.screenId });
                    screen.currentBuildScreen.matchedBuildId = screen.previousBuildScreen.matchedBuildId ?? screen.previousBuildScreen.buildId;
                    screen.currentBuildScreen.approvalBuildId = screen.previousBuildScreen.approvalBuildId ?? screen.previousBuildScreen.buildId;
                    screen.currentBuildScreen.status = 'changes approved';
                    continue;
                }

                logger.info('Current build screen does not match approved changes', { screenId: screen.screenId });
            }

            // if we have a reference build screen, compare the current screen with the reference build screen
            if (screen.referenceBuildScreen) {
                const isMatch = await this.performDiff(appId, screen.referenceBuildScreen.buildId, currentBuild.id, screen.screenId, diffThreshold);

                if (isMatch) {
                    logger.info('Current build screen matches reference', {
                        screenId: screen.screenId,
                        status: screen.currentBuildScreen.status
                    });
                    screen.currentBuildScreen.matchedBuildId = screen.referenceBuildScreen.matchedBuildId ?? screen.referenceBuildScreen.buildId;
                    screen.currentBuildScreen.status = 'no changes';
                    continue;
                }

                logger.info('Current build screen does not match reference', {
                    screenId: screen.screenId,
                    status: screen.currentBuildScreen.status
                });
            }

            // look for any approved changes to this screen on another branch since the build that last changed it
            // since the IDs are all uuid7, we know they're time-ordered, and therefore we temporally compare build IDs
            // and screen IDs even though they don't represent the same thing
            const approvalBuildIdForReferenceScreen = screen.referenceBuildScreen?.approvalBuildId ?? screen.referenceBuildScreen?.buildId;
            const approvedBuildScreensSinceApprovedReferenceBuild = await BuildScreenEntity.query()
                .filter({
                    ...(approvalBuildIdForReferenceScreen && { id: { $gt: approvalBuildIdForReferenceScreen } }),
                    appId,
                    screenId: screen.screenId,
                    isRemoved: false,
                    status: 'changes approved',
                    approvalBuildId: null // we want the explicitly approved changes, not the ones that inherited approval
                })
                .find();

            for (const approvedBuildScreen of approvedBuildScreensSinceApprovedReferenceBuild) {
                logger.info('Comparing against intermediate approved change for screen', {
                    screenId: screen.screenId,
                    buildId: approvedBuildScreen.buildId
                });

                const isMatch = await this.performDiff(
                    appId,
                    approvedBuildScreen.matchedBuildId ?? approvedBuildScreen.buildId,
                    currentBuild.id,
                    screen.screenId,
                    diffThreshold
                );

                if (isMatch) {
                    logger.info('Current build screen matches previously approved changes', {
                        screenId: screen.screenId
                    });
                    screen.currentBuildScreen.matchedBuildId = approvedBuildScreen.matchedBuildId ?? approvedBuildScreen.buildId;
                    screen.currentBuildScreen.approvalBuildId = approvedBuildScreen.buildId;
                    screen.currentBuildScreen.status = 'changes approved';
                    continue screenLoop;
                }
            }

            // if the screen is not in the reference build, mark it as new
            if (!screen.referenceBuildScreen) {
                logger.info('Screen not in reference build', { screenId: screen.screenId });
                screen.currentBuildScreen.status = 'new';
                continue;
            }

            // no matches for this screen change, so mark it as needs review
            logger.info('Current build screen needs review', {
                screenId: screen.screenId,
                status: screen.currentBuildScreen.status
            });
            screen.currentBuildScreen.status = 'needs review';
        }

        // carry forward prior per-screen review decisions: when a same-named screen was individually
        // approved/rejected since this branch's last approval and the current image still matches it,
        // re-apply that decision (and comment) so reviewers don't re-review unchanged screens build after build.
        // NOTE: the lower bound is this branch's last approval, but candidates are matched app-wide (across
        // branches) by screenId, since builds_screens has no branchId. Carry-forward only fires on an exact
        // pixel match, so a cross-branch decision is only inherited when the screen is visually identical.
        const reviewWindowLowerBoundId = previousBuild?.id ?? referenceBuild?.id;

        for (const screen of screens) {
            if (screen.currentBuildScreen.status !== 'needs review' && screen.currentBuildScreen.status !== 'new') continue;

            const priorReviewedScreens = await BuildScreenEntity.query()
                .filter({
                    appId,
                    screenId: screen.screenId,
                    isRemoved: false,
                    reviewStatus: { $ne: null },
                    buildId: { $ne: currentBuild.id },
                    ...(reviewWindowLowerBoundId && { id: { $gt: reviewWindowLowerBoundId } })
                })
                .orderBy('id', 'desc')
                .find();

            for (const priorReviewedScreen of priorReviewedScreens) {
                let isMatch: boolean;
                try {
                    isMatch = await this.screensMatch(
                        appId,
                        priorReviewedScreen.matchedBuildId ?? priorReviewedScreen.buildId,
                        currentBuild.id,
                        screen.screenId,
                        diffThreshold
                    );
                } catch (err) {
                    logger.info('Failed to compare against prior reviewed screen; skipping candidate', {
                        screenId: screen.screenId,
                        priorBuildId: priorReviewedScreen.buildId,
                        error: (err as Error).message
                    });
                    continue;
                }

                if (!isMatch) continue;

                logger.info('Carrying forward prior review decision for unchanged screen', {
                    screenId: screen.screenId,
                    reviewStatus: priorReviewedScreen.reviewStatus,
                    fromBuildId: priorReviewedScreen.buildId
                });
                screen.currentBuildScreen.reviewStatus = priorReviewedScreen.reviewStatus;
                screen.currentBuildScreen.reviewComment = priorReviewedScreen.reviewComment;
                screen.currentBuildScreen.reviewedById = priorReviewedScreen.reviewedById;
                screen.currentBuildScreen.reviewedAt = priorReviewedScreen.reviewedAt;
                break;
            }
        }

        // screens in the reference build that this build no longer has get a tombstone (needs review until approved)
        const tombstones = await computeRemovals({
            appId,
            buildId: currentBuild.id,
            currentScreenIds: screens.map(screen => screen.screenId),
            referenceRows: referenceBuildScreens,
            previousTombstonesById
        });
        const statuses = [...screens.map(screen => screen.currentBuildScreen.status), ...tombstones.map(tombstone => tombstone.status)];

        // there no no changes if all screens are accounted for and have no changes
        if (statuses.every(status => status === 'no changes')) {
            currentBuild.status = 'no changes';

            // all changes are approved if the current build screen either has no changes or the changes are previously approved
        } else if (statuses.every(status => status === 'no changes' || status === 'changes approved')) {
            currentBuild.status = 'changes approved';
        }

        // otherwise, something needs review
        else {
            currentBuild.status = 'needs review';
        }

        logger.info('Updating build status', { status: currentBuild.status });

        if (lease.lost) throw new LeaseLostError();

        await this.db.transaction(async txn => {
            // Write the result through the locked row only, and only while this attempt still owns the build.
            const locked = await lease.assertHeld(txn);
            locked.status = currentBuild.status;
            locked.processingAttemptId = null;
            locked.processingHeartbeatAt = null;
            txn.add(locked);
            txn.add(...currentBuildScreens);
            await txn.flush();
            // replace any tombstones from an earlier processing run of this build
            await txn.query(BuildScreenEntity).filter({ buildId: currentBuild.id, isRemoved: true }).deleteMany();
            txn.add(...tombstones);
            await txn.flush();
            await txn
                .query(BuildScreenEntity)
                .filter({ buildId: currentBuild.id, matchedBuildId: { $ne: null } })
                .patchMany({
                    storageStatus: 'pendingDeletion'
                });
        });
    }

    private async loadAndDiff(appId: string, leftBuildId: string, rightBuildId: string, screenId: string) {
        const leftScreenData = await this.s3Svc.getBuffer(this.s3Svc.getPathForScreen(appId, leftBuildId, screenId));
        const rightScreenData = await this.s3Svc.getBuffer(this.s3Svc.getPathForScreen(appId, rightBuildId, screenId));
        return this.pixelMatch.getDiff(leftScreenData, rightScreenData, this.appConfig.DEFAULT_PIXEL_MATCH_THRESHOLD);
    }

    private async performDiff(appId: string, leftBuildId: string, rightBuildId: string, screenId: string, diffThreshold: number) {
        this.logger.info('Performing diff', { leftBuildId, rightBuildId, screenId });

        const { getDiffPng, diffPct } = await this.loadAndDiff(appId, leftBuildId, rightBuildId, screenId);

        if (diffPct > diffThreshold) {
            this.logger.info('Diff exceeds threshold. Storing diff.', { diffPct, diffThreshold });
            const diffBuf = getDiffPng();
            await this.s3Svc.uploadFile(diffBuf, this.s3Svc.getPathForDiff(appId, rightBuildId, screenId), 'image/png');
            return false;
        }

        return true;
    }

    // like performDiff, but only reports whether two screens match without storing a diff image,
    // so it can be used for speculative comparisons without clobbering the stored reference diff
    private async screensMatch(appId: string, leftBuildId: string, rightBuildId: string, screenId: string, diffThreshold: number) {
        const { diffPct } = await this.loadAndDiff(appId, leftBuildId, rightBuildId, screenId);
        return diffPct <= diffThreshold;
    }
}
