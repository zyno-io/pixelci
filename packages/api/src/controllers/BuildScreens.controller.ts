import {
    http,
    HttpBadRequestError,
    HttpBody,
    HttpConflictError,
    HttpNotFoundError,
    HttpRequest,
    HttpUnauthorizedError,
    isUniqueConstraintError,
    Redirect,
    FileUpload,
    UuidString
} from '@zyno-io/ts-server-foundation';
import { AnyResponse, createPersistedEntity, uuid7 } from '@zyno-io/ts-server-foundation';
import { readFile } from 'fs/promises';
import { keyBy, uniq } from 'lodash';

import { BuildCiTokenMiddleware, hashCiToken, UserAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { AppConfig } from '../config';
import { Db } from '../database';
import { AppEntity } from '../entities/App.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { BuildShardEntity } from '../entities/BuildShard.entity';
import { ScreenEntity } from '../entities/Screen.entity';
import { UserEntity } from '../entities/User.entity';
import { AppAccessService } from '../services/AppAccess.service';
import { IMaskRect, IScreenMasksResponse, loadUserNames, MAX_MASKS, toScreenMasksResponse, validateMasks } from '../services/Mask';
import { PixelMatchService } from '../services/PixelMatch.service';
import { isNotFound, S3Service } from '../services/S3.service';
import { parseScreenName, validateScreenName, readPngHeader, repairLatin1Filename } from '../services/ScreenUpload';
import { ThumbnailService } from '../services/Thumbnail.service';
import { ITolerances, IToleranceOverrides, validateTolerances } from '../services/Tolerance';
import { CI_TOKEN_TTL_MS } from './Builds.controller';

const SHARD_NAME_CLASH = 'screen names must be unique across shards';

export type IAppScreenResponse = Pick<ScreenEntity, 'id' | 'name'>;
export type IBuildScreenCompareResponse = {
    diffPct: number;
    diffPixels: number;
    totalPixels: number;
    shiftTolerantPixels: number;
    /** pixels under a mask: excluded from the comparison and from the denominator of diffPct */
    maskedPixels: number;
    passes: boolean;
    diffImage: string;
};
export type IBuildScreenResponse = {
    screenId: string;
    name: string;
    tolerances: IToleranceOverrides;
    /** The screen's own masks (the app's are on the app). Edits apply from the next build. */
    masks: IScreenMasksResponse;
    currentBuildScreen:
        | Pick<
              BuildScreenEntity,
              | 'id'
              | 'buildId'
              | 'matchedBuildId'
              | 'approvalBuildId'
              | 'screenId'
              | 'status'
              | 'reviewStatus'
              | 'reviewComment'
              | 'reviewedById'
              | 'reviewedAt'
              | 'appliedMasks'
          >
        | undefined;
    referenceBuildScreen:
        | Pick<
              BuildScreenEntity,
              | 'id'
              | 'buildId'
              | 'matchedBuildId'
              | 'approvalBuildId'
              | 'screenId'
              | 'status'
              | 'reviewStatus'
              | 'reviewComment'
              | 'reviewedById'
              | 'reviewedAt'
              | 'appliedMasks'
          >
        | undefined;
    /** Tombstone: this build removed the screen (it is in the reference build, but has no image here). */
    removedBuildScreen?: Pick<BuildScreenEntity, 'id' | 'status' | 'reviewStatus' | 'reviewComment' | 'reviewedById' | 'reviewedAt'>;
};
export type IBuildScreenReviewResponse = Pick<BuildScreenEntity, 'reviewStatus' | 'reviewComment' | 'reviewedById' | 'reviewedAt'>;
export type IBuildScreenCreateResponse = Pick<BuildScreenEntity, 'id' | 'screenId' | 'status'> & Pick<ScreenEntity, 'name'>;

function pickBuildScreen(bs: BuildScreenEntity | undefined): NonNullable<IBuildScreenResponse['currentBuildScreen']> | undefined {
    if (!bs) return undefined;
    return {
        id: bs.id,
        buildId: bs.buildId,
        matchedBuildId: bs.matchedBuildId,
        approvalBuildId: bs.approvalBuildId,
        screenId: bs.screenId,
        status: bs.status,
        reviewStatus: bs.reviewStatus,
        reviewComment: bs.reviewComment,
        reviewedById: bs.reviewedById,
        reviewedAt: bs.reviewedAt,
        appliedMasks: bs.appliedMasks
    };
}

function pickRemovedBuildScreen(bs: BuildScreenEntity | undefined): IBuildScreenResponse['removedBuildScreen'] {
    if (!bs) return undefined;
    return {
        id: bs.id,
        status: bs.status,
        reviewStatus: bs.reviewStatus,
        reviewComment: bs.reviewComment,
        reviewedById: bs.reviewedById,
        reviewedAt: bs.reviewedAt
    };
}

@ApiController('/api/apps/:appId/builds/:id')
export class BuildScreensController {
    constructor(
        private db: Db,
        private s3Svc: S3Service,
        private appAccessSvc: AppAccessService,
        private appConfig: AppConfig,
        private pixelMatch: PixelMatchService,
        private thumbnails: ThumbnailService
    ) {}

    /** The latest approved build on the app's default branch that precedes the given build. */
    private async findReferenceBuild(app: AppEntity, build: BuildEntity): Promise<BuildEntity | undefined> {
        if (!app.defaultBranchId) return undefined;
        return BuildEntity.query()
            .filter({ appId: app.id, branchId: app.defaultBranchId, status: 'changes approved', id: { $lt: build.id } })
            .orderBy('id', 'desc')
            .findOneOrUndefined();
    }

    @http.GET('screens')
    @http.middleware(UserAuthMiddleware)
    async getScreens(appId: UuidString, id: UuidString, user: UserEntity): Promise<IBuildScreenResponse[]> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);

        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        const app = await this.db.query(AppEntity).filter({ id: appId }).findOne();

        const referenceBuild = await this.findReferenceBuild(app, build);

        // Ordered by id (UUID7, so upload order). Postgres returns unordered rows in heap order, which
        // changes whenever a row is updated — without this the list reshuffles after each review.
        const currentBuildScreens = await BuildScreenEntity.query().filter({ appId, buildId: build.id }).orderBy('id', 'asc').find();

        const referenceBuildScreens = referenceBuild
            ? await BuildScreenEntity.query().filter({ appId, buildId: referenceBuild.id, isRemoved: false }).orderBy('id', 'asc').find()
            : [];

        const currentBuildScreensById = keyBy(
            currentBuildScreens.filter(buildScreen => !buildScreen.isRemoved),
            'screenId'
        );
        const removedBuildScreensById = keyBy(
            currentBuildScreens.filter(buildScreen => buildScreen.isRemoved),
            'screenId'
        );
        const referenceBuildScreensById = keyBy(referenceBuildScreens, 'screenId');
        const screenIds = uniq([...currentBuildScreens, ...referenceBuildScreens].map(buildScreen => buildScreen.screenId));

        const buildScreens = [...screenIds].map(screenId => ({
            screenId,
            currentBuildScreen: pickBuildScreen(currentBuildScreensById[screenId]),
            referenceBuildScreen: pickBuildScreen(referenceBuildScreensById[screenId]),
            removedBuildScreen: pickRemovedBuildScreen(removedBuildScreensById[screenId])
        }));

        const screens = await ScreenEntity.query()
            .filter({ id: { $in: screenIds } })
            .select(
                'id',
                'name',
                'colorTolerance',
                'shiftTolerance',
                'diffPctTolerance',
                'masks',
                'inheritAppMasks',
                'masksVersion',
                'masksUpdatedAt',
                'masksUpdatedById'
            )
            .find();
        const screensById = keyBy(screens, 'id');
        const maskNames = await loadUserNames(screens.map(screen => screen.masksUpdatedById));

        return buildScreens.map(buildScreen => ({
            ...buildScreen,
            name: screensById[buildScreen.screenId]?.name,
            tolerances: {
                colorTolerance: screensById[buildScreen.screenId]?.colorTolerance ?? null,
                shiftTolerance: screensById[buildScreen.screenId]?.shiftTolerance ?? null,
                diffPctTolerance: screensById[buildScreen.screenId]?.diffPctTolerance ?? null
            },
            masks: toScreenMasksResponse(
                screensById[buildScreen.screenId] ?? {
                    masks: null,
                    inheritAppMasks: true,
                    masksVersion: 0,
                    masksUpdatedAt: null,
                    masksUpdatedById: null
                },
                maskNames
            )
        }));
    }

    /** Previews a comparison of this build's screen against the reference build's screen with arbitrary tolerances. Writes nothing. */
    @http.POST('screens/:screenId/compare')
    @http.middleware(UserAuthMiddleware)
    async compareScreen(
        appId: UuidString,
        id: UuidString,
        screenId: UuidString,
        user: UserEntity,
        body: HttpBody<ITolerances & { masks: IMaskRect[] }>
    ): Promise<IBuildScreenCompareResponse> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);
        validateTolerances(body);
        // the masks in effect: the app's and the screen's together, so up to twice the per-list cap
        validateMasks(body.masks, MAX_MASKS * 2);

        const build = await BuildEntity.query()
            .filter({ id, appId, status: { $nin: ['draft', 'canceled'] } })
            .findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();
        const app = await this.db.query(AppEntity).filter({ id: appId }).findOne();

        const referenceBuild = await this.findReferenceBuild(app, build);
        if (!referenceBuild) throw new HttpBadRequestError('No reference build to compare against');

        const current = await BuildScreenEntity.query().filter({ appId, buildId: build.id, screenId, isRemoved: false }).findOneOrUndefined();
        const reference = await BuildScreenEntity.query()
            .filter({ appId, buildId: referenceBuild.id, screenId, isRemoved: false })
            .findOneOrUndefined();
        if (!current) throw new HttpBadRequestError('Screen is not in this build');
        if (!reference) throw new HttpBadRequestError('Screen is not in the reference build');

        // The same pair processing compares: each build's own upload. `matchedBuildId` on the current
        // screen points at the image it was judged equal to, so following it would compare the
        // reference with itself and report no difference at any tolerance.
        const [referenceImage, currentImage] = await Promise.all([this.getOwnScreenImage(appId, reference), this.getOwnScreenImage(appId, current)]);

        const result = await this.pixelMatch.getDiffExclusive(referenceImage, currentImage, body.colorTolerance, body.shiftTolerance, body.masks);
        return {
            diffPct: result.diffPct,
            diffPixels: result.diffPixels,
            totalPixels: result.totalPixels,
            shiftTolerantPixels: result.shiftTolerantPixels,
            maskedPixels: result.maskedPixels,
            passes: result.diffPct <= body.diffPctTolerance,
            diffImage: 'data:image/png;base64,' + (await result.getDiffPng()).toString('base64')
        };
    }

    /** A build screen's own upload, falling back to the build it matched if its own copy is gone. */
    private async getOwnScreenImage(appId: string, buildScreen: BuildScreenEntity) {
        try {
            return await this.s3Svc.getBuffer(this.s3Svc.getPathForScreen(appId, buildScreen.buildId, buildScreen.screenId));
        } catch (err) {
            if (!buildScreen.matchedBuildId) throw err;
            return this.s3Svc.getBuffer(this.s3Svc.getPathForScreen(appId, buildScreen.matchedBuildId, buildScreen.screenId));
        }
    }

    @http.POST('screens')
    @http.middleware(BuildCiTokenMiddleware)
    async uploadScreen(
        request: HttpRequest,
        appId: UuidString,
        id: UuidString,
        body: HttpBody<{ image: FileUpload<{ maxSize: '17MB' }>; name?: string }>
    ): Promise<IBuildScreenCreateResponse> {
        const callerHash = hashCiToken((request.headers.authorization ?? '').slice(7));

        // The multipart filename is decoded as latin1 by the parser, so non-ASCII names arrive mangled and quotes/backslashes don't survive.
        // Newer CLIs send the exact name as a form field; for older ones, repair a UTF-8 name that was decoded as latin1.
        const screenName = body.name !== undefined ? validateScreenName(body.name) : parseScreenName(repairLatin1Filename(body.image.name));
        // Read once (bounded by the request body cap) and validate and upload the same buffer
        const imageBuf = await readFile(body.image.path);
        readPngHeader(imageBuf, this.appConfig.SCREEN_MAX_PIXELS);

        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();
        if (build.status !== 'draft') throw new HttpBadRequestError('build is not in draft state');

        const screen = await this.findOrCreateScreen(appId, screenName);

        // Sharded builds: refuse a name another shard already uploaded BEFORE the PUT, which would overwrite that shard's image
        // (the key is per build+screen). This narrows the race but doesn't close it: two shards uploading the same new name at the
        // same moment can still overwrite each other's object (one then gets the 409 below). Content-addressed keys (phase 1) close it.
        if (build.shardTotal > 1) {
            const shard = await BuildShardEntity.query().filter({ buildId: id, ciTokenHash: callerHash }).findOneOrUndefined();
            if (!shard) throw new HttpUnauthorizedError();
            if (shard.state !== 'uploading') throw new HttpBadRequestError('shard already finalised');
            const clash = await BuildScreenEntity.query()
                .filter({ buildId: id, screenId: screen.id, shardIndex: { $ne: shard.shardIndex } })
                .findOneOrUndefined();
            if (clash) throw new HttpConflictError(SHARD_NAME_CLASH);
        }

        // The S3 PUT happens outside any transaction so a slow upload never holds a DB connection or row locks.
        // TODO(phase 1): the key is per build+screen, so a late PUT from a superseded uploader (after a takeover) can overwrite the
        // new uploader's image. Content-addressed storage removes that race.
        await this.s3Svc.uploadFile(imageBuf, this.s3Svc.getPathForScreen(appId, id, screen.id), 'image/png');

        // Returned (not thrown) from the transaction, like `process`, so a rejection doesn't roll back anything.
        const result = await this.db.transaction(async txn => {
            // Re-check under lock: a takeover or process may have happened while the image was uploading.
            const locked = await txn.query(BuildEntity).filter({ id, appId }).forUpdate().findOneOrUndefined();
            if (!locked) return new HttpNotFoundError();
            if (locked.status !== 'draft') return new HttpBadRequestError('build is not in draft state');
            // Sharded builds authenticate with the shard's own token; lock order is build, then shard, then screens.
            let shard: BuildShardEntity | undefined;
            if (locked.shardTotal > 1) {
                shard = await txn.query(BuildShardEntity).filter({ buildId: id, ciTokenHash: callerHash }).forUpdate().findOneOrUndefined();
                if (!shard) return new HttpUnauthorizedError();
                if (shard.state !== 'uploading') return new HttpBadRequestError('shard already finalised');
                const clash = await txn
                    .query(BuildScreenEntity)
                    .filter({ buildId: id, screenId: screen.id, shardIndex: { $ne: shard.shardIndex } })
                    .findOneOrUndefined();
                if (clash) return new HttpConflictError(SHARD_NAME_CLASH);
            } else if (locked.ciTokenHash !== callerHash) return new HttpUnauthorizedError();

            // Re-upload (e.g. a re-run after a partial failure): replace the earlier upload
            await txn.query(BuildScreenEntity).filter({ buildId: id, screenId: screen.id }).deleteMany();
            const buildScreen = await createPersistedEntity(
                BuildScreenEntity,
                {
                    id: uuid7(),
                    appId,
                    buildId: id,
                    screenId: screen.id,
                    status: 'new',
                    storageStatus: 'stored',
                    ...(shard && { shardIndex: shard.shardIndex })
                },
                txn
            );
            if (shard) {
                shard.activeAt = new Date();
                txn.add(shard);
            }
            await txn
                .query(BuildEntity)
                .filter({ id })
                .patchMany({ draftActiveAt: new Date(), ciTokensExpireAt: new Date(Date.now() + CI_TOKEN_TTL_MS) });

            return { id: buildScreen.id, screenId: buildScreen.screenId, status: buildScreen.status, name: screen.name };
        });
        if (result instanceof Error) throw result;
        return result;
    }

    /** Autocommit create; on a unique-constraint violation (a concurrent upload won the race) re-select the winner. */
    private async findOrCreateScreen(appId: string, name: string): Promise<ScreenEntity> {
        const existing = await ScreenEntity.query().filter({ appId, name }).findOneOrUndefined();
        if (existing) return existing;
        try {
            return await createPersistedEntity(ScreenEntity, { id: uuid7(), appId, name });
        } catch (err) {
            if (!isUniqueConstraintError(err)) throw err;
            return await ScreenEntity.query().filter({ appId, name }).findOne();
        }
    }

    // TEST for getting images
    @http.GET('screens/:screenId/image')
    @http.middleware(UserAuthMiddleware)
    async getScreenImage(appId: UuidString, id: UuidString, screenId: UuidString, user: UserEntity): AnyResponse {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);
        const row = await this.findStoredImage(appId, id, screenId);
        const url = await this.s3Svc.getSignedUrl(this.s3Svc.getPathForScreen(row.appId, row.buildId, row.screenId));
        return Redirect.toUrl(url);
    }

    /** A scaled-down copy of the screenshot for gallery tiles, generated on first request and kept in storage. */
    @http.GET('screens/:screenId/thumbnail')
    @http.middleware(UserAuthMiddleware)
    async getScreenThumbnail(appId: UuidString, id: UuidString, screenId: UuidString, user: UserEntity): AnyResponse {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);
        const buildScreen = await this.findStoredImage(appId, id, screenId);
        let path: string;
        try {
            path = await this.thumbnails.ensure(appId, id, screenId, buildScreen.id);
        } catch (err) {
            if (isNotFound(err)) throw new HttpNotFoundError();
            throw err;
        }
        return Redirect.toUrl(await this.s3Svc.getSignedUrl(path));
    }

    @http.GET('screens/:screenId/diff')
    @http.middleware(UserAuthMiddleware)
    async getScreenDiff(appId: UuidString, id: UuidString, screenId: UuidString, user: UserEntity): AnyResponse {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);
        const row = await this.findStoredImage(appId, id, screenId);
        const url = await this.s3Svc.getSignedUrl(this.s3Svc.getPathForDiff(row.appId, row.buildId, row.screenId));
        return Redirect.toUrl(url);
    }

    @http.POST('screens/:screenId/review')
    @http.middleware(UserAuthMiddleware)
    async reviewScreen(
        user: UserEntity,
        appId: UuidString,
        id: UuidString,
        screenId: UuidString,
        body: HttpBody<{ reviewStatus: 'approved' | 'rejected'; comment: string }>
    ): Promise<IBuildScreenReviewResponse> {
        await this.appAccessSvc.assertCanReviewAppId(user, appId);

        // Lock the build row first (the same order as approve and process), so a review can't land after approve has
        // committed: approve holds this lock while it reads and promotes the screens. Validation failures are returned
        // from the transaction (not thrown inside it), like process.
        const result = await this.db.transaction(async txn => {
            const build = await txn.query(BuildEntity).filter({ id, appId }).forUpdate().findOneOrUndefined();
            if (!build) return new HttpNotFoundError();
            if (build.status !== 'needs review') return new HttpBadRequestError('Build is not in needs review status');

            // Removals are accepted only by approving the build, never reviewed one by one
            const buildScreen = await txn.query(BuildScreenEntity).filter({ appId, buildId: id, screenId, isRemoved: false }).findOneOrUndefined();
            if (!buildScreen) return new HttpNotFoundError();
            if (buildScreen.status !== 'new' && buildScreen.status !== 'needs review') {
                return new HttpBadRequestError('Screen is not awaiting review');
            }

            buildScreen.reviewStatus = body.reviewStatus;
            buildScreen.reviewComment = body.comment?.trim() || null;
            buildScreen.reviewedById = user.id;
            buildScreen.reviewedAt = new Date();
            txn.add(buildScreen);

            return {
                reviewStatus: buildScreen.reviewStatus,
                reviewComment: buildScreen.reviewComment,
                reviewedById: buildScreen.reviewedById,
                reviewedAt: buildScreen.reviewedAt
            };
        });
        if (result instanceof Error) throw result;
        return result;
    }

    /** 404s unless the build belongs to the app (and isn't a draft/canceled) and has an image row (not a removal marker) for the screen. */
    private async findStoredImage(appId: string, buildId: string, screenId: string): Promise<BuildScreenEntity> {
        const build = await BuildEntity.query()
            .filter({ id: buildId, appId, status: { $nin: ['draft', 'canceled'] } })
            .findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();
        const row = await BuildScreenEntity.query().filter({ appId, buildId, screenId, isRemoved: false }).findOneOrUndefined();
        if (!row) throw new HttpNotFoundError();
        return row;
    }
}
