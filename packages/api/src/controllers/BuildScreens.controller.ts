import { http, HttpBadRequestError, HttpBody, HttpNotFoundError, Redirect, FileUpload, UuidString } from '@zyno-io/ts-server-foundation';
import { AnyResponse, createPersistedEntity, uuid7 } from '@zyno-io/ts-server-foundation';
import { keyBy, uniq } from 'lodash';

import { BuildCiTokenMiddleware, UserAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { Db } from '../database';
import { AppEntity } from '../entities/App.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { ScreenEntity } from '../entities/Screen.entity';
import { UserEntity } from '../entities/User.entity';
import { AppAccessService } from '../services/AppAccess.service';
import { S3Service } from '../services/S3.service';

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
        private appAccessSvc: AppAccessService
    ) {}

    @http.GET('screens')
    @http.middleware(UserAuthMiddleware)
    async getScreens(appId: UuidString, id: UuidString, user: UserEntity): Promise<IBuildScreenResponse[]> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);

        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        const app = await this.db.query(AppEntity).filter({ id: appId }).findOne();

        const referenceBuild = await BuildEntity.query()
            .filter({ appId: app.id, branchId: app.defaultBranchId, status: 'changes approved', id: { $lt: build.id } })
            .orderBy('id', 'desc')
            .findOneOrUndefined();

        const currentBuildScreens = await BuildScreenEntity.query().filter({ appId, buildId: build.id }).find();

        const referenceBuildScreens = referenceBuild ? await BuildScreenEntity.query().filter({ appId, buildId: referenceBuild.id }).find() : [];

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
        appId: UuidString,
        id: UuidString,
        body: HttpBody<{ image: FileUpload }>
    ): Promise<IBuildScreenCreateResponse | { status: string }> {
        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();
        if (build.status !== 'draft') throw new HttpBadRequestError('build is not in draft state');

        return this.db.transaction(async txn => {
            const screenName = body.image.name?.replace(/\.[^.]+$/, '');

            let screen = await txn.query(ScreenEntity).filter({ appId, name: screenName }).findOneOrUndefined();

            if (!screen) {
                screen = await createPersistedEntity(
                    ScreenEntity,
                    {
                        id: uuid7(),
                        appId,
                        name: screenName
                    },
                    txn
                );
            } else {
                const buildScreen = await txn.query(BuildScreenEntity).filter({ buildId: id, screenId: screen.id }).findOneOrUndefined();
                // Re-upload (e.g. a re-run after a partial failure): replace the earlier upload
                if (buildScreen) await txn.query(BuildScreenEntity).filter({ id: buildScreen.id }).deleteOne();
            }

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

            await this.s3Svc.uploadFile(body.image.path, this.s3Svc.getPathForScreen(appId, id, screen.id), 'image/png');
            await txn.query(BuildEntity).filter({ id }).patchMany({ draftActiveAt: new Date() });

            return {
                ...buildScreen,
                name: screen.name
            };
        });
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
