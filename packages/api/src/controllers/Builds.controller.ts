import { http, HttpBadRequestError, HttpNotFoundError, HttpQueries, HttpRequest, HttpUnauthorizedError } from '@zyno-io/ts-server-foundation';
import { ScopedLogger } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, OkResponse, uuid7, WorkerService } from '@zyno-io/ts-server-foundation';
import axios from 'axios';
import { keyBy, uniq } from 'lodash';

import { BuildCiTokenMiddleware, hashCiToken, UserAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { Db } from '../database';
import { AppEntity } from '../entities/App.entity';
import { BranchEntity } from '../entities/Branch.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { UserEntity } from '../entities/User.entity';
import { ProcessBuildJob } from '../jobs/ProcessBuild.job';
import { AppAccessService } from '../services/AppAccess.service';
import { VcsService } from '../services/Vcs.service';

type IBuildResponse = Pick<BuildEntity, 'id' | 'branchId' | 'commitHash' | 'commitSubject' | 'commitAuthor' | 'createdAt' | 'status'> & {
    branchName: string;
};
type IBuildBasicResponse = Pick<BuildEntity, 'status'>;
interface IBuildApprovalResponse {
    vcsUrl: string | false;
}

/** Responses are serialized as-is, so strip the CI session credential hash before returning builds to users. */
function omitCiTokenHash(build: BuildEntity) {
    const { ciTokenHash: _ciTokenHash, ...rest } = build;
    return rest;
}

@ApiController('/api/apps/:appId/builds')
export class BuildsController {
    constructor(
        private workerSvc: WorkerService,
        private vcsSvc: VcsService,
        private db: Db,
        private logger: ScopedLogger,
        private appAccessSvc: AppAccessService
    ) {}

    @http.GET()
    @http.middleware(UserAuthMiddleware)
    async index(appId: string, user: UserEntity, query: HttpQueries<{ branchId?: string }>): Promise<IBuildResponse[]> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);

        const { branchId } = query;

        const builds = await BuildEntity.query()
            .filter({
                appId,
                status: { $nin: ['draft', 'canceled'] },
                ...(branchId && { branchId })
            })
            .orderBy('createdAt', 'desc')
            .find();

        const branchIds = uniq(builds.map(build => build.branchId));
        const branches = await BranchEntity.query()
            .filter({ id: { $in: branchIds } })
            .select('id', 'name')
            .find();
        const branchMap = keyBy(branches, 'id');

        return builds.map(build => ({
            ...omitCiTokenHash(build),
            branchName: branchMap[build.branchId]?.name ?? ''
        }));
    }

    @http.GET(':id')
    @http.middleware(UserAuthMiddleware)
    async get(appId: string, id: string, user: UserEntity): Promise<IBuildResponse> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);

        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        const branch = await BranchEntity.query().filter({ id: build.branchId }).select('name').findOneOrUndefined();

        return {
            ...omitCiTokenHash(build),
            branchName: branch?.name ?? ''
        };
    }

    @http.GET(':id/status')
    @http.middleware(BuildCiTokenMiddleware)
    async show(appId: string, id: string): Promise<IBuildBasicResponse> {
        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        // Null out the token hash when returning a final status (session is over)
        if (build.status !== 'draft' && build.status !== 'processing') {
            build.ciTokenHash = null;
            await build.save();
        }

        return build;
    }

    @http.POST()
    async create(request: HttpRequest, appId: string): Promise<IBuildResponse> {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            this.logger.warn('Build creation failed: missing or malformed Authorization header');
            throw new HttpUnauthorizedError();
        }
        const ciToken = authHeader.slice(7);

        const app = await AppEntity.query().filter({ id: appId, deletedAt: null }).findOneOrUndefined();
        if (!app) throw new HttpBadRequestError('invalid appId');

        const ciJobData = await this.vcsSvc.validateCiToken(app, ciToken);

        const ciTokenHash = hashCiToken(ciToken);
        const { branch: branchName, commitHash, commitSubject, commitAuthor, jobId: ciJobId } = ciJobData;

        return this.db.transaction(async txn => {
            let branch = await txn.query(BranchEntity).filter({ appId: app.id, name: branchName }).findOneOrUndefined();

            if (!branch) {
                branch = await createPersistedEntity(
                    BranchEntity,
                    {
                        id: uuid7(),
                        appId,
                        name: branchName
                    },
                    txn
                );
            }

            const existingBuild = await txn.query(BuildEntity).filter({ appId, branchId: branch.id, commitHash }).findOneOrUndefined();
            if (existingBuild) {
                // Update the token hash so subsequent calls use the current token
                existingBuild.ciTokenHash = ciTokenHash;
                txn.add(existingBuild);
                return {
                    ...existingBuild,
                    branchName: branch.name
                };
            }

            const newBuild = await createPersistedEntity(
                BuildEntity,
                {
                    id: uuid7(),
                    appId,
                    branchId: branch!.id,
                    commitHash,
                    commitSubject,
                    commitAuthor,
                    ciJobId,
                    ciTokenHash,
                    status: 'draft',
                    createdAt: new Date()
                },
                txn
            );

            return {
                ...newBuild,
                branchName: branch!.name
            };
        });
    }

    @http.POST(':id/process')
    @http.middleware(BuildCiTokenMiddleware)
    async process(appId: string, id: string): OkResponse {
        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        if (build.status !== 'draft') throw new HttpBadRequestError('Build is not in draft status');

        await this.db.transaction(async txn => {
            await txn
                .query(BuildEntity)
                .filter({ appId, id: { $ne: id }, status: 'draft' })
                .patchMany({ status: 'canceled' });

            build.status = 'processing';
            txn.add(build);
        });

        await this.workerSvc.queueJob(ProcessBuildJob, { buildId: id });

        return { ok: true };
    }

    @http.POST(':id/approve')
    @http.middleware(UserAuthMiddleware)
    async approve(user: UserEntity, appId: string, id: string): Promise<IBuildApprovalResponse> {
        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);
        if (build.status !== 'needs review') throw new HttpBadRequestError('Build is not in needs review status');

        let rejected = false;
        await this.db.transaction(async txn => {
            const buildScreens = await txn
                .query(BuildScreenEntity)
                .filter({ appId, buildId: id, status: { $ne: 'no changes' } })
                .find();

            const changedScreens = buildScreens.filter(buildScreen => buildScreen.status === 'new' || buildScreen.status === 'needs review');

            // Unreviewed changed screens are auto-approved on submit.
            const now = new Date();
            for (const buildScreen of changedScreens) {
                if (buildScreen.reviewStatus !== 'approved' && buildScreen.reviewStatus !== 'rejected') {
                    buildScreen.reviewStatus = 'approved';
                    buildScreen.reviewedById = user.id;
                    buildScreen.reviewedAt = now;
                }
            }

            if (changedScreens.some(buildScreen => buildScreen.reviewStatus === 'rejected')) {
                // Any rejection fails the build: record the per-screen decisions but don't promote any
                // screen to a baseline.
                changedScreens.forEach(buildScreen => txn.add(buildScreen));
                build.status = 'changes rejected';
                rejected = true;
            } else {
                buildScreens.forEach(buildScreen => {
                    buildScreen.status = 'changes approved';
                    txn.add(buildScreen);
                });
                build.status = 'changes approved';
                build.approvedById = user.id;
                build.approvedAt = now;
            }

            txn.add(build);
        });

        // A rejected build has already failed its check (the original CI job exited non-zero); there's
        // nothing to re-run, so don't trigger the VCS job.
        if (rejected) {
            return { vcsUrl: false };
        }

        if (process.env.CI) {
            return { vcsUrl: 'integration-test://' };
        }

        try {
            const app = await AppEntity.query().filter({ id: appId }).findOne();
            let vcsUrl: string;
            try {
                vcsUrl = await this.vcsSvc.rerunCiJob(user, app.vcsId, app.projectPath, build.ciJobId);
            } catch (innerErr) {
                if (!axios.isAxiosError(innerErr) || innerErr.response?.status !== 405) throw innerErr;

                // Project may have moved — securely look up current path via GitLab API
                const currentPath = await this.vcsSvc.getProjectPath(user, app.vcsId, app.projectPath);
                if (currentPath === app.projectPath) throw innerErr; // not a move, rethrow

                this.logger.info(`Project moved: "${app.projectPath}" → "${currentPath}"`);
                app.projectPath = currentPath;
                await app.save();

                vcsUrl = await this.vcsSvc.rerunCiJob(user, app.vcsId, currentPath, build.ciJobId);
            }
            return { vcsUrl };
        } catch (err) {
            this.logger.error('Failed to rerun CI job', err);
            return { vcsUrl: false };
        }
    }
}
