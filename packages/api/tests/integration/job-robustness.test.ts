import { HttpRequest, ScopedLogger } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, TestingHelpers, uuid7, WorkerService } from '@zyno-io/ts-server-foundation';
import { readdirSync, readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { mock } from 'node:test';

import { CoreAppOptions } from '../../src/app';
import { Db } from '../../src/database';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { ProcessBuildJob } from '../../src/jobs/ProcessBuild.job';
import { ReapStuckBuildsJob } from '../../src/jobs/ReapStuckBuilds.job';
import { claimBuildLease, Lease } from '../../src/services/BuildProcessingLease';
import { S3Service } from '../../src/services/S3.service';
import { sealIntegrationConfig, sealVcsSession } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_jobstest';

configureTestDatabase();

const APP_ID = 'f3234567-aaaa-bbbb-cccc-000000000001';
const BRANCH_ID = 'f3234567-aaaa-bbbb-cccc-000000000002';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const PROJECT_PATH = 'group/jobs-test';

interface IJob {
    id: number;
    ref: string;
    sha: string;
}
const jobs = new Map<string, IJob>();
let mockServer: Server;
let mockPort: number;

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;
const FIXTURE = readFileSync(`${__dirname}/fixtures/${findFixture()}`);

function findFixture() {
    return readdirSync(`${__dirname}/fixtures`).find(f => f.endsWith('.png'));
}

run()
    .then(() => {
        console.log('\nAll job robustness tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function startMock(): Promise<void> {
    return new Promise(resolve => {
        mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            const job = jobs.get(req.headers['job-token'] as string);
            if (req.url === '/api/v4/job') {
                if (!job) {
                    res.writeHead(401);
                    res.end('Unauthorized');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        id: job.id,
                        ref: job.ref,
                        pipeline: { project_id: 1, sha: job.sha },
                        commit: { title: 'test commit', author_name: 'Test Author' }
                    })
                );
                return;
            }
            if (req.url?.startsWith('/api/v4/projects/')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: 1, path_with_namespace: PROJECT_PATH }));
                return;
            }
            res.writeHead(404);
            res.end('Not found');
        });
        mockServer.listen(0, () => {
            mockPort = (mockServer.address() as { port: number }).port;
            resolve();
        });
    });
}

let counter = 0;
function newJob(ref: string) {
    counter++;
    const t = `tok-s-${counter}`;
    jobs.set(t, { id: counter * 10, ref, sha: counter.toString(16).padStart(40, '0') });
    return t;
}

const auth = (r: HttpRequest, token: string) => r.header('authorization', `Bearer ${token}`);
const create = (f: Facade, token: string) => f.request(auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds`), token));
const proc = (f: Facade, id: string, token: string) => f.request(auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id}/process`), token));
const upload = (f: Facade, id: string, token: string, name: string) =>
    f.request(
        auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id}/screens`), token).multiPart([
            { name: 'image', file: FIXTURE, fileName: `${name}.png` }
        ])
    );

const getBuild = (id: string) => BuildEntity.query().filter({ id }).findOne();
const patch = (id: string, p: Parameters<ReturnType<typeof BuildEntity.query>['patchOne']>[0]) => BuildEntity.query().filter({ id }).patchOne(p);
const ago = (ms: number) => new Date(Date.now() - ms);
const MIN = 60_000;

// queueJob is intercepted so nothing reaches Redis/BullMQ: jobs are captured and run by hand, deterministically.
type Queued = { jobClass: unknown; data: { buildId: string } };
let queued: Queued[] = [];
let queueBehavior: 'capture' | 'throwOnce' = 'capture';

/** Creates a draft build with one uploaded screen. Returns the build id and its CI token. */
async function newBuildWithScreen(f: Facade) {
    const token = newJob('main');
    const res = await create(f, token);
    assert(res.statusCode === 200, `create: ${res.statusCode} ${res.body}`);
    const id = res.json.id as string;
    const up = await upload(f, id, token, 'screen-1');
    assert(up.statusCode === 200, `upload: ${up.statusCode} ${up.body}`);
    return { id, token };
}

/** Moves a build into `processing` the way the process endpoint does, but without enqueueing anything. */
async function startProcessing(id: string, overrides: Parameters<typeof patch>[1] = {}) {
    const now = new Date();
    await patch(id, {
        status: 'processing',
        processingStartedAt: now,
        processingHeartbeatAt: now,
        processingAttemptId: null,
        processingAttempts: 0,
        ...overrides
    });
}

async function run() {
    await startMock();
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_jobstest',
        useSavepoints: false
    });
    await facade.start();

    await createPersistedEntity(UserEntity, {
        id: ZERO_ID,
        name: 'Jobs Test User',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: true,
        vcsId: ZERO_ID,
        vcsUserId: ZERO_ID,
        vcsSession: sealVcsSession({
            accessToken: 'test-access-token',
            expiresAt: Date.now() + 60 * 60 * 1000,
            refreshToken: 'test-refresh-token',
            redirectUri: 'http://localhost'
        })
    });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: ZERO_ID,
        name: 'Jobs Test VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({ url: `http://127.0.0.1:${mockPort}`, clientId: 'client-id', clientSecret: 'client-secret' })
    });
    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'Jobs Test App',
        defaultBranchId: BRANCH_ID,
        projectPath: PROJECT_PATH,
        vcsProjectId: 1,
        vcsId: ZERO_ID
    });
    await createPersistedEntity(BranchEntity, { id: BRANCH_ID, appId: APP_ID, name: 'main' });

    mock.method(WorkerService.prototype, 'queueJob', async (jobClass: unknown, data: { buildId: string }) => {
        if (queueBehavior === 'throwOnce') {
            queueBehavior = 'capture';
            throw new Error('simulated enqueue failure');
        }
        queued.push({ jobClass, data });
        return undefined;
    });

    const processJob = facade.get<ProcessBuildJob>(ProcessBuildJob);
    const reaper = facade.get<ReapStuckBuildsJob>(ReapStuckBuildsJob);
    const runProcess = (buildId: string) => processJob.handle({ buildId });

    // A reference build, so later builds actually diff their screens against it (and hit S3).
    {
        const ref = await newBuildWithScreen(facade);
        await startProcessing(ref.id);
        await runProcess(ref.id);
        const done = await getBuild(ref.id);
        assert(done.status === 'needs review', `reference build: ${done.status}`);
        assert(done.processingAttemptId === null && done.processingHeartbeatAt === null, 'reference build lease cleared');
        await patch(ref.id, { status: 'changes approved' });
    }

    await testDeadAttempt(facade, runProcess, reaper);
    await testFencing(facade, runProcess, reaper);
    await testLostEnqueue(facade, runProcess, reaper);
    await testGiveUp(facade, reaper);
    await testNullStartedAtIgnored(facade, reaper);
    await testConcurrentClaims(facade, runProcess);
    await testNotClaimable(facade, runProcess);
    await testClaimBackfillsStartedAt(facade, runProcess);

    mockServer.close();
}

type RunProcess = (buildId: string) => Promise<unknown>;

async function testDeadAttempt(f: Facade, runProcess: RunProcess, reaper: ReapStuckBuildsJob) {
    console.log('\nTest 1: dead attempt is reaped, re-enqueued and completed');
    const { id } = await newBuildWithScreen(f);
    await startProcessing(id, {
        processingStartedAt: ago(5 * MIN),
        processingHeartbeatAt: ago(5 * MIN),
        processingAttemptId: uuid7(),
        processingAttempts: 1
    });
    queued = [];
    await reaper.handle();
    assert(
        queued.some(q => q.data.buildId === id),
        'reaper re-enqueued the build'
    );
    const mid = await getBuild(id);
    assert(mid.status === 'processing' && mid.processingAttemptId === null, 'attempt revoked, still processing');
    await runProcess(id);
    const done = await getBuild(id);
    assert(done.status === 'no changes', `completed, got ${done.status}`);
    assert(done.processingAttempts === 2, `attempts 2, got ${done.processingAttempts}`);
    assert(done.processingAttemptId === null && done.processingHeartbeatAt === null, 'lease cleared');
    console.log('  PASS');
}

/**
 * Runs attempt A of a fresh build until its first S3 read (gated), then has the reaper revoke A's lease, lets `takeover` change
 * the build, and finally releases A (resolving, or rejecting with a non-lease error). Returns the build id and A's outcome.
 */
async function gatedAttempt(
    f: Facade,
    runProcess: RunProcess,
    reaper: ReapStuckBuildsJob,
    finish: 'resolve' | 'reject',
    takeover: (id: string) => Promise<void>
) {
    const { id } = await newBuildWithScreen(f);
    await startProcessing(id);

    const heartbeat = mock.method(Lease.prototype, 'startHeartbeat', () => undefined); // A "stalls": no heartbeats
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let entered = false;
    let gated = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = S3Service.prototype.getBuffer as (...a: any[]) => Promise<Buffer>;
    const getBuffer = mock.method(S3Service.prototype, 'getBuffer', async function (this: S3Service, ...args: unknown[]) {
        if (!gated) {
            gated = true;
            entered = true;
            await gate;
            if (finish === 'reject') throw new Error('simulated S3 failure in revoked attempt');
        }
        return original.apply(this, args);
    });

    let outcome: { threw: boolean } | undefined;
    try {
        const pA = runProcess(id).then(
            () => ({ threw: false }),
            () => ({ threw: true })
        );
        for (let i = 0; i < 200 && !entered; i++) await new Promise(r => setTimeout(r, 25));
        assert(entered, 'attempt A reached the gated S3 read');
        const a = await getBuild(id);
        assert(a.processingAttemptId !== null && a.processingAttempts === 1, 'A holds the lease');

        await patch(id, { processingHeartbeatAt: ago(5 * MIN) });
        queued = [];
        await reaper.handle();
        assert(
            queued.some(q => q.data.buildId === id),
            'reaper re-enqueued the build'
        );
        await takeover(id);

        release();
        outcome = await pA;
    } finally {
        release();
        getBuffer.mock.restore();
        heartbeat.mock.restore();
    }
    return { id, outcome };
}

async function testFencing(f: Facade, runProcess: RunProcess, reaper: ReapStuckBuildsJob) {
    console.log('\nTest 2a: a revoked attempt cannot overwrite a build that attempt B already finished');
    {
        const { id, outcome } = await gatedAttempt(f, runProcess, reaper, 'resolve', async id => {
            await runProcess(id); // attempt B completes
            const b = await getBuild(id);
            assert(b.status === 'no changes' && b.processingAttempts === 2, `B completed: ${b.status}/${b.processingAttempts}`);
            // Make the state distinguishable from anything A would write.
            await patch(id, { status: 'changes rejected' });
        });
        assert(outcome && !outcome.threw, 'A returns quietly');
        const after = await getBuild(id);
        assert(after.status === 'changes rejected', `A must not write the final status, got ${after.status}`);
        assert(after.processingAttempts === 2, 'A did not touch the lease columns');
    }

    console.log('Test 2b: a revoked attempt cannot write while a newer attempt holds the lease');
    {
        let bAttempt = '';
        const { id, outcome } = await gatedAttempt(f, runProcess, reaper, 'resolve', async id => {
            const lease = await claimBuildLease(f.get(Db), id, f.get(ScopedLogger));
            assert(lease, 'B claimed');
            bAttempt = lease.attemptId;
        });
        assert(outcome && !outcome.threw, 'A returns quietly');
        const after = await getBuild(id);
        assert(
            after.status === 'processing' && after.processingAttemptId === bAttempt,
            `A must not write (status ${after.status}, attempt ${after.processingAttemptId})`
        );
        await patch(id, { status: 'canceled' });
    }

    console.log('Test 2c: a revoked attempt that errors cannot mark the build failed');
    {
        let bAttempt = '';
        const { id, outcome } = await gatedAttempt(f, runProcess, reaper, 'reject', async id => {
            const lease = await claimBuildLease(f.get(Db), id, f.get(ScopedLogger));
            assert(lease, 'B claimed');
            bAttempt = lease.attemptId;
        });
        assert(outcome?.threw === true, 'A rethrows its non-lease error');
        const after = await getBuild(id);
        assert(after.status === 'processing' && after.processingAttemptId === bAttempt, `A must not fail the build (status ${after.status})`);
        await patch(id, { status: 'canceled' });
    }
    console.log('  PASS');
}

async function testLostEnqueue(f: Facade, runProcess: RunProcess, reaper: ReapStuckBuildsJob) {
    console.log('\nTest 3: a lost enqueue is recovered by the reaper');
    const { id, token } = await newBuildWithScreen(f);
    queued = [];
    queueBehavior = 'throwOnce';
    const res = await proc(f, id, token);
    assert(res.statusCode === 200, `process returned ${res.statusCode}: ${res.body}`);
    assert(queued.length === 0, 'nothing was enqueued');
    const b = await getBuild(id);
    assert(b.status === 'processing' && b.processingStartedAt && b.processingHeartbeatAt, 'build is processing with lease clock set');
    assert(b.processingAttemptId === null && b.processingAttempts === 0, 'no attempt yet');

    await patch(id, { processingHeartbeatAt: ago(5 * MIN) });
    await reaper.handle();
    assert(
        queued.some(q => q.data.buildId === id),
        'reaper re-enqueued the build'
    );
    await runProcess(id);
    assert((await getBuild(id)).status === 'no changes', 'build completed');
    console.log('  PASS');
}

async function testGiveUp(f: Facade, reaper: ReapStuckBuildsJob) {
    console.log('\nTest 4: attempt limit and hard time cap fail the build');
    const a = await newBuildWithScreen(f);
    await startProcessing(a.id, { processingHeartbeatAt: ago(5 * MIN), processingAttemptId: uuid7(), processingAttempts: 3 });
    const b = await newBuildWithScreen(f);
    await startProcessing(b.id, {
        processingStartedAt: ago(120 * MIN),
        processingHeartbeatAt: new Date(),
        processingAttemptId: uuid7(),
        processingAttempts: 1
    });
    queued = [];
    await reaper.handle();
    for (const [label, id] of [
        ['attempt limit', a.id],
        ['hard cap', b.id]
    ]) {
        const row = await getBuild(id);
        assert(row.status === 'failed', `${label}: expected failed, got ${row.status}`);
        assert(row.processingAttemptId === null && row.processingHeartbeatAt === null, `${label}: lease cleared`);
        assert(!queued.some(q => q.data.buildId === id), `${label}: not re-enqueued`);
    }
    console.log('  PASS');
}

async function testNullStartedAtIgnored(f: Facade, reaper: ReapStuckBuildsJob) {
    console.log('\nTest 5: rows without processingStartedAt are untouched');
    const { id } = await newBuildWithScreen(f);
    await patch(id, {
        status: 'processing',
        processingStartedAt: null,
        processingHeartbeatAt: null,
        processingAttemptId: null,
        processingAttempts: 0
    });
    queued = [];
    await reaper.handle();
    const row = await getBuild(id);
    assert(row.status === 'processing' && row.processingAttempts === 0 && row.processingHeartbeatAt === null, 'row untouched');
    assert(!queued.some(q => q.data.buildId === id), 'not re-enqueued');
    await patch(id, { status: 'canceled' });
    console.log('  PASS');
}

async function testConcurrentClaims(f: Facade, runProcess: RunProcess) {
    console.log('\nTest 6: two concurrent runs claim once');
    const { id } = await newBuildWithScreen(f);
    await startProcessing(id);
    const heartbeat = mock.method(Lease.prototype, 'startHeartbeat'); // pass-through spy: one call per successful claim
    try {
        await Promise.all([runProcess(id), runProcess(id)]);
        assert(heartbeat.mock.callCount() === 1, `exactly one claim, got ${heartbeat.mock.callCount()}`);
    } finally {
        heartbeat.mock.restore();
    }
    const row = await getBuild(id);
    assert(row.status === 'no changes', `completed: ${row.status}`);
    assert(row.processingAttempts === 1, `exactly one claim, got ${row.processingAttempts}`);

    // A live lease is not claimable either.
    const live = await newBuildWithScreen(f);
    await startProcessing(live.id, { processingAttemptId: uuid7(), processingAttempts: 1 });
    await runProcess(live.id);
    const lrow = await getBuild(live.id);
    assert(lrow.status === 'processing' && lrow.processingAttempts === 1, 'live lease refused');
    await patch(live.id, { status: 'canceled' });
    console.log('  PASS');
}

async function testNotClaimable(f: Facade, runProcess: RunProcess) {
    console.log('\nTest 7: a job for a non-processing build is a no-op');
    const { id } = await newBuildWithScreen(f); // draft
    await runProcess(id);
    const row = await getBuild(id);
    assert(row.status === 'draft' && row.processingAttempts === 0 && row.processingAttemptId === null, 'draft untouched');
    console.log('  PASS');
}

async function testClaimBackfillsStartedAt(f: Facade, runProcess: RunProcess) {
    console.log('\nTest 8: claiming a build set to processing by an old pod backfills processingStartedAt');
    const { id } = await newBuildWithScreen(f);
    await patch(id, {
        status: 'processing',
        processingStartedAt: null,
        processingHeartbeatAt: null,
        processingAttemptId: null,
        processingAttempts: 0
    });
    const lease = await claimBuildLease(f.get(Db), id, f.get(ScopedLogger));
    assert(lease, 'claimed');
    assert((await getBuild(id)).processingStartedAt !== null, 'processingStartedAt set');
    await patch(id, { processingAttemptId: null });
    await runProcess(id);
    assert((await getBuild(id)).status === 'no changes', 'completed');
    console.log('  PASS');
}
