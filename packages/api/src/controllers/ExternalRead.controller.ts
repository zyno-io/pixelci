import { http, HttpNotFoundError, HttpQueries, HttpRequest, HttpUnauthorizedError, Redirect } from '@zyno-io/ts-server-foundation';
import { AnyResponse } from '@zyno-io/ts-server-foundation';
import { keyBy, uniq } from 'lodash';

import { getVcsAuthContext, VcsTokenAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { AppEntity } from '../entities/App.entity';
import { BranchEntity } from '../entities/Branch.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { ScreenEntity } from '../entities/Screen.entity';
import { UserEntity } from '../entities/User.entity';
import { AppAccessService, IAppAccessPrincipal } from '../services/AppAccess.service';
import { S3Service } from '../services/S3.service';

export type IExtAppResponse = { id: string; name: string };

export type IExtBuildResponse = {
    id: string;
    branchName: string;
    commitHash: string;
    commitSubject: string;
    commitAuthor: string;
    status: BuildEntity['status'];
    createdAt: Date;
    approvedByName: string | null;
    approvedAt: Date | null;
};

export type IExtBuildScreenResponse = {
    screenId: string;
    name: string;
    status: BuildScreenEntity['status'];
    reviewStatus: BuildScreenEntity['reviewStatus'];
    reviewComment: string | null;
    reviewedByName: string | null;
    reviewedAt: Date | null;
};

export type IExtBuildDetailResponse = IExtBuildResponse & {
    screens: IExtBuildScreenResponse[];
};

/**
 * Read-only API surface for programmatic consumers (e.g. the MCP server), authenticated with a
 * VCS personal access token. Intentionally separate from the user (JWT) controllers so a
 * token can only ever read — never approve, reject, or comment. Every app is additionally gated by
 * whether the caller's token can access its project in the VCS provider.
 */
@http.controller('/api/ext')
@http.middleware(VcsTokenAuthMiddleware)
export class ExternalReadController {
    constructor(
        private s3Svc: S3Service,
        private appAccessSvc: AppAccessService
    ) {}

    @http.GET('apps')
    async listApps(request: HttpRequest): Promise<IExtAppResponse[]> {
        const apps = await AppEntity.query().filter({ deletedAt: null }).orderBy('name').find();
        const accessibleApps = await this.appAccessSvc.filterAccessible(this.principal(request), apps);
        return accessibleApps.map(app => ({ id: app.id, name: app.name }));
    }

    @http.GET('apps/:appId/builds')
    async listBuilds(appId: string, request: HttpRequest, query: HttpQueries<{ branchId?: string; limit?: number }>): Promise<IExtBuildResponse[]> {
        await this.appAccessSvc.assertCanAccessAppId(this.principal(request), appId);

        const builds = await BuildEntity.query()
            .filter({
                appId,
                status: { $nin: ['draft', 'canceled'] },
                ...(query.branchId && { branchId: query.branchId })
            })
            .orderBy('createdAt', 'desc')
            .limit(Math.min(query.limit ?? 50, 200))
            .find();

        return this.denormalizeBuilds(builds);
    }

    @http.GET('apps/:appId/builds/:buildId')
    async getBuild(appId: string, buildId: string, request: HttpRequest): Promise<IExtBuildDetailResponse> {
        await this.appAccessSvc.assertCanAccessAppId(this.principal(request), appId);

        const build = await BuildEntity.query()
            .filter({ id: buildId, appId, status: { $nin: ['draft', 'canceled'] } })
            .findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        const [denormalizedBuild] = await this.denormalizeBuilds([build]);

        const buildScreens = await BuildScreenEntity.query().filter({ appId, buildId }).find();

        const screens = await ScreenEntity.query()
            .filter({ id: { $in: buildScreens.map(buildScreen => buildScreen.screenId) } })
            .select('id', 'name')
            .find();
        const screensById = keyBy(screens, 'id');

        const reviewerIds = uniq(buildScreens.map(buildScreen => buildScreen.reviewedById).filter((id): id is string => !!id));
        const reviewers = await UserEntity.query()
            .filter({ id: { $in: reviewerIds } })
            .select('id', 'name')
            .find();
        const reviewersById = keyBy(reviewers, 'id');

        const screenResponses: IExtBuildScreenResponse[] = buildScreens
            .map(buildScreen => ({
                screenId: buildScreen.screenId,
                name: screensById[buildScreen.screenId]?.name ?? '',
                status: buildScreen.status,
                reviewStatus: buildScreen.reviewStatus,
                reviewComment: buildScreen.reviewComment,
                reviewedByName: buildScreen.reviewedById ? (reviewersById[buildScreen.reviewedById]?.name ?? null) : null,
                reviewedAt: buildScreen.reviewedAt
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        return { ...denormalizedBuild, screens: screenResponses };
    }

    @http.GET('apps/:appId/builds/:buildId/screens/:screenId/image')
    async getScreenImage(
        appId: string,
        buildId: string,
        screenId: string,
        request: HttpRequest,
        query: HttpQueries<{ kind?: 'new' | 'diff' }>
    ): AnyResponse {
        await this.appAccessSvc.assertCanAccessAppId(this.principal(request), appId);

        const build = await BuildEntity.query()
            .filter({ id: buildId, appId, status: { $nin: ['draft', 'canceled'] } })
            .findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        const buildScreen = await BuildScreenEntity.query().filter({ appId, buildId, screenId }).findOneOrUndefined();
        if (!buildScreen) throw new HttpNotFoundError();

        const storageBuildId = buildScreen.matchedBuildId ?? buildScreen.buildId;
        const path =
            query.kind === 'diff'
                ? this.s3Svc.getPathForDiff(appId, storageBuildId, screenId)
                : this.s3Svc.getPathForScreen(appId, storageBuildId, screenId);

        const url = await this.s3Svc.getSignedUrl(path);
        return Redirect.toUrl(url);
    }

    private principal(request: HttpRequest): IAppAccessPrincipal {
        const ctx = getVcsAuthContext(request);
        if (!ctx) throw new HttpUnauthorizedError();
        return { kind: 'token', token: ctx.token, vcsId: ctx.vcsId };
    }

    private async denormalizeBuilds(builds: BuildEntity[]): Promise<IExtBuildResponse[]> {
        const branchIds = uniq(builds.map(build => build.branchId));
        const branches = await BranchEntity.query()
            .filter({ id: { $in: branchIds } })
            .select('id', 'name')
            .find();
        const branchesById = keyBy(branches, 'id');

        const approverIds = uniq(builds.map(build => build.approvedById).filter((id): id is string => !!id));
        const approvers = await UserEntity.query()
            .filter({ id: { $in: approverIds } })
            .select('id', 'name')
            .find();
        const approversById = keyBy(approvers, 'id');

        return builds.map(build => ({
            id: build.id,
            branchName: branchesById[build.branchId]?.name ?? '',
            commitHash: build.commitHash,
            commitSubject: build.commitSubject,
            commitAuthor: build.commitAuthor,
            status: build.status,
            createdAt: build.createdAt,
            approvedByName: build.approvedById ? (approversById[build.approvedById]?.name ?? null) : null,
            approvedAt: build.approvedAt
        }));
    }
}
