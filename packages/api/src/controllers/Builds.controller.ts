import { http, HttpBadRequestError, HttpNotFoundError, HttpQueries, HttpRequest, HttpUnauthorizedError } from '@zyno-io/ts-server-foundation';
import { ScopedLogger } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, OkResponse, uuid7, WorkerService } from '@zyno-io/ts-server-foundation';
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

/** A draft older than this is considered abandoned: it may be taken over by a new job or canceled by another build's processing. */
export const STALE_DRAFT_MS = 15 * 60 * 1000;
const MAX_READ_TOKEN_HASHES = 20;
const MAX_DEADLOCK_ATTEMPTS = 3;

export function isDeadlockError(err: unknown): boolean {
    for (let e = err as { code?: string; errno?: number; message?: string; cause?: unknown } | undefined, depth = 0; e && depth < 5; depth++) {
        if (e.errno === 1213 || e.code === 'ER_LOCK_DEADLOCK' || /deadlock found/i.test(e.message ?? '')) return true;
        e = e.cause as typeof e;
    }
    return false;
}
/**
 * Whether a CI job id identifies a single job. GitHub ids are `${run_id}:${check_run_id}`, but fall back to the bare run id
 * (shared by every job in the run) when the OIDC token lacks check_run_id (some GHES versions). GitLab job tokens are
 * unique per job, so the token-hash match already covers GitLab.
 */
function isPerJobId(ciJobId: string): boolean {
    return ciJobId.includes(':');
}

export interface IBuildApprovalResponse {
    vcsUrl: string | false;
    vcsError?: string;
}

/** Responses are serialized as-is, so strip the CI session credential hashes before returning builds to users. */
function omitCiTokenHash(build: BuildEntity) {
    const { ciTokenHash: _ciTokenHash, ciReadTokenHashes: _ciReadTokenHashes, ...rest } = build;
    return rest;
}

/** Adds a read-only (status polling) token hash, de-duplicated and capped to the most recent entries. */
function addReadTokenHash(build: BuildEntity, hash: string) {
    if (build.ciTokenHash === hash) return;
    const current = (build.ciReadTokenHashes ?? []).filter(h => h !== hash);
    build.ciReadTokenHashes = [...current, hash].slice(-MAX_READ_TOKEN_HASHES);
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
    async show(request: HttpRequest, appId: string, id: string): Promise<IBuildBasicResponse> {
        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        // A draft is never reported to pollers (the CLI would treat it as final and exit 0)
        if (build.status === 'draft') return { status: 'processing' };
        // The CLI doesn't know `canceled`; report it as a clean failure
        const reportedStatus: BuildEntity['status'] = build.status === 'canceled' ? 'failed' : build.status;

        // Final status: revoke only the calling session's access (other concurrent jobs may still be polling)
        if (build.status !== 'processing') {
            const callerHash = hashCiToken(request.headers.authorization!.slice(7));
            if (build.ciTokenHash === callerHash) build.ciTokenHash = null;
            else build.ciReadTokenHashes = (build.ciReadTokenHashes ?? []).filter(h => h !== callerHash);
            await build.save();
        }

        return { status: reportedStatus };
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

        // Concurrent creates for an app with no branch row yet can deadlock (gap locks); retry the whole transaction
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.createInTransaction(appId, branchName, commitHash, commitSubject, commitAuthor, ciJobId, ciTokenHash);
            } catch (err) {
                if (attempt >= MAX_DEADLOCK_ATTEMPTS || !isDeadlockError(err)) throw err;
                this.logger.warn(`Build creation deadlocked (attempt ${attempt}); retrying`);
                await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 80));
            }
        }
    }

    private createInTransaction(
        appId: string,
        branchName: string,
        commitHash: string,
        commitSubject: string,
        commitAuthor: string,
        ciJobId: string,
        ciTokenHash: string
    ): Promise<IBuildResponse> {
        return this.db.transaction(async txn => {
            // Lock the branch row so concurrent creates for the same branch serialize
            let branch = await txn.query(BranchEntity).filter({ appId, name: branchName }).forUpdate().findOneOrUndefined();

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

            const existingBuild = await txn.query(BuildEntity).filter({ appId, branchId: branch.id, commitHash }).forUpdate().findOneOrUndefined();
            if (existingBuild) {
                const now = new Date();
                const isDraft = existingBuild.status === 'draft';
                const isStaleDraft = isDraft && now.getTime() - existingBuild.draftActiveAt.getTime() > STALE_DRAFT_MS;
                let reportedStatus: BuildEntity['status'] = existingBuild.status;

                if (isStaleDraft || existingBuild.status === 'canceled' || existingBuild.status === 'failed') {
                    // Abandoned/canceled/failed build: the caller takes over (reviving it) as the uploader and re-uploads
                    await txn.query(BuildScreenEntity).filter({ buildId: existingBuild.id }).deleteMany();
                    existingBuild.status = 'draft';
                    existingBuild.ciTokenHash = ciTokenHash;
                    existingBuild.ciReadTokenHashes = (existingBuild.ciReadTokenHashes ?? []).filter(h => h !== ciTokenHash);
                    existingBuild.ciJobId = ciJobId;
                    existingBuild.draftActiveAt = now;
                    reportedStatus = 'draft';
                } else if (isDraft && (existingBuild.ciTokenHash === ciTokenHash || (isPerJobId(ciJobId) && existingBuild.ciJobId === ciJobId))) {
                    // The uploader itself re-creating (a new CLI run may carry a new token within the same job)
                    existingBuild.ciTokenHash = ciTokenHash;
                    existingBuild.ciReadTokenHashes = (existingBuild.ciReadTokenHashes ?? []).filter(h => h !== ciTokenHash);
                    existingBuild.draftActiveAt = now;
                } else {
                    // Never overwrite the uploader's hash; additional jobs only get status-polling access
                    addReadTokenHash(existingBuild, ciTokenHash);
                    if (isDraft) {
                        // Another job is uploading: the caller must skip upload and poll (ciJobId stays the uploader's)
                        reportedStatus = 'processing';
                    } else if (existingBuild.status === 'processing' || existingBuild.status === 'needs review') {
                        // A re-run attempt gets a new job id; approval must target the latest one.
                        existingBuild.ciJobId = ciJobId;
                    }
                }
                txn.add(existingBuild);
                return {
                    ...omitCiTokenHash(existingBuild),
                    status: reportedStatus,
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
                    ciReadTokenHashes: [],
                    status: 'draft',
                    createdAt: new Date(),
                    draftActiveAt: new Date()
                },
                txn
            );

            return {
                ...omitCiTokenHash(newBuild),
                branchName: branch!.name
            };
        });
    }

    @http.POST(':id/process')
    @http.middleware(BuildCiTokenMiddleware)
    async process(request: HttpRequest, appId: string, id: string): OkResponse {
        const callerHash = hashCiToken((request.headers.authorization ?? '').slice(7));

        // Validation failures are returned from the transaction (not thrown inside it) so a rejected request doesn't roll back anything.
        const rejection = await this.db.transaction(async txn => {
            // Re-check under lock: a takeover may have replaced the uploader (and its screens) since the middleware ran.
            const build = await txn.query(BuildEntity).filter({ id, appId }).forUpdate().findOneOrUndefined();
            if (!build) return new HttpNotFoundError();
            if (build.status !== 'draft') return new HttpBadRequestError('Build is not in draft status');
            if (build.ciTokenHash !== callerHash) return new HttpUnauthorizedError();
            const screenCount = await txn.query(BuildScreenEntity).filter({ buildId: id }).count();
            if (screenCount === 0) return new HttpBadRequestError('Build has no screens');

            await txn
                .query(BuildEntity)
                .filter({ appId, id: { $ne: id }, status: 'draft', draftActiveAt: { $lt: new Date(Date.now() - STALE_DRAFT_MS) } })
                .patchMany({ status: 'canceled' });

            build.status = 'processing';
            txn.add(build);
            return undefined;
        });
        if (rejection) throw rejection;

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

        try {
            const app = await AppEntity.query().filter({ id: appId }).findOne();
            const result = await this.vcsSvc.rerunCiJob(user, app, build.ciJobId);
            return result.ok ? { vcsUrl: result.url } : { vcsUrl: false, vcsError: result.error };
        } catch (err) {
            this.logger.error('Failed to rerun CI job', err);
            return { vcsUrl: false, vcsError: 'Failed to re-run the CI job; please re-run it from your CI provider.' };
        }
    }
}
