import { ScopedLogger } from '@zyno-io/ts-server-foundation';
import { AnyResponse, BaseJob, WorkerJob, WorkerService } from '@zyno-io/ts-server-foundation';
import { createHash } from 'crypto';
import { keyBy } from 'lodash';

import { AppConfig } from '../config';
import { Db } from '../database';
import { AppEntity } from '../entities/App.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { ScreenEntity } from '../entities/Screen.entity';
import { ScreenDecisionEntity } from '../entities/ScreenDecision.entity';
import { claimBuildLease, Lease, LeaseLostError } from '../services/BuildProcessingLease';
import { absentEpoch, findDecision } from '../services/Decisions';
import { IMaskRect, normalizeMasks, resolveMasks } from '../services/Mask';
import { PixelMatchService } from '../services/PixelMatch.service';
import { IBaseline, loadBaselines, resolveReference } from '../services/Reference';
import { computeRemovals } from '../services/RemovedScreens';
import { S3Service } from '../services/S3.service';
import { queueBuildReclaims } from '../services/storage/ReclaimQueue';
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

@WorkerJob()
export class ProcessBuildJob extends BaseJob<IProcessBuildJobData> {
    constructor(
        private logger: ScopedLogger,
        private appConfig: AppConfig,
        private db: Db,
        private s3Svc: S3Service,
        private pixelMatch: PixelMatchService,
        private thumbnails: ThumbnailService,
        private workerSvc: WorkerService
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

    /** Returns the build screens that keep their own image (everything except the rows that equal their baseline). */
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

        // the merge-base (or latest accepted) default-branch build, and per screen the image it holds
        const reference = await resolveReference(app, currentBuild);
        const referenceBuild = reference.build;
        const baselines = referenceBuild ? await loadBaselines(appId, referenceBuild.id) : new Map<string, IBaseline>();
        // lazily computed hashes of pre-0.8 baseline uploads, written with the result (source row id -> sha256)
        const hashPatches = new Map<string, string>();

        if (referenceBuild) logger.info('Found reference build', { id: referenceBuild.id, source: reference.source });
        else logger.info('No reference build found');

        const uploads = currentBuildScreens.filter(bs => !bs.isRemoved);
        // a spoiled comparison (storage trouble) counts as "doesn't match": the screen then needs review rather than failing the build
        const safeMatch = async (leftBuildId: string, row: BuildScreenEntity) => {
            try {
                return await this.screensMatch(appId, leftBuildId, currentBuild.id, row.screenId, comparisonFor(row.screenId), {
                    onRight: data => {
                        if (!row.contentHash) row.contentHash = sha256(data);
                    }
                });
            } catch (err) {
                logger.warn('Failed to compare against a decision image; treating it as different', {
                    screenId: row.screenId,
                    buildId: leftBuildId,
                    error: (err as Error).message
                });
                return false;
            }
        };

        for (const row of uploads) {
            if (lease.lost) throw new LeaseLostError();
            const baseline = baselines.get(row.screenId);
            row.baseImageBuildId = baseline?.sourceBuildId ?? null;

            let epoch: string;
            if (baseline) {
                // byte-identical to the baseline: nothing to download or compare
                const identical = !!row.contentHash && row.contentHash === baseline.hash;
                // the only comparison that stores a diff, at this row's own path against its baseline's image source (a reference
                // row that matched another build keeps no upload of its own); every other comparison here is speculative (safeMatch)
                const isMatch =
                    identical ||
                    (await this.performDiff(appId, baseline.sourceBuildId, currentBuild.id, row.screenId, comparisonFor(row.screenId), {
                        // pre-0.8 uploads have no hash yet: fill them in from the bytes we are downloading anyway
                        onLeft: data => {
                            if (!baseline.hash) hashPatches.set(baseline.sourceRowId, sha256(data));
                        },
                        onRight: data => {
                            if (!row.contentHash) row.contentHash = sha256(data);
                        }
                    }));
                if (isMatch) {
                    logger.info('Screen matches reference', { screenId: row.screenId });
                    row.matchedBuildId = baseline.sourceBuildId;
                    row.status = 'no changes';
                    continue;
                }
                epoch = baseline.sourceRowId;
            } else {
                epoch = await absentEpoch(this.db, appId, row.screenId, app.defaultBranchId, referenceBuild?.id);
            }

            // a decision made earlier (on any branch) for exactly this change: this image replacing the baseline's
            const decision = await findDecision({
                appId,
                screenId: row.screenId,
                branchId: currentBuild.branchId,
                from: baseline ? { buildId: baseline.sourceBuildId, hash: baseline.hash } : null,
                to: { hash: row.contentHash },
                epoch,
                match: toImageBuildId => safeMatch(toImageBuildId, row)
            });

            if (decision?.kind === 'approved') {
                logger.info('Screen matches an approved change', { screenId: row.screenId, decisionId: decision.id });
                row.status = 'changes approved';
                row.matchedBuildId = decision.toImageBuildId;
                row.decisionId = decision.id;
                row.approvalBuildId = decision.buildId;
                continue;
            }

            row.status = baseline ? 'needs review' : 'new';
            if (decision?.kind === 'rejected') {
                // pre-marked; nobody reviewed it in this build, so there is no reviewer
                logger.info('Screen matches a rejected change', { screenId: row.screenId, decisionId: decision.id });
                row.reviewStatus = 'rejected';
                row.reviewComment = decision.comment;
                row.decisionId = decision.id;
            }
        }

        await this.carryForwardReviews(currentBuild, uploads, safeMatch, logger);

        // screens in the reference build that this build no longer has get a tombstone (needs review until the removal is approved)
        const tombstones = await computeRemovals({
            appId,
            buildId: currentBuild.id,
            currentScreenIds: uploads.map(row => row.screenId),
            baselines,
            findRemovalDecision: (screenId, baseline) =>
                findDecision({
                    appId,
                    screenId,
                    branchId: currentBuild.branchId,
                    from: { buildId: baseline.sourceBuildId, hash: baseline.hash },
                    to: 'absent',
                    epoch: baseline.sourceRowId,
                    match: async () => false
                })
        });
        const statuses = [...uploads.map(row => row.status), ...tombstones.map(tombstone => tombstone.status)];

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

        let pendingDeletionRows = 0;
        await this.db.transaction(async txn => {
            pendingDeletionRows = 0; // the callback can run again (deadlock retry)
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
            // Only rows that equal their baseline hold nothing of their own: auto-approved rows keep (and show) their upload.
            // The storage cleaner (services/storage) deletes these uploads after a grace period, but never one that a matchedBuildId,
            // baseImageBuildId or decision still points at.
            const pending = await txn
                .query(BuildScreenEntity)
                .filter({ buildId: currentBuild.id, status: 'no changes', matchedBuildId: { $ne: null } })
                .patchMany({
                    storageStatus: 'pendingDeletion'
                });
            pendingDeletionRows = pending.affectedRows;
            for (const [rowId, hash] of hashPatches) {
                await txn.query(BuildScreenEntity).filter({ id: rowId, contentHash: null }).patchMany({ contentHash: hash });
            }
        });

        if (pendingDeletionRows) await queueBuildReclaims(this.workerSvc, this.appConfig, this.logger, currentBuild.appId, [currentBuild.id]);

        return uploads.filter(row => row.status !== 'no changes');
    }

    /**
     * Review marks made while the branch's previous build was under review carry onto this build, for the same change only:
     * the same baseline image and an equal upload. They carry no reviewer (the submitter takes responsibility on approve)
     * and point at the review they came from. Nothing carries between branches here: that is what decisions are for.
     */
    private async carryForwardReviews(
        build: BuildEntity,
        uploads: BuildScreenEntity[],
        safeMatch: (leftBuildId: string, row: BuildScreenEntity) => Promise<boolean>,
        logger: ScopedLogger
    ) {
        const candidates = uploads.filter(row => (row.status === 'new' || row.status === 'needs review') && !row.reviewStatus);
        if (!candidates.length) return;

        const prev = await BuildEntity.query()
            .filter({
                appId: build.appId,
                branchId: build.branchId,
                id: { $lt: build.id },
                status: { $nin: ['draft', 'processing', 'canceled', 'failed'] }
            })
            .orderBy('id', 'desc')
            .findOneOrUndefined();
        // marks from before 0.8 never recorded which baseline they were made against
        if (!prev || (prev.status !== 'needs review' && prev.status !== 'changes rejected')) return;
        if (!prev.referenceSource || prev.referenceSource === 'legacy') return;

        const marked = await BuildScreenEntity.query()
            .filter({ appId: build.appId, buildId: prev.id, isRemoved: false, reviewStatus: { $ne: null } })
            .find();
        const markedByScreen = keyBy(marked, 'screenId');
        const decisionIds = marked.map(p => p.decisionId).filter((id): id is string => !!id);
        const revokedIds = new Set(
            decisionIds.length
                ? (
                      await ScreenDecisionEntity.query()
                          .filter({ appId: build.appId, id: { $in: decisionIds }, revokedAt: { $ne: null } })
                          .select('id')
                          .find()
                  ).map(d => d.id)
                : []
        );

        for (const row of candidates) {
            const p = markedByScreen[row.screenId];
            if (!p) continue;
            // a mark that only came from a decision is not the reviewer's own: the decision re-applies it (or not, once revoked)
            if (p.decisionId && !p.reviewedById) continue;
            if (p.decisionId && revokedIds.has(p.decisionId)) continue;
            if (p.baseImageBuildId !== row.baseImageBuildId) continue;
            const sameImage = (!!row.contentHash && row.contentHash === p.contentHash) || (await safeMatch(p.buildId, row));
            if (!sameImage) continue;

            logger.info('Carrying forward review mark for the same change', {
                screenId: row.screenId,
                reviewStatus: p.reviewStatus,
                fromBuildId: p.buildId
            });
            row.reviewStatus = p.reviewStatus;
            row.reviewComment = p.reviewComment;
            row.reviewCarriedFromId = p.reviewCarriedFromId ?? p.id;
        }
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

    // the authoritative diff is the one against the baseline (see processScreens); everything else uses this.
    // like performDiff, but only reports whether two screens match without storing a diff image,
    // so it can be used for speculative comparisons without clobbering the stored baseline diff
    private async screensMatch(
        appId: string,
        leftBuildId: string,
        rightBuildId: string,
        screenId: string,
        comparison: IComparison,
        hooks?: IImageHooks
    ) {
        const { diffPct } = await this.loadAndDiff(appId, leftBuildId, rightBuildId, screenId, comparison, hooks);
        return diffPct <= comparison.diffPctTolerance;
    }
}
