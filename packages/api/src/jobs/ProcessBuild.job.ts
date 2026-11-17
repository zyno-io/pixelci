import { ScopedLogger } from '@zyno-io/ts-server-foundation';
import { AnyResponse, BaseJob, WorkerJob } from '@zyno-io/ts-server-foundation';
import { createHash } from 'crypto';
import { keyBy } from 'lodash';

import { AppConfig } from '../config';
import { Db } from '../database';
import { AppEntity } from '../entities/App.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { ScreenEntity } from '../entities/Screen.entity';
import { claimBuildLease, Lease, LeaseLostError } from '../services/BuildProcessingLease';
import { IMaskRect, normalizeMasks, resolveMasks } from '../services/Mask';
import { PixelMatchService } from '../services/PixelMatch.service';
import { IBaseline, loadBaselines, resolveReference } from '../services/Reference';
import { computeRemovals } from '../services/RemovedScreens';
import { S3Service } from '../services/S3.service';
import { ThumbnailService } from '../services/Thumbnail.service';
import { ITolerances, resolveTolerances } from '../services/Tolerance';

/** Everything that decides whether two images of a screen match: tolerances, plus the masks in effect. */
type IComparison = ITolerances & { masks: IMaskRect[] };

/** Called with the downloaded bytes of each side of a comparison (to hash images that have no stored hash yet). */
interface IImageHooks {
    onLeft?: (data: Buffer) => void;
    onRight?: (data: Buffer) => void;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

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
        private pixelMatch: PixelMatchService,
        private thumbnails: ThumbnailService
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

        let ownScreens: BuildScreenEntity[];
        try {
            const work = this.processScreens(data.buildId, lease);
            work.catch(() => undefined); // if the race below is lost, the orphaned attempt's rejection is irrelevant
            ownScreens = await Promise.race([work, lease.lostSignal]);
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

        await this.generateThumbnails(ownScreens, logger);
    }

    /**
     * Makes gallery thumbnails ahead of time, so the first person to open a gallery doesn't wait for
     * them (and the API doesn't do the scaling). Runs after the build's result is committed and never
     * changes it: a thumbnail that fails here is made on demand when it is first asked for.
     */
    private async generateThumbnails(buildScreens: BuildScreenEntity[], logger: ScopedLogger) {
        let failed = 0;
        for (const buildScreen of buildScreens) {
            try {
                await this.thumbnails.ensure(buildScreen.appId, buildScreen.buildId, buildScreen.screenId, buildScreen.id);
            } catch (err) {
                failed++;
                logger.warn('Failed to generate thumbnail', { screenId: buildScreen.screenId, error: (err as Error).message });
            }
        }
        logger.info('Generated thumbnails', { count: buildScreens.length - failed, failed });
    }

    /** Returns the build screens that keep their own image (those that matched another build show that build's). */
    private async processScreens(buildId: string, lease: Lease): Promise<BuildScreenEntity[]> {
        const logger = this.logger.scoped(buildId);

        const currentBuild = await BuildEntity.query().filter({ id: buildId }).findOne();

        const app = await AppEntity.query().filter({ id: currentBuild.appId }).findOne();
        const appId = app.id;

        const currentBuildScreens = await BuildScreenEntity.query().filter({ appId, buildId: currentBuild.id }).find();

        const screenEntities = await ScreenEntity.query()
            .filter({ id: { $in: currentBuildScreens.map(bs => bs.screenId) } })
            .find();
        const screenEntitiesById = keyBy(screenEntities, 'id');
        // Resolved once from the rows loaded above, so a tolerance or mask save during processing applies to all of this build or none of it.
        const comparisons = new Map<string, IComparison>();
        const comparisonFor = (screenId: string): IComparison => {
            let comparison = comparisons.get(screenId);
            if (!comparison) {
                const screenEntity = screenEntitiesById[screenId];
                comparison = {
                    ...resolveTolerances(this.appConfig, app, screenEntity),
                    masks: normalizeMasks(resolveMasks(app, screenEntity))
                };
                comparisons.set(screenId, comparison);
            }
            return comparison;
        };
        // the audit record of what was ignored; written with the screens in the transaction below
        for (const buildScreen of currentBuildScreens) {
            if (!buildScreen.isRemoved) buildScreen.appliedMasks = comparisonFor(buildScreen.screenId).masks;
        }
        logger.info('Using diff threshold', { diffThreshold: this.appConfig.DEFAULT_PIXEL_DIFF_PCT_THRESHOLD });

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

        // the merge-base (or latest accepted) default-branch build, and per screen the image it holds
        const reference = await resolveReference(app, currentBuild);
        const referenceBuild = reference.build;
        const baselines = referenceBuild ? await loadBaselines(appId, referenceBuild.id) : new Map<string, IBaseline>();
        const referenceBuildScreens = [...baselines.values()].map(b => b.refRow);
        // lazily computed hashes of pre-0.8 baseline uploads, written with the result (source row id -> sha256)
        const hashPatches = new Map<string, string>();

        if (previousBuild) logger.info('Found previous build', { id: previousBuild.id });
        else logger.info('No previous build found for branch');

        if (referenceBuild) logger.info('Found reference build', { id: referenceBuild.id, source: reference.source });
        else logger.info('No reference build found');

        const screens = currentBuildScreens
            .filter(bs => !bs.isRemoved)
            .map(currentBuildScreen => ({
                screenId: currentBuildScreen.screenId,
                currentBuildScreen,
                previousBuildScreen: previousBuildScreensById[currentBuildScreen.screenId] as BuildScreenEntity | undefined,
                referenceBuildScreen: baselines.get(currentBuildScreen.screenId)?.refRow,
                baseline: baselines.get(currentBuildScreen.screenId)
            }));

        screenLoop: for (const screen of screens) {
            if (lease.lost) throw new LeaseLostError();
            screen.currentBuildScreen.baseImageBuildId = screen.baseline?.sourceBuildId ?? null;
            // if the previous screen has approved changes, compare the current screen with the already approved changes.
            // if the current build's screen matches, then it's automatically approved too.
            if (screen.previousBuildScreen?.status === 'changes approved') {
                logger.info('Screen in previous build with approved changes', { screenId: screen.screenId });

                // speculative: the review UI's left-hand image is the reference build, not the previous branch build, so this
                // comparison must not store a diff (it would overwrite the one stored for the reference below)
                const isMatch = await this.screensMatch(
                    appId,
                    screen.previousBuildScreen.matchedBuildId ?? screen.previousBuildScreen.buildId,
                    currentBuild.id,
                    screen.screenId,
                    comparisonFor(screen.screenId)
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
            if (screen.referenceBuildScreen && screen.baseline) {
                const baseline = screen.baseline;
                // byte-identical to the baseline: nothing to download or compare
                const identical = !!screen.currentBuildScreen.contentHash && screen.currentBuildScreen.contentHash === baseline.hash;

                // the only comparison that stores a diff (against the reference build's screen); every other comparison in this
                // flow is speculative (screensMatch). Screens resolved via matchedBuildId still show the matched build's diff.
                // The left side is the baseline's image source: a reference row that matched another build keeps no upload of its own.
                const isMatch =
                    identical ||
                    (await this.performDiff(appId, baseline.sourceBuildId, currentBuild.id, screen.screenId, comparisonFor(screen.screenId), {
                        // pre-0.8 uploads have no hash yet: fill them in from the bytes we are downloading anyway
                        onLeft: data => {
                            if (!baseline.hash) hashPatches.set(baseline.sourceRowId, sha256(data));
                        },
                        onRight: data => {
                            if (!screen.currentBuildScreen.contentHash) screen.currentBuildScreen.contentHash = sha256(data);
                        }
                    }));

                if (isMatch) {
                    logger.info('Current build screen matches reference', {
                        screenId: screen.screenId,
                        status: screen.currentBuildScreen.status
                    });
                    screen.currentBuildScreen.matchedBuildId = baseline.sourceBuildId;
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

                // speculative candidate from another branch: must not store a diff over the one against the reference
                const isMatch = await this.screensMatch(
                    appId,
                    approvedBuildScreen.matchedBuildId ?? approvedBuildScreen.buildId,
                    currentBuild.id,
                    screen.screenId,
                    comparisonFor(screen.screenId)
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
        // branches) by screenId, since builds_screens has no branchId. Carry-forward fires only when the two
        // images match within the screen's tolerances and masks (the same test as every other comparison here),
        // so a cross-branch decision is inherited only when the screen is visually the same outside its masks.
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
                        comparisonFor(screen.screenId)
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
            locked.referenceBuildId = referenceBuild?.id ?? null;
            locked.referenceSource = reference.source;
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
            for (const [rowId, hash] of hashPatches) {
                await txn.query(BuildScreenEntity).filter({ id: rowId, contentHash: null }).patchMany({ contentHash: hash });
            }
        });

        return currentBuildScreens.filter(bs => !bs.matchedBuildId);
    }

    private async loadAndDiff(
        appId: string,
        leftBuildId: string,
        rightBuildId: string,
        screenId: string,
        comparison: IComparison,
        hooks?: IImageHooks
    ) {
        const leftScreenData = await this.s3Svc.getBuffer(this.s3Svc.getPathForScreen(appId, leftBuildId, screenId));
        hooks?.onLeft?.(leftScreenData);
        const rightScreenData = await this.s3Svc.getBuffer(this.s3Svc.getPathForScreen(appId, rightBuildId, screenId));
        hooks?.onRight?.(rightScreenData);
        return this.pixelMatch.getDiff(leftScreenData, rightScreenData, comparison.colorTolerance, comparison.shiftTolerance, comparison.masks);
    }

    private async performDiff(
        appId: string,
        leftBuildId: string,
        rightBuildId: string,
        screenId: string,
        comparison: IComparison,
        hooks?: IImageHooks
    ) {
        this.logger.info('Performing diff', { leftBuildId, rightBuildId, screenId });

        const { getDiffPng, diffPct } = await this.loadAndDiff(appId, leftBuildId, rightBuildId, screenId, comparison, hooks);

        if (diffPct > comparison.diffPctTolerance) {
            this.logger.info('Diff exceeds threshold. Storing diff.', { diffPct, diffThreshold: comparison.diffPctTolerance });
            const diffBuf = await getDiffPng();
            await this.s3Svc.uploadFile(diffBuf, this.s3Svc.getPathForDiff(appId, rightBuildId, screenId), 'image/png');
            return false;
        }

        return true;
    }

    // the authoritative diff is the one against the reference build (see the screenLoop); everything else uses this.
    // like performDiff, but only reports whether two screens match without storing a diff image,
    // so it can be used for speculative comparisons without clobbering the stored reference diff
    private async screensMatch(appId: string, leftBuildId: string, rightBuildId: string, screenId: string, comparison: IComparison) {
        const { diffPct } = await this.loadAndDiff(appId, leftBuildId, rightBuildId, screenId, comparison);
        return diffPct <= comparison.diffPctTolerance;
    }
}
