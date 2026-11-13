import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, TestingHelpers, WorkerService } from '@zyno-io/ts-server-foundation';
import { readdirSync, readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { CoreAppOptions } from '../../src/app';
import { STALE_DRAFT_MS } from '../../src/controllers/Builds.controller';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';
import { BuildShardEntity } from '../../src/entities/BuildShard.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { ProcessBuildJob } from '../../src/jobs/ProcessBuild.job';
import { screenManifestHash } from '../../src/services/ScreenManifest';
import { sealIntegrationConfig, sealVcsSession } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

const APP_ID = 'e3234567-aaaa-bbbb-cccc-000000000001';
const BRANCH_ID = 'e3234567-aaaa-bbbb-cccc-000000000002';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const PROJECT_PATH = 'group/shard-test';

interface IJob {
    id: number;
    ref: string;
    sha: string;
}
const jobs = new Map<string, IJob>();
const retried: string[] = [];
const failRetry = new Set<string>();
let mockServer: Server;
let mockPort: number;

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;
const FIXTURE = readFileSync(`${__dirname}/fixtures/${readdirSync(`${__dirname}/fixtures`).find(f => f.endsWith('.png'))}`);

run()
    .then(() => {
        console.log('\nAll sharded build tests passed!');
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
            let m: RegExpExecArray | null;
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
            if (req.method === 'POST' && (m = /^\/api\/v4\/projects\/[^/]+\/jobs\/(\d+)\/retry$/.exec(req.url ?? ''))) {
                retried.push(m[1]);
                if (failRetry.has(m[1])) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ message: 'boom' }));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: Number(m[1]) + 1000, pipeline: { id: 777 } }));
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
/** Registers one job token per shard for a fresh commit; `extra` adds more tokens (other job ids) for the same commit. */
function newSuite(total: number, extra = 0, ref = 'main') {
    counter++;
    const sha = (0x300000 + counter).toString(16).padStart(40, '0');
    const mk = (tag: string, n: number) => {
        const t = `tok-${tag}-${counter}-${n}`;
        jobs.set(t, { id: counter * 1000 + (tag === 's' ? 0 : 500) + n, ref, sha });
        return t;
    };
    return {
        tokens: Array.from({ length: total }, (_, i) => mk('s', i + 1)),
        extras: Array.from({ length: extra }, (_, i) => mk('x', i + 1))
    };
}

const auth = (r: HttpRequest, token: string) => r.header('authorization', `Bearer ${token}`);
const manifestOf = (names: string[]) => ({ count: names.length, hash: screenManifestHash(names) });
const create = (f: Facade, token: string, names: string[] | undefined, shard?: { index: number; total: number }, runId?: string) =>
    f.request(
        auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds`), token).json({
            ...(names && { screens: manifestOf(names) }),
            ...(shard && { shard }),
            ...(runId && { runId })
        })
    );
const status = (f: Facade, id: string, token: string) => f.request(auth(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${id}/status`), token));
const proc = (f: Facade, id: string, token: string, names?: string[]) => {
    const req = auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id}/process`), token);
    return f.request(names ? req.json({ screens: manifestOf(names) }) : req);
};
const upload = (f: Facade, id: string, token: string, name: string) =>
    f.request(
        auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id}/screens`), token).multiPart([
            { name: 'image', file: FIXTURE, fileName: `${name}.png` }
        ])
    );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function expectCode(p: Promise<{ statusCode: number; body: unknown; json: any }>, code: number, label: string) {
    const r = await p;
    assert(r.statusCode === code, `${label}: expected ${code}, got ${r.statusCode}: ${r.body}`);
    return r;
}

/** create + upload + process for one shard; returns the build id. */
async function runShard(f: Facade, token: string, index: number, total: number, names: string[]) {
    const created = await expectCode(create(f, token, names, { index, total }), 200, `shard ${index} create`);
    assert(created.json.status === 'draft', `shard ${index} is an uploader, got ${created.json.status}`);
    for (const n of names) await expectCode(upload(f, created.json.id, token, n), 200, `shard ${index} upload ${n}`);
    await expectCode(proc(f, created.json.id, token, names), 200, `shard ${index} process`);
    return created.json.id as string;
}

const getBuild = (id: string) => BuildEntity.query().filter({ id }).findOne();
const shardRows = (id: string) => BuildShardEntity.query().filter({ buildId: id }).orderBy('shardIndex', 'asc').find();
const screenCount = (id: string, shardIndex?: number) =>
    BuildScreenEntity.query()
        .filter({ buildId: id, ...(shardIndex && { shardIndex }) })
        .count();

const queuedBuilds: string[] = [];

async function run() {
    await startMock();
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_shardtest',
        useSavepoints: false
    });
    await facade.start();
    // Capture enqueues instead of hitting the real queue
    (facade.get(WorkerService) as unknown as { queueJob: (c: unknown, d: { buildId: string }) => Promise<undefined> }).queueJob = async (c, d) => {
        if (c === ProcessBuildJob) queuedBuilds.push(d.buildId);
        return undefined;
    };

    await createPersistedEntity(UserEntity, {
        id: ZERO_ID,
        name: 'Shard Test User',
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
        name: 'Shard Test VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({ url: `http://127.0.0.1:${mockPort}`, clientId: 'client-id', clientSecret: 'client-secret' })
    });
    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'Shard Test App',
        defaultBranchId: BRANCH_ID,
        projectPath: PROJECT_PATH,
        vcsProjectId: 1,
        vcsId: ZERO_ID
    });
    await createPersistedEntity(BranchEntity, { id: BRANCH_ID, appId: APP_ID, name: 'main' });

    await testThreeShards(facade);
    await testValidation(facade);
    await testNameCollision(facade);
    await testTotalMismatch(facade);
    await testRecreateObserverTakeover(facade);
    await testObserverManifest(facade);
    await testEmptyShards(facade);
    await testIdempotentAndFinalised(facade);
    await testRunIdAndName(facade);
    await testPollersKeepDraftAlive(facade);
    await testReadTokenCapScalesWithShards(facade);
    await testApproveRerunsEveryShard(facade);
    await testConcurrentCreates(facade);

    mockServer.close();
}

async function testThreeShards(f: Facade) {
    console.log('\nTest 1: three shards; the build is processed only when the last one is uploaded');
    const { tokens } = newSuite(3);
    const names = [['a1', 'a2'], ['b1'], ['c1', 'c2', 'c3']];
    const before = queuedBuilds.length;

    const id = await runShard(f, tokens[0], 1, 3, names[0]);
    let s = await expectCode(status(f, id, tokens[0]), 200, 'poll after shard 1');
    assert(s.json.status === 'processing' && s.json.shards?.uploaded === 1 && s.json.shards.total === 3, `draft poll: ${JSON.stringify(s.json)}`);
    assert((await getBuild(id)).status === 'draft', 'still draft after shard 1');

    assert((await runShard(f, tokens[1], 2, 3, names[1])) === id, 'same build');
    assert((await getBuild(id)).status === 'draft', 'still draft after shard 2');
    assert(queuedBuilds.length === before, 'nothing enqueued yet');

    assert((await runShard(f, tokens[2], 3, 3, names[2])) === id, 'same build');
    assert((await getBuild(id)).status === 'processing', 'processing after shard 3');
    assert(queuedBuilds.length === before + 1 && queuedBuilds[queuedBuilds.length - 1] === id, 'enqueued exactly once');

    const rows = await shardRows(id);
    assert(rows.length === 3 && rows.every(r => r.state === 'uploaded'), 'three uploaded shard rows');
    assert((await screenCount(id)) === 6, 'six screens');
    assert((await screenCount(id, 3)) === 3, 'shard 3 tagged');

    // the build result is single: flip it and every shard token reads it, repeatedly
    await BuildEntity.query().filter({ id }).patchMany({ status: 'no changes' });
    for (const t of tokens) {
        for (let i = 0; i < 2; i++) {
            s = await expectCode(status(f, id, t), 200, 'final poll');
            assert(s.json.status === 'no changes', 'same final status for every shard');
        }
    }
    console.log('  PASS');
}

async function testValidation(f: Facade) {
    console.log('\nTest: shard validation');
    const { tokens } = newSuite(1);
    for (const bad of [
        { index: 0, total: 2 },
        { index: 3, total: 2 },
        { index: 1, total: 65 },
        { index: 1.5, total: 2 },
        { index: 1, total: 0 }
    ]) {
        await expectCode(create(f, tokens[0], ['v'], bad), 400, `bad shard ${JSON.stringify(bad)}`);
    }
    await expectCode(create(f, tokens[0], undefined, { index: 1, total: 2 }), 400, 'manifest required when sharded');
    // total = 1 is unsharded: no shard echo, no shard rows
    const r = await expectCode(create(f, tokens[0], ['v'], { index: 1, total: 1 }), 200, 'total 1');
    assert(r.json.shard === undefined && (await getBuild(r.json.id)).shardTotal === 1, 'total 1 is unsharded');
    assert((await shardRows(r.json.id)).length === 0, 'no shard rows');
    console.log('  PASS');
}

async function testNameCollision(f: Facade) {
    console.log('\nTest 2: the same screen in two shards is a 409');
    const { tokens } = newSuite(2);
    const id = await runShard(f, tokens[0], 1, 2, ['same', 'only-a']);
    const created = await expectCode(create(f, tokens[1], ['same', 'only-b'], { index: 2, total: 2 }), 200, 'shard 2 create');
    await expectCode(upload(f, id, tokens[1], 'only-b'), 200, 'unique upload');
    await expectCode(upload(f, id, tokens[1], 'same'), 409, 'colliding upload');
    assert(created.json.id === id, 'same build');
    assert((await screenCount(id, 1)) === 2 && (await screenCount(id, 2)) === 1, "shard 1's screens untouched");
    console.log('  PASS');
}

async function testTotalMismatch(f: Facade) {
    console.log('\nTest 3: shard total mismatches are 409; a stale takeover resets the build');
    {
        const { tokens, extras } = newSuite(2, 1);
        const id = (await expectCode(create(f, tokens[0], ['m'], { index: 1, total: 2 }), 200, 'sharded create')).json.id;
        await expectCode(create(f, extras[0], ['m'], undefined), 409, 'unsharded into sharded');
        await expectCode(create(f, extras[0], ['m'], { index: 1, total: 3 }), 409, '2 vs 3');
        assert((await getBuild(id)).shardTotal === 2, 'unchanged');
    }
    {
        const { tokens, extras } = newSuite(1, 1);
        await expectCode(create(f, tokens[0], ['m']), 200, 'unsharded create');
        await expectCode(create(f, extras[0], ['m'], { index: 1, total: 2 }), 409, 'sharded into unsharded');
    }
    {
        const { tokens, extras } = newSuite(3, 1);
        const id = await runShard(f, tokens[0], 1, 3, ['t1']);
        await BuildEntity.query()
            .filter({ id })
            .patchMany({ draftActiveAt: new Date(Date.now() - STALE_DRAFT_MS - 1000) });
        // takeover with a new total: everything resets
        const r = await expectCode(create(f, extras[0], ['n1'], { index: 2, total: 4 }), 200, 'takeover');
        assert(r.json.id === id && r.json.status === 'draft', 'takeover is a draft uploader');
        const b = await getBuild(id);
        assert(b.shardTotal === 4, 'shardTotal reset');
        const rows = await shardRows(id);
        assert(rows.length === 1 && rows[0].shardIndex === 2 && rows[0].state === 'uploading', 'only the new shard row remains');
        assert((await screenCount(id)) === 0, 'screens dropped');
        // the old uploader's token is dead
        await expectCode(upload(f, id, tokens[0], 't1'), 401, 'old shard token');
        // unsharded takeover of a stale sharded build resets it to unsharded
        await BuildEntity.query()
            .filter({ id })
            .patchMany({ draftActiveAt: new Date(Date.now() - STALE_DRAFT_MS - 1000) });
        await expectCode(create(f, tokens[1], ['u1']), 200, 'unsharded takeover');
        const b2 = await getBuild(id);
        assert(b2.shardTotal === 1 && b2.ciTokenHash !== null && (await shardRows(id)).length === 0, 'back to unsharded');
    }
    console.log('  PASS');
}

async function testRecreateObserverTakeover(f: Facade) {
    console.log('\nTest 4: shard re-create, observer and stale shard takeover');
    const { tokens, extras } = newSuite(3, 2);
    // shard 1 uploaded (+processed); shard 2 mid-upload
    const id = await runShard(f, tokens[0], 1, 3, ['p1', 'p2']);
    await expectCode(create(f, tokens[1], ['q1', 'q2'], { index: 2, total: 3 }), 200, 'shard 2 create');
    await expectCode(upload(f, id, tokens[1], 'q1'), 200, 'shard 2 upload');

    // same token re-creates shard 2: only shard 2's screens are cleared
    await expectCode(create(f, tokens[1], ['q1', 'q2'], { index: 2, total: 3 }), 200, 'shard 2 re-create');
    assert((await screenCount(id, 2)) === 0 && (await screenCount(id, 1)) === 2, 're-create clears only its shard');

    // a different fresh token for shard 2 is an observer: no write access, reads status
    const obs = await expectCode(create(f, extras[0], ['q1', 'q2'], { index: 2, total: 3 }), 200, 'observer create');
    assert(obs.json.status === 'processing', `observer sees processing, got ${obs.json.status}`);
    await expectCode(status(f, id, extras[0]), 200, 'observer poll');
    await expectCode(upload(f, id, extras[0], 'q1'), 401, 'observer upload');
    await expectCode(proc(f, id, extras[0]), 401, 'observer process');

    // stale shard 2: another token takes the shard over; shard 1's rows and screens stay
    await BuildShardEntity.query()
        .filter({ buildId: id, shardIndex: 2 })
        .patchMany({ activeAt: new Date(Date.now() - STALE_DRAFT_MS - 1000) });
    const take = await expectCode(create(f, extras[1], ['r1'], { index: 2, total: 3 }), 200, 'shard takeover');
    assert(take.json.status === 'draft', 'taker is an uploader');
    const rows = await shardRows(id);
    assert(rows.length === 2 && rows[0].state === 'uploaded' && rows[1].state === 'uploading', 'shard 1 untouched');
    assert((await screenCount(id, 1)) === 2, "shard 1's screens survive");
    await expectCode(upload(f, id, tokens[1], 'q1'), 401, 'displaced shard token (upload)');
    await expectCode(upload(f, id, extras[1], 'r1'), 200, 'taker upload');
    // a shard 3 that has not registered yet registers as an uploader
    const s3 = await expectCode(create(f, tokens[2], ['z1'], { index: 3, total: 3 }), 200, 'shard 3 create');
    assert(s3.json.status === 'draft', 'shard 3 registers');
    console.log('  PASS');
}

async function testObserverManifest(f: Facade) {
    console.log('\nTest 5: an observer with a different manifest is a 409 and gets no access');
    const { tokens, extras } = newSuite(2, 2);
    const id = await runShard(f, tokens[0], 1, 2, ['o1', 'o2']);
    await expectCode(create(f, extras[0], ['o1', 'other'], { index: 1, total: 2 }), 409, 'draft observer, different manifest');
    await expectCode(status(f, id, extras[0]), 401, 'rejected observer gets no access');
    await expectCode(create(f, extras[1], ['o2', 'o1'], { index: 1, total: 2 }), 200, 'same set, other order');
    // once processing, the same rule
    await runShard(f, tokens[1], 2, 2, ['o3']);
    await expectCode(create(f, extras[0], ['o1', 'other'], { index: 1, total: 2 }), 409, 'processing observer, different manifest');
    const ok = await expectCode(create(f, extras[1], ['o1', 'o2'], { index: 1, total: 2 }), 200, 'processing observer');
    assert(ok.json.status === 'processing', 'sees processing');
    console.log('  PASS');
}

async function testEmptyShards(f: Facade) {
    console.log('\nTest 6: an empty shard is fine; all-empty is a 400');
    {
        const { tokens } = newSuite(2);
        const id = await runShard(f, tokens[0], 1, 2, []);
        assert((await getBuild(id)).status === 'draft', 'draft after the empty shard');
        await runShard(f, tokens[1], 2, 2, ['e1']);
        assert((await getBuild(id)).status === 'processing', 'processing');
    }
    {
        const { tokens } = newSuite(2);
        const id = (await expectCode(create(f, tokens[0], [], { index: 1, total: 2 }), 200, 'create')).json.id;
        await expectCode(proc(f, id, tokens[0], []), 200, 'first empty process');
        await expectCode(create(f, tokens[1], [], { index: 2, total: 2 }), 200, 'create 2');
        await expectCode(proc(f, id, tokens[1], []), 400, 'all empty');
        assert((await getBuild(id)).status === 'draft', 'stays draft');
    }
    console.log('  PASS');
}

async function testIdempotentAndFinalised(f: Facade) {
    console.log('\nTest 7: process is idempotent per shard; an uploaded shard cannot upload again');
    const { tokens } = newSuite(2);
    const before = queuedBuilds.length;
    const id = await runShard(f, tokens[0], 1, 2, ['i1']);
    await expectCode(proc(f, id, tokens[0], ['i1']), 200, 'repeat process (waiting)');
    await expectCode(upload(f, id, tokens[0], 'i2'), 400, 'upload after finalise');
    assert((await screenCount(id, 1)) === 1, 'screens unchanged');
    // wrong manifest does not mark the shard uploaded
    await expectCode(create(f, tokens[1], ['j1', 'j2'], { index: 2, total: 2 }), 200, 'create 2');
    await expectCode(upload(f, id, tokens[1], 'j1'), 200, 'upload j1');
    await expectCode(proc(f, id, tokens[1], ['j1', 'j2']), 400, 'incomplete');
    assert((await getBuild(id)).status === 'draft' && queuedBuilds.length === before, 'not processed');
    await expectCode(upload(f, id, tokens[1], 'j2'), 200, 'upload j2');
    await expectCode(proc(f, id, tokens[1], ['j1', 'j2']), 200, 'process');
    await expectCode(proc(f, id, tokens[1], ['j1', 'j2']), 200, 'process again');
    await expectCode(proc(f, id, tokens[0], ['i1']), 200, 'other shard process again');
    assert(queuedBuilds.length === before + 1, 'enqueued once');
    console.log('  PASS');
}

async function testRunIdAndName(f: Facade) {
    console.log('\nTest: a repeat create with the same runId keeps the shard uploads; the name field is honoured');
    const { tokens } = newSuite(2);
    const c1 = await expectCode(create(f, tokens[0], ['n1', 'n2'], { index: 1, total: 2 }, 'run-aaa'), 200, 'create');
    const id = c1.json.id;
    // upload n1 using the exact-name form field (the multipart filename is a decoy)
    await expectCode(
        f.request(
            auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id}/screens`), tokens[0]).multiPart([
                { name: 'image', file: FIXTURE, fileName: 'decoy.png' },
                { name: 'name', value: 'n1' }
            ])
        ),
        200,
        'upload with name field'
    );
    await expectCode(create(f, tokens[0], ['n1', 'n2'], { index: 1, total: 2 }, 'run-aaa'), 200, 'same-run duplicate create');
    assert((await screenCount(id, 1)) === 1, 'same runId does not clear the shard');
    await expectCode(create(f, tokens[0], ['n1', 'n2'], { index: 1, total: 2 }, 'run-bbb'), 200, 'new-run create');
    assert((await screenCount(id, 1)) === 0, 'a new runId clears the shard');
    console.log('  PASS');
}

async function testPollersKeepDraftAlive(f: Facade) {
    console.log('\nTest: pollers and process keep a waiting sharded draft alive; a late shard joins without a takeover');
    const { tokens, extras } = newSuite(3, 1);
    const id = await runShard(f, tokens[0], 1, 3, ['k1']);
    await runShard(f, tokens[1], 2, 3, ['k2']);
    const ago = (ms: number) => new Date(Date.now() - ms);
    // simulate 40 minutes of waiting: every few minutes the draft ages, then the shard jobs' polls arrive
    for (let i = 0; i < 4; i++) {
        await BuildEntity.query()
            .filter({ id })
            .patchMany({ draftActiveAt: ago(10 * 60 * 1000) });
        const s = await expectCode(status(f, id, i % 2 ? tokens[0] : tokens[1]), 200, 'poll');
        assert(s.json.shards.uploaded === 2, 'two uploaded');
        assert(Date.now() - (await getBuild(id)).draftActiveAt.getTime() < 60_000, 'poll refreshed draftActiveAt');
    }
    // a poll within the throttle window does not write
    const before = (await getBuild(id)).draftActiveAt.getTime();
    await expectCode(status(f, id, tokens[0]), 200, 'throttled poll');
    assert((await getBuild(id)).draftActiveAt.getTime() === before, 'throttled');
    // an observer's poll keeps it alive too
    await BuildEntity.query()
        .filter({ id })
        .patchMany({ draftActiveAt: ago(10 * 60 * 1000) });
    await expectCode(create(f, extras[0], ['k2'], { index: 2, total: 3 }), 200, 'observer create');
    await BuildEntity.query()
        .filter({ id })
        .patchMany({ draftActiveAt: ago(10 * 60 * 1000) });
    await expectCode(status(f, id, extras[0]), 200, 'observer poll');
    assert(Date.now() - (await getBuild(id)).draftActiveAt.getTime() < 60_000, 'observer poll refreshed');
    // shard 3 arrives late: joins, nothing is wiped
    const c = await expectCode(create(f, tokens[2], ['k3'], { index: 3, total: 3 }), 200, 'late shard create');
    assert(c.json.id === id && c.json.status === 'draft', 'joined as an uploader');
    assert((await shardRows(id)).length === 3 && (await screenCount(id)) === 2, 'earlier shards intact');
    await expectCode(upload(f, id, tokens[2], 'k3'), 200, 'upload');
    await expectCode(proc(f, id, tokens[2], ['k3']), 200, 'process');
    assert((await getBuild(id)).status === 'processing', 'processing');
    // process refreshes draftActiveAt on a waiting shard
    const t2 = newSuite(2);
    const id2 = await runShard(f, t2.tokens[0], 1, 2, ['kk1']);
    await BuildEntity.query()
        .filter({ id: id2 })
        .patchMany({ draftActiveAt: ago(10 * 60 * 1000) });
    await expectCode(proc(f, id2, t2.tokens[0], ['kk1']), 200, 'repeat process');
    assert(Date.now() - (await getBuild(id2)).draftActiveAt.getTime() < 60_000, 'process refreshed');
    console.log('  PASS');
}

async function testReadTokenCapScalesWithShards(f: Facade) {
    console.log('\nTest: a sharded build keeps more than 20 observer tokens');
    const { tokens, extras } = newSuite(4, 25);
    const id = await runShard(f, tokens[0], 1, 4, ['cap']);
    for (const x of extras) await expectCode(create(f, x, ['cap'], { index: 1, total: 4 }), 200, 'observer create');
    const b = await getBuild(id);
    assert(b.ciReadTokenHashes.length === 25, `kept ${b.ciReadTokenHashes.length} observer hashes`);
    await expectCode(status(f, id, extras[0]), 200, 'earliest observer still polls');
    console.log('  PASS');
}

async function testApproveRerunsEveryShard(f: Facade) {
    console.log('\nTest 8: approve re-runs the job of every shard');
    const { tokens } = newSuite(3);
    const id = await runShard(f, tokens[0], 1, 3, ['ap1']);
    await runShard(f, tokens[1], 2, 3, ['ap2']);
    await runShard(f, tokens[2], 3, 3, ['ap3']);
    await BuildEntity.query().filter({ id }).patchMany({ status: 'needs review' });
    retried.length = 0;
    const jwt = await JWT.generate({ subject: ZERO_ID });
    const res = await expectCode(
        f.request(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id}/approve`).header('authorization', `Bearer ${jwt}`)),
        200,
        'approve'
    );
    assert(typeof res.json.vcsUrl === 'string' && !res.json.vcsError, `approve result ${JSON.stringify(res.json)}`);
    const expected = tokens.map(t => String(jobs.get(t)!.id)).sort();
    assert(JSON.stringify([...retried].sort()) === JSON.stringify(expected), `retried ${retried} vs ${expected}`);
    // partial failure: the first success still gives the URL, and the failure is reported as a notice (the UI hides vcsError then)
    {
        const { tokens: t2 } = newSuite(2);
        const id2 = await runShard(f, t2[0], 1, 2, ['ap-x']);
        await runShard(f, t2[1], 2, 2, ['ap-y']);
        await BuildEntity.query().filter({ id: id2 }).patchMany({ status: 'needs review' });
        failRetry.add(String(jobs.get(t2[1])!.id));
        const r = await expectCode(
            f.request(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id2}/approve`).header('authorization', `Bearer ${jwt}`)),
            200,
            'partial approve'
        );
        failRetry.clear();
        assert(typeof r.json.vcsUrl === 'string' && !r.json.vcsError, `url without error: ${JSON.stringify(r.json)}`);
        assert(/Re-ran 1 of 2 shard jobs/.test(r.json.vcsNotice), `notice: ${JSON.stringify(r.json)}`);
    }
    console.log('  PASS');
}

async function testConcurrentCreates(f: Facade) {
    console.log('\nTest 9: four shards creating at once, five rounds -> one build, four shard rows');
    for (let round = 1; round <= 5; round++) {
        const { tokens } = newSuite(4);
        const results = await Promise.all(tokens.map((t, i) => create(f, t, [`c${i}`], { index: i + 1, total: 4 })));
        for (const r of results) assert(r.statusCode === 200, `round ${round}: create ${r.statusCode}: ${r.body}`);
        const ids = new Set(results.map(r => r.json.id));
        assert(ids.size === 1, `round ${round}: ${ids.size} builds`);
        const id = [...ids][0] as string;
        assert((await shardRows(id)).length === 4, `round ${round}: shard rows`);
        assert(
            results.every(r => r.json.status === 'draft'),
            `round ${round}: every shard is its own uploader`
        );
        // and they can all upload/process concurrently; the build is processed exactly once
        const before = queuedBuilds.length;
        const done = await Promise.all(
            tokens.map(async (t, i) => {
                const up = await upload(f, id, t, `c${i}`);
                if (up.statusCode !== 200) return up;
                return proc(f, id, t, [`c${i}`]);
            })
        );
        for (const r of done) assert(r.statusCode === 200, `round ${round}: upload/process ${r.statusCode}: ${r.body}`);
        assert((await getBuild(id)).status === 'processing', `round ${round}: processing`);
        assert(queuedBuilds.length === before + 1, `round ${round}: enqueued ${queuedBuilds.length - before} times`);
    }
    console.log('  PASS');
}
