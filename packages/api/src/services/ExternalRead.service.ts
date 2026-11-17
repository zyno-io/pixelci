import { HttpNotFoundError } from '@zyno-io/ts-server-foundation';
import { keyBy, uniq } from 'lodash';

import { AppEntity } from '../entities/App.entity';
import { BranchEntity } from '../entities/Branch.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { ScreenEntity } from '../entities/Screen.entity';
import { UserEntity } from '../entities/User.entity';
import { AppAccessService, IAppAccessPrincipal } from './AppAccess.service';
import { IMaskRect } from './Mask';
import { S3Service } from './S3.service';

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

/** A region ignored when a screen was compared: x/y from the top-left, in screenshot pixels. */
export type IExtMask = Omit<IMaskRect, 'id'>;

export type IExtBuildScreenResponse = {
    screenId: string;
    name: string;
    status: BuildScreenEntity['status'];
    removed: boolean;
    reviewStatus: BuildScreenEntity['reviewStatus'];
    reviewComment: string | null;
    reviewedByName: string | null;
    reviewedAt: Date | null;
    /** Regions ignored when this screen was compared; null for builds processed before masks existed. */
    appliedMasks: IExtMask[] | null;
};

export type IExtBuildDetailResponse = IExtBuildResponse & {
    screens: IExtBuildScreenResponse[];
};

/**
 * Read-only queries shared by the /api/ext REST controller and the MCP endpoint. Every method is
 * gated by whether the principal can access the app's project in the VCS provider.
 */
export class ExternalReadService {
    constructor(
        private s3Svc: S3Service,
        private appAccessSvc: AppAccessService
    ) {}

    async listApps(principal: IAppAccessPrincipal): Promise<IExtAppResponse[]> {
        const apps = await AppEntity.query().filter({ deletedAt: null }).orderBy('name').find();
        const accessibleApps = await this.appAccessSvc.filterAccessible(principal, apps);
        return accessibleApps.map(app => ({ id: app.id, name: app.name }));
    }

    async listBuilds(principal: IAppAccessPrincipal, appId: string, query: { branchId?: string; limit?: number } = {}): Promise<IExtBuildResponse[]> {
        await this.appAccessSvc.assertCanAccessAppId(principal, appId);

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

    async getBuild(principal: IAppAccessPrincipal, appId: string, buildId: string): Promise<IExtBuildDetailResponse> {
        await this.appAccessSvc.assertCanAccessAppId(principal, appId);

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
                removed: buildScreen.isRemoved,
                reviewStatus: buildScreen.reviewStatus,
                reviewComment: buildScreen.reviewComment,
                reviewedByName: buildScreen.reviewedById ? (reviewersById[buildScreen.reviewedById]?.name ?? null) : null,
                reviewedAt: buildScreen.reviewedAt,
                appliedMasks: buildScreen.appliedMasks?.map(({ x, y, width, height, label }) => ({ x, y, width, height, label })) ?? null
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        return { ...denormalizedBuild, screens: screenResponses };
    }

    /** Resolves the storage path of a screen's image after access and existence checks. */
    async getScreenImagePath(
        principal: IAppAccessPrincipal,
        appId: string,
        buildId: string,
        screenId: string,
        kind: 'new' | 'diff' = 'new'
    ): Promise<string> {
        await this.appAccessSvc.assertCanAccessAppId(principal, appId);

        const build = await BuildEntity.query()
            .filter({ id: buildId, appId, status: { $nin: ['draft', 'canceled'] } })
            .findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        const buildScreen = await BuildScreenEntity.query().filter({ appId, buildId, screenId, isRemoved: false }).findOneOrUndefined();
        if (!buildScreen) throw new HttpNotFoundError();

        const storageBuildId = buildScreen.matchedBuildId ?? buildScreen.buildId;
        return kind === 'diff'
            ? this.s3Svc.getPathForDiff(appId, storageBuildId, screenId)
            : this.s3Svc.getPathForScreen(appId, storageBuildId, screenId);
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
