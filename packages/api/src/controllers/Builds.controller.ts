import {
    http,
    HttpBadRequestError,
    HttpBody,
    HttpConflictError,
    HttpError,
    HttpNotFoundError,
    HttpQueries,
    HttpRequest,
    HttpUnauthorizedError,
    UuidString
} from '@zyno-io/ts-server-foundation';
import { ScopedLogger } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, OkResponse, uuid7, WorkerService } from '@zyno-io/ts-server-foundation';
import { keyBy, uniq } from 'lodash';

import { BuildCiTokenMiddleware, CI_TOKEN_TTL_MS, hashCiToken, UserAuthMiddleware } from '../accessories/AuthMiddleware.accessory';
import { ApiController } from '../accessories/Controller.accessory';
import { Db } from '../database';
import { AppEntity } from '../entities/App.entity';
import { BranchEntity } from '../entities/Branch.entity';
import { BuildEntity } from '../entities/Build.entity';
import { BuildScreenEntity } from '../entities/BuildScreen.entity';
import { BuildShardEntity } from '../entities/BuildShard.entity';
import { UserEntity } from '../entities/User.entity';
import { ProcessBuildJob } from '../jobs/ProcessBuild.job';
import { RERUN_DEFERRED_NOTICE, RERUN_RETRY_DELAY_MS, RerunCiJobJob } from '../jobs/RerunCiJob.job';
import { IBuildResponse, toBuildResponse } from '../responses/build.response';
import { AppAccessService } from '../services/AppAccess.service';
import { screenManifestHash, uploadedScreenNames } from '../services/ScreenManifest';
import { VcsService } from '../services/Vcs.service';

interface IShardSpec {
    index: number;
    total: number;
}
interface IScreenManifest {
    count: number;
    hash: string;
}
type IBuildBasicResponse = Pick<BuildEntity, 'status'> & {
    /** Sharded drafts only: how many shards have finished uploading. */
    shards?: { uploaded: number; total: number };
};

/** A draft older than this is considered abandoned: it may be taken over by a new job or canceled by another build's processing. */
export const STALE_DRAFT_MS = 15 * 60 * 1000;
export { CI_TOKEN_TTL_MS };
const MAX_MANIFEST_COUNT = 100_000;
const MAX_SHARDS = 64;
const MANIFEST_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_READ_TOKEN_HASHES = 20;
const MAX_DEADLOCK_ATTEMPTS = 3;
/** Sharded drafts are kept alive by status polls, at most this often. */
const DRAFT_KEEPALIVE_MS = 30_000;

export function isDeadlockError(err: unknown): boolean {
    for (let e = err as { code?: string; errno?: number; message?: string; cause?: unknown } | undefined, depth = 0; e && depth < 5; depth++) {
        if (e.code === '40P01' || /deadlock detected/i.test(e.message ?? '')) return true;
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
    /** Informational (non-error) message, e.g. the re-run was deferred until the workflow finishes. */
    vcsNotice?: string;
}

function validateManifest(screens: IScreenManifest | undefined): IScreenManifest | undefined {
    if (screens === undefined) return undefined;
    if (!screens || !Number.isInteger(screens.count) || screens.count < 0 || screens.count > MAX_MANIFEST_COUNT) {
        throw new HttpBadRequestError(`screens.count must be an integer between 0 and ${MAX_MANIFEST_COUNT}`);
    }
    if (typeof screens.hash !== 'string' || !MANIFEST_HASH_RE.test(screens.hash)) {
        throw new HttpBadRequestError('screens.hash must be a 64-character lowercase hex string');
    }
    return { count: screens.count, hash: screens.hash };
}

const RUN_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
function validateRunId(runId: string | undefined): string | undefined {
    if (runId === undefined) return undefined;
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new HttpBadRequestError('runId must be 1-64 characters of [A-Za-z0-9-]');
    return runId;
}

/** Validates `shard`; `total = 1` means unsharded and yields undefined. */
function validateShard(shard: IShardSpec | undefined): IShardSpec | undefined {
    if (shard === undefined) return undefined;
    const { index, total } = shard ?? {};
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > MAX_SHARDS || index < 1 || index > total) {
        throw new HttpBadRequestError(`shard must be { index, total } with integers and 1 <= index <= total <= ${MAX_SHARDS}`);
    }
    return total === 1 ? undefined : { index, total };
}

/** Adds a read-only (status polling) token hash, de-duplicated and capped to the most recent entries. */
function addReadTokenHash(build: BuildEntity, hash: string) {
    if (build.ciTokenHash === hash) return;
    const current = (build.ciReadTokenHashes ?? []).filter(h => h !== hash);
    // A sharded build can have duplicate pipelines for every shard, so its cap scales with the shard count
    const cap = build.shardTotal > 1 ? MAX_READ_TOKEN_HASHES + build.shardTotal * 2 : MAX_READ_TOKEN_HASHES;
    build.ciReadTokenHashes = [...current, hash].slice(-cap);
}

const BUILDS_DEFAULT_PAGE_SIZE = 50;
const BUILDS_MAX_PAGE_SIZE = 200;

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
    async index(
        appId: UuidString,
        user: UserEntity,
        query: HttpQueries<{ branchId?: UuidString; limit?: number; before?: UuidString }>
    ): Promise<IBuildResponse[]> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);

        const { branchId, before } = query;
        const limit = Number.isFinite(query.limit) ? Math.min(Math.max(Math.trunc(query.limit!), 1), BUILDS_MAX_PAGE_SIZE) : BUILDS_DEFAULT_PAGE_SIZE;

        const builds = await BuildEntity.query()
            .filter({
                appId,
                status: { $nin: ['draft', 'canceled'] },
                ...(branchId && { branchId }),
                ...(before && { id: { $lt: before } })
            })
            // uuid7 ids sort the same as createdAt and are unique, so they make a stable keyset cursor
            .orderBy('id', 'desc')
            .limit(limit)
            .find();

        const branchIds = uniq(builds.map(build => build.branchId));
        const branches = await BranchEntity.query()
            .filter({ id: { $in: branchIds } })
            .select('id', 'name')
            .find();
        const branchMap = keyBy(branches, 'id');

        return builds.map(build => toBuildResponse(build, branchMap[build.branchId]?.name ?? ''));
    }

    @http.GET(':id')
    @http.middleware(UserAuthMiddleware)
    async get(appId: UuidString, id: UuidString, user: UserEntity): Promise<IBuildResponse> {
        await this.appAccessSvc.assertCanAccessAppId({ kind: 'user', user }, appId);

        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        const branch = await BranchEntity.query().filter({ id: build.branchId }).select('name').findOneOrUndefined();

        return toBuildResponse(build, branch?.name ?? '');
    }

    @http.GET(':id/status')
    @http.middleware(BuildCiTokenMiddleware)
    async show(appId: UuidString, id: UuidString): Promise<IBuildBasicResponse> {
        const build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();

        // A draft is never reported to pollers (the CLI would treat it as final and exit 0)
        if (build.status === 'draft') {
            if (build.shardTotal > 1) {
                // A sharded draft waits for its slowest shard; pollers (every shard job and its observers) keep it from going stale
                // and being taken over (which would wipe the shards already uploaded). Throttled compare-and-set on the draft.
                if (Date.now() - build.draftActiveAt.getTime() > DRAFT_KEEPALIVE_MS) {
                    await BuildEntity.query().filter({ id, status: 'draft' }).patchOne({ draftActiveAt: new Date() });
                }
                const uploaded = await BuildShardEntity.query().filter({ buildId: id, state: 'uploaded' }).count();
                return { status: 'processing', shards: { uploaded, total: build.shardTotal } };
            }
            return { status: 'processing' };
        }
        // The CLI doesn't know `canceled`; report it as a clean failure
        const reportedStatus: BuildEntity['status'] = build.status === 'canceled' ? 'failed' : build.status;

        return { status: reportedStatus };
    }

    @http.POST()
    async create(
        request: HttpRequest,
        appId: UuidString,
        body?: HttpBody<{
            projectUrl?: string;
            screens?: { count: number; hash: string };
            runId?: string;
            shard?: { index: number; total: number };
        }>
    ): Promise<IBuildResponse> {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            this.logger.warn('Build creation failed: missing or malformed Authorization header');
            throw new HttpUnauthorizedError();
        }
        const ciToken = authHeader.slice(7);
        const manifest = validateManifest(body?.screens);
        const runId = validateRunId(body?.runId);
        const shard = validateShard(body?.shard);
        if (shard && !manifest) throw new HttpBadRequestError('screens (count and hash) are required for a sharded build');

        const app = await AppEntity.query().filter({ id: appId, deletedAt: null }).findOneOrUndefined();
        if (!app) throw new HttpBadRequestError('invalid appId');

        const ciJobData = await this.vcsSvc.validateCiToken(app, ciToken);

        const ciTokenHash = hashCiToken(ciToken);
        const { branch: branchName, commitHash, commitSubject, commitAuthor, jobId: ciJobId } = ciJobData;

        // Creation is serialized per (app, branch) by an advisory lock, but retry the whole transaction on a deadlock anyway
        for (let attempt = 1; ; attempt++) {
            try {
                const result = shard
                    ? await this.createShardedInTransaction(
                          appId,
                          branchName,
                          commitHash,
                          commitSubject,
                          commitAuthor,
                          ciJobId,
                          ciTokenHash,
                          manifest!,
                          runId,
                          shard
                      )
                    : await this.createInTransaction(
                          appId,
                          branchName,
                          commitHash,
                          commitSubject,
                          commitAuthor,
                          ciJobId,
                          ciTokenHash,
                          manifest,
                          runId
                      );
                if (result instanceof HttpError) throw result;
                return result;
            } catch (err) {
                if (attempt >= MAX_DEADLOCK_ATTEMPTS || !isDeadlockError(err)) throw err;
                this.logger.warn(`Build creation deadlocked (attempt ${attempt}); retrying`);
                await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 80));
            }
        }
    }

    private createInTransaction(
        appId: UuidString,
        branchName: string,
        commitHash: string,
        commitSubject: string,
        commitAuthor: string,
        ciJobId: string,
        ciTokenHash: string,
        manifest: IScreenManifest | undefined,
        runId: string | undefined
    ): Promise<IBuildResponse | HttpError> {
        return this.db.transaction(async txn => {
            // Serialize concurrent creates for the same branch. Locking the branch row alone is not enough: under READ COMMITTED,
            // SELECT ... FOR UPDATE on a branch that does not exist yet locks nothing, so two first builds would both insert it.
            await txn.acquireSessionLock(['pixelci:build-create', appId, branchName]);
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
                const expireAt = new Date(now.getTime() + CI_TOKEN_TTL_MS);
                const isDraft = existingBuild.status === 'draft';
                const isStaleDraft = isDraft && now.getTime() - existingBuild.draftActiveAt.getTime() > STALE_DRAFT_MS;
                let reportedStatus: BuildEntity['status'] = existingBuild.status;

                if (isStaleDraft || existingBuild.status === 'canceled' || existingBuild.status === 'failed') {
                    // Abandoned/canceled/failed build: the caller takes over (reviving it) as the uploader and re-uploads
                    if (existingBuild.shardTotal > 1) {
                        await txn.query(BuildShardEntity).filter({ buildId: existingBuild.id }).deleteMany();
                        existingBuild.shardTotal = 1;
                    }
                    await txn.query(BuildScreenEntity).filter({ buildId: existingBuild.id }).deleteMany();
                    existingBuild.ciTokensExpireAt = expireAt;
                    existingBuild.ciRunId = runId ?? null;
                    existingBuild.status = 'draft';
                    existingBuild.ciTokenHash = ciTokenHash;
                    existingBuild.ciReadTokenHashes = (existingBuild.ciReadTokenHashes ?? []).filter(h => h !== ciTokenHash);
                    existingBuild.ciJobId = ciJobId;
                    existingBuild.draftActiveAt = now;
                    existingBuild.manifestCount = manifest?.count ?? null;
                    existingBuild.manifestHash = manifest?.hash ?? null;
                    reportedStatus = 'draft';
                } else if (existingBuild.shardTotal > 1) {
                    return new HttpConflictError(
                        `shard count mismatch: this commit's build is split across ${existingBuild.shardTotal} shards, but this job did not declare PIXELCI_SHARD. ` +
                            `Set PIXELCI_SHARD=<index>/${existingBuild.shardTotal} on every job (see docs).`
                    );
                } else if (isDraft && (existingBuild.ciTokenHash === ciTokenHash || (isPerJobId(ciJobId) && existingBuild.ciJobId === ciJobId))) {
                    // The uploader itself re-creating (a new CLI run may carry a new token within the same job)
                    existingBuild.ciTokenHash = ciTokenHash;
                    existingBuild.ciReadTokenHashes = (existingBuild.ciReadTokenHashes ?? []).filter(h => h !== ciTokenHash);
                    existingBuild.draftActiveAt = now;
                    existingBuild.ciTokensExpireAt = expireAt;
                    // Each CLI run is a clean slate: drop what a previous run of this job uploaded. A repeat of the same run (a late
                    // duplicate of a create the CLI timed out on) must not wipe uploads that have since started.
                    if (!runId || existingBuild.ciRunId !== runId) {
                        await txn.query(BuildScreenEntity).filter({ buildId: existingBuild.id }).deleteMany();
                    }
                    existingBuild.ciRunId = runId ?? null;
                    existingBuild.manifestCount = manifest?.count ?? null;
                    existingBuild.manifestHash = manifest?.hash ?? null;
                } else {
                    if (manifest && existingBuild.manifestHash && manifest.hash !== existingBuild.manifestHash) {
                        // Divergent duplicate: same commit but a different screen set and no shard declared. No read access is granted.
                        return new HttpConflictError(
                            `This job's screenshots (${manifest.count}, ${manifest.hash.slice(0, 12)}) differ from the ones already uploaded for this commit ` +
                                `(${existingBuild.manifestCount}, ${existingBuild.manifestHash.slice(0, 12)}). ` +
                                `If the suite is split across jobs, set PIXELCI_SHARD (see docs).`
                        );
                    }
                    existingBuild.ciTokensExpireAt = expireAt;
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
                return toBuildResponse(existingBuild, branch.name, reportedStatus);
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
                    draftActiveAt: new Date(),
                    ciTokensExpireAt: new Date(Date.now() + CI_TOKEN_TTL_MS),
                    ciRunId: runId ?? null,
                    manifestCount: manifest?.count ?? null,
                    manifestHash: manifest?.hash ?? null
                },
                txn
            );

            return toBuildResponse(newBuild, branch!.name);
        });
    }

    private createShardedInTransaction(
        appId: UuidString,
        branchName: string,
        commitHash: string,
        commitSubject: string,
        commitAuthor: string,
        ciJobId: string,
        ciTokenHash: string,
        manifest: IScreenManifest,
        runId: string | undefined,
        shard: IShardSpec
    ): Promise<IBuildResponse | HttpError> {
        return this.db.transaction(async txn => {
            // Same serialisation and branch upsert as createInTransaction. Lock order everywhere: build row, shard row, screens.
            await txn.acquireSessionLock(['pixelci:build-create', appId, branchName]);
            let branch = await txn.query(BranchEntity).filter({ appId, name: branchName }).forUpdate().findOneOrUndefined();
            if (!branch) {
                branch = await createPersistedEntity(BranchEntity, { id: uuid7(), appId, name: branchName }, txn);
            }

            const registerShard = (buildId: string, now: Date) =>
                createPersistedEntity(
                    BuildShardEntity,
                    {
                        id: uuid7(),
                        buildId,
                        shardIndex: shard.index,
                        ciTokenHash,
                        ciJobId,
                        state: 'uploading',
                        manifestCount: manifest.count,
                        manifestHash: manifest.hash,
                        runId: runId ?? null,
                        activeAt: now
                    },
                    txn
                );

            const existingBuild = await txn.query(BuildEntity).filter({ appId, branchId: branch.id, commitHash }).forUpdate().findOneOrUndefined();
            if (!existingBuild) {
                const now = new Date();
                const newBuild = await createPersistedEntity(
                    BuildEntity,
                    {
                        id: uuid7(),
                        appId,
                        branchId: branch.id,
                        commitHash,
                        commitSubject,
                        commitAuthor,
                        ciJobId,
                        // Sharded builds have no single uploader; each shard row holds its own token
                        ciTokenHash: null,
                        ciReadTokenHashes: [],
                        status: 'draft',
                        createdAt: now,
                        draftActiveAt: now,
                        ciTokensExpireAt: new Date(now.getTime() + CI_TOKEN_TTL_MS),
                        manifestCount: null,
                        manifestHash: null,
                        shardTotal: shard.total
                    },
                    txn
                );
                await registerShard(newBuild.id, now);
                return toBuildResponse(newBuild, branch.name, newBuild.status, shard);
            }

            const now = new Date();
            const expireAt = new Date(now.getTime() + CI_TOKEN_TTL_MS);
            const isDraft = existingBuild.status === 'draft';
            const isStaleDraft = isDraft && now.getTime() - existingBuild.draftActiveAt.getTime() > STALE_DRAFT_MS;
            let reportedStatus: BuildEntity['status'] = existingBuild.status;

            if (isStaleDraft || existingBuild.status === 'canceled' || existingBuild.status === 'failed') {
                // Whole-build takeover: abandoned/canceled/failed. Every shard starts over with the caller's shard count.
                await txn.query(BuildShardEntity).filter({ buildId: existingBuild.id }).deleteMany();
                await txn.query(BuildScreenEntity).filter({ buildId: existingBuild.id }).deleteMany();
                existingBuild.ciTokensExpireAt = expireAt;
                existingBuild.status = 'draft';
                existingBuild.shardTotal = shard.total;
                existingBuild.ciTokenHash = null;
                existingBuild.ciReadTokenHashes = [];
                existingBuild.ciJobId = ciJobId;
                existingBuild.draftActiveAt = now;
                existingBuild.manifestCount = null;
                existingBuild.manifestHash = null;
                await registerShard(existingBuild.id, now);
                reportedStatus = 'draft';
            } else if (existingBuild.shardTotal !== shard.total) {
                return new HttpConflictError(
                    `shard count mismatch: this commit's build is ${existingBuild.shardTotal > 1 ? `split across ${existingBuild.shardTotal} shards` : 'not sharded'}, ` +
                        `but this job declared ${shard.index}/${shard.total}. Every job must set the same PIXELCI_SHARD total.`
                );
            } else {
                const row = await txn
                    .query(BuildShardEntity)
                    .filter({ buildId: existingBuild.id, shardIndex: shard.index })
                    .forUpdate()
                    .findOneOrUndefined();
                const observe = (): HttpError | undefined => {
                    if (row && row.manifestHash !== manifest.hash) {
                        return new HttpConflictError(
                            `This job's screenshots for shard ${shard.index}/${shard.total} (${manifest.count}, ${manifest.hash.slice(0, 12)}) differ from the ones ` +
                                `already uploaded for it (${row.manifestCount}, ${row.manifestHash.slice(0, 12)}). Is another suite running with the same PIXELCI_SHARD?`
                        );
                    }
                    existingBuild.ciTokensExpireAt = expireAt;
                    existingBuild.ciReadTokenHashes = (existingBuild.ciReadTokenHashes ?? []).filter(h => h !== ciTokenHash);
                    addReadTokenHash(existingBuild, ciTokenHash);
                    return undefined;
                };

                if (isDraft) {
                    if (!row) {
                        existingBuild.draftActiveAt = now;
                        existingBuild.ciTokensExpireAt = expireAt;
                        await registerShard(existingBuild.id, now);
                        reportedStatus = 'draft';
                    } else if (
                        row.ciTokenHash === ciTokenHash ||
                        (isPerJobId(ciJobId) && row.ciJobId === ciJobId) ||
                        (row.state === 'uploading' && now.getTime() - row.activeAt.getTime() > STALE_DRAFT_MS)
                    ) {
                        // The shard's own job re-creating, or a takeover of an abandoned shard: clean slate for this shard only
                        // A repeat of the same CLI run (a late duplicate of a create it timed out on) must not wipe uploads that started since.
                        const sameRun = !!runId && row.runId === runId;
                        row.ciTokenHash = ciTokenHash;
                        row.ciJobId = ciJobId;
                        row.activeAt = now;
                        if (!sameRun) {
                            row.state = 'uploading';
                            row.manifestCount = manifest.count;
                            row.manifestHash = manifest.hash;
                            row.runId = runId ?? null;
                            await txn.query(BuildScreenEntity).filter({ buildId: existingBuild.id, shardIndex: shard.index }).deleteMany();
                        }
                        txn.add(row);
                        existingBuild.draftActiveAt = now;
                        existingBuild.ciTokensExpireAt = expireAt;
                        existingBuild.ciReadTokenHashes = (existingBuild.ciReadTokenHashes ?? []).filter(h => h !== ciTokenHash);
                        reportedStatus = 'draft';
                    } else {
                        const err = observe();
                        if (err) return err;
                        existingBuild.draftActiveAt = now;
                        reportedStatus = 'processing';
                    }
                } else {
                    // processing / needs review / final: observers only
                    if (!row) return new HttpConflictError(`shard ${shard.index}/${shard.total} is not part of this build`);
                    const err = observe();
                    if (err) return err;
                    if (existingBuild.status === 'processing' || existingBuild.status === 'needs review') {
                        // A re-run attempt gets a new job id; approval must target the latest one.
                        row.ciJobId = ciJobId;
                        txn.add(row);
                    }
                }
            }
            txn.add(existingBuild);
            return toBuildResponse(existingBuild, branch.name, reportedStatus, shard);
        });
    }

    @http.POST(':id/process')
    @http.middleware(BuildCiTokenMiddleware)
    async process(
        request: HttpRequest,
        appId: UuidString,
        id: UuidString,
        body?: HttpBody<{ screens?: { count: number; hash: string } }>
    ): OkResponse {
        const callerHash = hashCiToken((request.headers.authorization ?? '').slice(7));
        const manifest = validateManifest(body?.screens);

        // Validation failures are returned from the transaction (not thrown inside it) so a rejected request doesn't roll back anything.
        const outcome = await this.db.transaction(async txn => {
            // Re-check under lock: a takeover may have replaced the uploader (and its screens) since the middleware ran.
            const build = await txn.query(BuildEntity).filter({ id, appId }).forUpdate().findOneOrUndefined();
            if (!build) return new HttpNotFoundError();
            // Sharded builds authenticate with the shard's own token (lock order: build, shard, screens)
            let shard: BuildShardEntity | undefined;
            if (build.shardTotal > 1) {
                shard = await txn.query(BuildShardEntity).filter({ buildId: id, ciTokenHash: callerHash }).forUpdate().findOneOrUndefined();
                if (!shard) return new HttpUnauthorizedError();
            } else if (build.ciTokenHash !== callerHash) return new HttpUnauthorizedError();
            if (build.status === 'canceled' || build.status === 'failed') return new HttpBadRequestError('Build is not in draft status');
            // Retry-safe: a repeated process call (lost response) succeeds without re-enqueueing
            if (build.status !== 'draft') return 'already' as const;

            if (shard) {
                // An empty shard (no screens) is fine; the build as a whole must have some
                const names = await uploadedScreenNames(txn, id, shard.shardIndex);
                const expected = manifest ?? { count: shard.manifestCount, hash: shard.manifestHash };
                if (expected.count !== names.length || expected.hash !== screenManifestHash(names)) {
                    return new HttpBadRequestError(
                        `Upload incomplete: the server has ${names.length} screens for shard ${shard.shardIndex}, the CLI uploaded ${expected.count}`
                    );
                }
                build.draftActiveAt = new Date();
                txn.add(build);
                if (shard.state !== 'uploaded') {
                    shard.state = 'uploaded';
                    shard.activeAt = new Date();
                    txn.add(shard);
                }
                const othersUploaded = await txn
                    .query(BuildShardEntity)
                    .filter({ buildId: id, shardIndex: { $ne: shard.shardIndex }, state: 'uploaded' })
                    .count();
                // Still waiting for other shards: this call only records the shard as uploaded
                if (othersUploaded + 1 < build.shardTotal) return 'already' as const;
                if ((await txn.query(BuildScreenEntity).filter({ buildId: id }).count()) === 0)
                    return new HttpBadRequestError('Build has no screens');
            } else {
                const names = await uploadedScreenNames(txn, id);
                if (names.length === 0) return new HttpBadRequestError('Build has no screens');
                if (manifest && (manifest.count !== names.length || manifest.hash !== screenManifestHash(names))) {
                    return new HttpBadRequestError(`Upload incomplete: the server has ${names.length} screens, the CLI uploaded ${manifest.count}`);
                }
            }

            await txn
                .query(BuildEntity)
                .filter({ appId, id: { $ne: id }, status: 'draft', draftActiveAt: { $lt: new Date(Date.now() - STALE_DRAFT_MS) } })
                .patchMany({ status: 'canceled' });

            build.status = 'processing';
            txn.add(build);
            return undefined;
        });
        if (outcome === 'already') return { ok: true };
        if (outcome) throw outcome;

        await this.workerSvc.queueJob(ProcessBuildJob, { buildId: id });

        return { ok: true };
    }

    @http.POST(':id/approve')
    @http.middleware(UserAuthMiddleware)
    async approve(user: UserEntity, appId: UuidString, id: UuidString): Promise<IBuildApprovalResponse> {
        // Authorize before touching the build, so a caller without review rights learns nothing about it.
        await this.appAccessSvc.assertCanReviewAppId(user, appId);
        let build = await BuildEntity.query().filter({ id, appId }).findOneOrUndefined();
        if (!build) throw new HttpNotFoundError();
        if (build.status !== 'needs review') throw new HttpBadRequestError('Build is not in needs review status');

        let rejected = false;
        await this.db.transaction(async txn => {
            // Re-check under lock so concurrent approvals can't both flip the build (and both trigger a re-run).
            const locked = await txn.query(BuildEntity).filter({ id, appId }).forUpdate().findOneOrUndefined();
            if (!locked || locked.status !== 'needs review') throw new HttpBadRequestError('Build is not in needs review status');
            build = locked;

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
            if (build.shardTotal > 1) return await this.rerunShardedBuild(user, app, build);
            const result = await this.vcsSvc.rerunCiJob(user, app, build.ciJobId);
            if (result.ok) return { vcsUrl: result.url };
            if (result.deferred) {
                await this.workerSvc.queueJob(
                    RerunCiJobJob,
                    { buildId: build.id, userId: user.id, ciJobId: build.ciJobId, runAttempt: result.runAttempt, attempt: 1 },
                    { delay: RERUN_RETRY_DELAY_MS }
                );
                return { vcsUrl: result.url, vcsNotice: RERUN_DEFERRED_NOTICE };
            }
            return { vcsUrl: false, vcsError: result.error };
        } catch (err) {
            this.logger.error('Failed to rerun CI job', err);
            return { vcsUrl: false, vcsError: 'Failed to re-run the CI job; please re-run it from your CI provider.' };
        }
    }

    /** Re-runs every CI job of a sharded build (one request per target; GitHub collapses a run's jobs to the run). */
    private async rerunShardedBuild(user: UserEntity, app: AppEntity, build: BuildEntity): Promise<IBuildApprovalResponse> {
        const shards = await BuildShardEntity.query().filter({ buildId: build.id }).orderBy('shardIndex', 'asc').find();
        const targets = await this.vcsSvc.getRerunTargets(
            app,
            shards.map(shard => shard.ciJobId)
        );
        if (!targets.length) targets.push(build.ciJobId);

        let vcsUrl: string | false = false;
        let notice: string | undefined;
        const errors: string[] = [];
        for (const target of targets) {
            const result = await this.vcsSvc.rerunCiJob(user, app, target);
            if (result.ok) {
                vcsUrl ||= result.url;
            } else if (result.deferred) {
                await this.workerSvc.queueJob(
                    RerunCiJobJob,
                    { buildId: build.id, userId: user.id, ciJobId: target, runAttempt: result.runAttempt, attempt: 1 },
                    { delay: RERUN_RETRY_DELAY_MS }
                );
                vcsUrl ||= result.url;
                notice = RERUN_DEFERRED_NOTICE;
            } else {
                errors.push(result.error);
            }
        }
        // A partial failure comes back as a notice: the UI shows vcsError only when no job was re-run at all
        const rerun = targets.length - errors.length;
        const partial =
            errors.length && vcsUrl
                ? `Re-ran ${rerun} of ${targets.length} shard jobs; the rest could not be re-run: ${errors.join(' ')}`
                : undefined;
        return {
            vcsUrl,
            ...(errors.length && !vcsUrl && { vcsError: errors.join(' ') }),
            ...((notice || partial) && { vcsNotice: [partial, notice].filter(Boolean).join(' ') })
        };
    }
}
