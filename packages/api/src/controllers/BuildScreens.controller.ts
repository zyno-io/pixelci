import {
    http,
    HttpBadRequestError,
    HttpBody,
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
import { ScreenEntity } from '../entities/Screen.entity';
import { UserEntity } from '../entities/User.entity';
import { AppAccessService } from '../services/AppAccess.service';
import { S3Service } from '../services/S3.service';
import { parseScreenName, readPngHeader } from '../services/ScreenUpload';

export type IAppScreenResponse = Pick<ScreenEntity, 'id' | 'name'>;
export type IBuildScreenResponse = {
    screenId: string;
    name: string;
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
          >
        | undefined;
};
export type IBuildScreenReviewResponse = Pick<BuildScreenEntity, 'reviewStatus' | 'reviewComment' | 'reviewedById' | 'reviewedAt'>;
export type IBuildScreenCreateResponse = Pick<BuildScreenEntity, 'id' | 'screenId' | 'status'> & Pick<ScreenEntity, 'name'>;

@ApiController('/api/apps/:appId/builds/:id')
export class BuildScreensController {
    constructor(
        private db: Db,
        private s3Svc: S3Service,
        private appAccessSvc: AppAccessService,
        private appConfig: AppConfig
    ) {}

    @http.GET('screens')
    @http.middleware(UserAuthMiddleware)
    async getScreens(appId: UuidString, id: UuidString, user: UserEntity): Promise<IBuildScreenResponse[]> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);

        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        const app = await this.db.query(AppEntity).filter({ id: appId }).findOne();

        const referenceBuild = app.defaultBranchId
            ? await BuildEntity.query()
                  .filter({ appId: app.id, branchId: app.defaultBranchId, status: 'changes approved', id: { $lt: build.id } })
                  .orderBy('id', 'desc')
                  .findOneOrUndefined()
            : undefined;

        // Ordered by id (UUID7, so upload order). Postgres returns unordered rows in heap order, which
        // changes whenever a row is updated — without this the list reshuffles after each review.
        const currentBuildScreens = await BuildScreenEntity.query().filter({ appId, buildId: build.id }).orderBy('id', 'asc').find();

        const referenceBuildScreens = referenceBuild
            ? await BuildScreenEntity.query().filter({ appId, buildId: referenceBuild.id }).orderBy('id', 'asc').find()
            : [];

        const currentBuildScreensById = keyBy(currentBuildScreens, 'screenId');
        const referenceBuildScreensById = keyBy(referenceBuildScreens, 'screenId');
        const screenIds = uniq([...currentBuildScreens, ...referenceBuildScreens].map(buildScreen => buildScreen.screenId));

        const buildScreens = [...screenIds].map(screenId => ({
            screenId,
            currentBuildScreen: currentBuildScreensById[screenId],
            referenceBuildScreen: referenceBuildScreensById[screenId]
        }));

        const screens = await ScreenEntity.query()
            .filter({ id: { $in: screenIds } })
            .select('id', 'name')
            .find();
        const screensById = keyBy(screens, 'id');

        return buildScreens.map(buildScreen => ({
            ...buildScreen,
            name: screensById[buildScreen.screenId]?.name
        }));
    }

    @http.POST('screens')
    @http.middleware(BuildCiTokenMiddleware)
    async uploadScreen(
        request: HttpRequest,
        appId: UuidString,
        id: UuidString,
        body: HttpBody<{ image: FileUpload<{ maxSize: '17MB' }> }>
    ): Promise<IBuildScreenCreateResponse> {
        const callerHash = hashCiToken((request.headers.authorization ?? '').slice(7));

        const screenName = parseScreenName(body.image.name);
        // Read once (bounded by the request body cap) and validate and upload the same buffer
        const imageBuf = await readFile(body.image.path);
        readPngHeader(imageBuf, this.appConfig.SCREEN_MAX_PIXELS);

        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();
        if (build.status !== 'draft') throw new HttpBadRequestError('build is not in draft state');

        const screen = await this.findOrCreateScreen(appId, screenName);

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
            if (locked.ciTokenHash !== callerHash) return new HttpUnauthorizedError();

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
                    storageStatus: 'stored'
                },
                txn
            );
            await txn.query(BuildEntity).filter({ id }).patchMany({ draftActiveAt: new Date() });

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
        const url = await this.s3Svc.getSignedUrl(this.s3Svc.getPathForScreen(appId, id, screenId));
        return Redirect.toUrl(url);
    }

    @http.GET('screens/:screenId/diff')
    @http.middleware(UserAuthMiddleware)
    async getScreenDiff(appId: UuidString, id: UuidString, screenId: UuidString, user: UserEntity): AnyResponse {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);
        const url = await this.s3Svc.getSignedUrl(this.s3Svc.getPathForDiff(appId, id, screenId));
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
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);

        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();
        if (build.status !== 'needs review') throw new HttpBadRequestError('Build is not in needs review status');

        const buildScreen = await BuildScreenEntity.query().filter({ appId, buildId: id, screenId }).findOneOrUndefined();
        if (!buildScreen) throw new HttpNotFoundError();
        if (buildScreen.status !== 'new' && buildScreen.status !== 'needs review') {
            throw new HttpBadRequestError('Screen is not awaiting review');
        }

        buildScreen.reviewStatus = body.reviewStatus;
        buildScreen.reviewComment = body.comment?.trim() || null;
        buildScreen.reviewedById = user.id;
        buildScreen.reviewedAt = new Date();
        await buildScreen.save();

        return {
            reviewStatus: buildScreen.reviewStatus,
            reviewComment: buildScreen.reviewComment,
            reviewedById: buildScreen.reviewedById,
            reviewedAt: buildScreen.reviewedAt
        };
    }
}
