import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, TestingHelpers, uuid7 } from '@zyno-io/ts-server-foundation';
import { readdirSync, readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { mock } from 'node:test';
import { crc32 } from 'zlib';

import { CoreAppOptions } from '../../src/app';
import { STALE_DRAFT_MS } from '../../src/controllers/Builds.controller';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';
import { ScreenEntity } from '../../src/entities/Screen.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { S3Service } from '../../src/services/S3.service';
import { screenManifestHash } from '../../src/services/ScreenManifest';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

const APP_ID = 'e2234567-aaaa-bbbb-cccc-000000000001';
const BRANCH_ID = 'e2234567-aaaa-bbbb-cccc-000000000002';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const PROJECT_PATH = 'group/concurrent-test';

interface IJob {
    id: number;
    ref: string;
    sha: string;
}
// token -> job (the mock GitLab resolves job tokens to these)
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
        console.log('\nAll concurrent build tests passed!');
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
/** Registers two job tokens for the same (branch, commit), simulating two concurrent pipelines. */
function newJobPair(ref = 'main') {
    counter++;
    const sha = counter.toString(16).padStart(40, '0');
    const a = `tok-a-${counter}`;
    const b = `tok-b-${counter}`;
    jobs.set(a, { id: counter * 10 + 1, ref, sha });
    jobs.set(b, { id: counter * 10 + 2, ref, sha });
    return { a, b };
}
function newJob(ref: string) {
    counter++;
    const t = `tok-s-${counter}`;
    jobs.set(t, { id: counter * 10, ref, sha: counter.toString(16).padStart(40, '0') });
    return t;
}

const auth = (r: HttpRequest, token: string) => r.header('authorization', `Bearer ${token}`);
const manifestOf = (names: string[]) => ({ count: names.length, hash: screenManifestHash(names) });
const create = (f: Facade, token: string, names?: string[]) => {
    const req = auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds`), token);
    return f.request(names ? req.json({ screens: manifestOf(names) }) : req);
};
const status = (f: Facade, id: string, token: string) => f.request(auth(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${id}/status`), token));
const proc = (f: Facade, id: string, token: string, screens?: { count: number; hash: string }) => {
    const req = auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id}/process`), token);
    return f.request(screens ? req.json({ screens }) : req);
};
const upload = (f: Facade, id: string, token: string, name: string) =>
    f.request(
        auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id}/screens`), token).multiPart([
            { name: 'image', file: FIXTURE, fileName: `${name}.png` }
        ])
    );

const uploadRaw = (f: Facade, id: string, token: string, file: Buffer, fileName: string) =>
    f.request(auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${id}/screens`), token).multiPart([{ name: 'image', file, fileName }]));

/** A PNG-looking buffer: a valid signature + IHDR (correct CRC) claiming the given dimensions, padded to `size` bytes. */
function fakePng(width: number, height: number, size = 64) {
    const ihdr = Buffer.alloc(17);
    ihdr.write('IHDR', 0, 'latin1');
    ihdr.writeUInt32BE(width, 4);
    ihdr.writeUInt32BE(height, 8);
    ihdr[12] = 8;
    ihdr[13] = 6;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(13);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(ihdr));
    const head = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, ihdr, crc]);
    // header + one IDAT chunk of padding (never decoded in these tests) + IEND
    const iend = Buffer.from('0000000049454e44ae426082', 'hex');
    const pad = Math.max(0, size - head.length - iend.length - 12);
    const idatData = Buffer.concat([Buffer.from('IDAT'), Buffer.alloc(pad)]);
    const idatLen = Buffer.alloc(4);
    idatLen.writeUInt32BE(pad);
    const idatCrc = Buffer.alloc(4);
    idatCrc.writeUInt32BE(crc32(idatData));
    return Buffer.concat([head, idatLen, idatData, idatCrc, iend]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function expectCode(p: Promise<{ statusCode: number; body: unknown; json: any }>, code: number, label: string) {
    const r = await p;
    assert(r.statusCode === code, `${label}: expected ${code}, got ${r.statusCode}: ${r.body}`);
    return r;
}

async function setStatus(id: string, st: BuildEntity['status']) {
    await BuildEntity.query().filter({ id }).patchMany({ status: st });
}
async function getBuild(id: string) {
    return BuildEntity.query().filter({ id }).findOne();
}

async function run() {
    await startMock();
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_concurrenttest',
        // Real, independent connections/transactions are required to exercise concurrency (savepoint mode serializes on one)
        useSavepoints: false
    });
    await facade.start();

    await createPersistedEntity(UserEntity, {
        id: ZERO_ID,
        name: 'Concurrent Test User',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: true,
        vcsId: ZERO_ID,
        vcsUserId: ZERO_ID,
        vcsSession: {
            accessToken: 'test-access-token',
            expiresAt: Date.now() + 60 * 60 * 1000,
            refreshToken: 'test-refresh-token',
            redirectUri: 'http://localhost'
        }
    });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: ZERO_ID,
        name: 'Concurrent Test VCS',
        platform: 'gitlab',
        config: { url: `http://127.0.0.1:${mockPort}`, clientId: 'client-id', clientSecret: 'client-secret' }
    });
    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'Concurrent Test App',
        defaultBranchId: BRANCH_ID,
        projectPath: PROJECT_PATH,
        vcsProjectId: 1,
        vcsId: ZERO_ID
    });
    await createPersistedEntity(BranchEntity, { id: BRANCH_ID, appId: APP_ID, name: 'main' });

    await testFreshDraft(facade);
    await testProcessingAndFinal(facade);
    await testFinalPollIsRepeatable(facade);
    await testProcessIsIdempotent(facade);
    await testProcessVerifiesManifest(facade);
    await testDuplicateManifestMismatch(facade);
    await testUploaderRecreateClearsScreens(facade);
    await testStaleTakeover(facade);
    await testReupload(facade);
    await testProcessCancelsOnlyStaleDrafts(facade);
    await testJobIdAndUploaderRecreate(facade);
    await testCanceledRevival(facade);
    await testDraftActiveAtGovernsCancel(facade);
    await testFailedRevivalAndEmptyProcess(facade);
    await testNoHashLeaks(facade);
    await testConcurrentFirstBuildsOnNewBranch(facade);
    await testUploadValidation(facade);
    await testConcurrentUploads(facade);
    await testTakeoverDuringUpload(facade);
    await testS3FailureLeavesNoRow(facade);
    await testReviewRacesApprove(facade);

    mockServer.close();
}

async function testFreshDraft(f: Facade) {
    console.log('\nTest (a): B creates while A has a fresh draft');
    const { a, b } = newJobPair();
    const ra = await expectCode(create(f, a), 200, 'A create');
    assert(ra.json.status === 'draft', 'A sees draft');
    const rb = await expectCode(create(f, b), 200, 'B create');
    assert(rb.json.id === ra.json.id, 'same build');
    assert(rb.json.status === 'processing', `B sees processing, got ${rb.json.status}`);
    const id = ra.json.id;

    // B polls: never draft
    for (let i = 0; i < 2; i++) {
        const s = await expectCode(status(f, id, b), 200, 'B poll');
        assert(s.json.status === 'processing', 'B poll reports processing');
    }
    // B cannot upload/process
    await expectCode(upload(f, id, b, 'screen-x'), 401, 'B upload');
    await expectCode(proc(f, id, b), 401, 'B process');
    // A can still upload and process
    await expectCode(upload(f, id, a, 'screen-1'), 200, 'A upload');
    await expectCode(proc(f, id, a), 200, 'A process');
    const sa = await expectCode(status(f, id, a), 200, 'A poll');
    assert(sa.json.status === 'processing', `A poll processing, got ${sa.json.status}`);
    const build = await getBuild(id);
    assert(build.ciTokenHash && build.ciReadTokenHashes.length === 1, 'one read token');
    console.log('  PASS');
}

async function testProcessingAndFinal(f: Facade) {
    console.log('\nTest (b): B creates while processing / final; A polls still work');
    for (const st of ['processing', 'needs review', 'no changes'] as const) {
        const { a, b } = newJobPair();
        const ra = await expectCode(create(f, a), 200, 'A create');
        const id = ra.json.id;
        await setStatus(id, st);
        const rb = await expectCode(create(f, b), 200, 'B create');
        assert(rb.json.id === id && rb.json.status === st, `B sees ${st}`);
        await expectCode(status(f, id, a), 200, `A poll (${st})`);
        await expectCode(status(f, id, b), 200, `B poll (${st})`);
        const build = await getBuild(id);
        if (st === 'processing') assert(build.ciTokenHash !== null && build.ciReadTokenHashes.length === 1, 'hashes preserved while processing');
    }
    console.log('  PASS');
}

async function testFinalPollIsRepeatable(f: Facade) {
    console.log('\nTest (c): final status polls are repeatable until the CI token expiry');
    const { a, b } = newJobPair();
    const id = (await expectCode(create(f, a), 200, 'A create')).json.id;
    await expectCode(create(f, b), 200, 'B create');
    await setStatus(id, 'no changes');

    for (let i = 0; i < 2; i++) {
        const sa = await expectCode(status(f, id, a), 200, `A final poll ${i}`);
        assert(sa.json.status === 'no changes', 'A sees final');
        const sb = await expectCode(status(f, id, b), 200, `B final poll ${i}`);
        assert(sb.json.status === 'no changes', 'B sees final');
    }
    const build = await getBuild(id);
    assert(build.ciTokenHash !== null && build.ciReadTokenHashes.length === 1, 'final polls do not revoke hashes');

    await BuildEntity.query()
        .filter({ id })
        .patchMany({ ciTokensExpireAt: new Date(Date.now() - 1000) });
    await expectCode(status(f, id, a), 401, 'A after expiry');
    await expectCode(status(f, id, b), 401, 'B after expiry');

    // A create (even by a reader) refreshes the expiry
    await expectCode(create(f, b), 200, 'B create refreshes');
    assert((await getBuild(id)).ciTokensExpireAt!.getTime() > Date.now() + 60 * 60 * 1000, 'expiry refreshed');
    await expectCode(status(f, id, a), 200, 'A after refresh');
    await expectCode(status(f, id, b), 200, 'B after refresh');

    // A null expiry (pre-migration rows) counts as expired
    await BuildEntity.query().filter({ id }).patchMany({ ciTokensExpireAt: null });
    await expectCode(status(f, id, a), 401, 'A with null expiry');
    console.log('  PASS');
}

async function testProcessIsIdempotent(f: Facade) {
    console.log('\nTest: process is retry-safe');
    const { a, b } = newJobPair();
    const id = (await expectCode(create(f, a), 200, 'A create')).json.id;
    await expectCode(upload(f, id, a, 'screen-1'), 200, 'A upload');
    await expectCode(proc(f, id, a), 200, 'process 1');
    assert((await getBuild(id)).status === 'processing', 'processing after first call');
    // The second call must not touch the status (the worker may already have moved the build on)
    await setStatus(id, 'needs review');
    const r = await expectCode(proc(f, id, a), 200, 'process 2');
    assert(r.json.ok === true, 'ok body');
    assert((await getBuild(id)).status === 'needs review', 'second process left the status alone');
    await setStatus(id, 'no changes');
    await expectCode(proc(f, id, a), 200, 'process on a final build');

    // A non-uploader learns nothing about the build state
    await expectCode(create(f, b), 200, 'B create');
    await expectCode(proc(f, id, b), 401, 'reader process');

    // Old uploader after a takeover
    const t = newJobPair();
    const id2 = (await expectCode(create(f, t.a), 200, 'A2 create')).json.id;
    await BuildEntity.query()
        .filter({ id: id2 })
        .patchMany({ draftActiveAt: new Date(Date.now() - STALE_DRAFT_MS - 60_000) });
    await expectCode(create(f, t.b), 200, 'B2 takeover');
    await expectCode(proc(f, id2, t.a), 401, 'old uploader after takeover');

    // Canceled
    const c = newJobPair();
    const id3 = (await expectCode(create(f, c.a), 200, 'A3 create')).json.id;
    await expectCode(upload(f, id3, c.a, 'screen-1'), 200, 'A3 upload');
    await setStatus(id3, 'canceled');
    await expectCode(proc(f, id3, c.a), 400, 'process on canceled');
    await setStatus(id3, 'failed');
    await expectCode(proc(f, id3, c.a), 400, 'process on failed');
    console.log('  PASS');
}

async function testProcessVerifiesManifest(f: Facade) {
    console.log('\nTest: process verifies the screen manifest');
    const t = newJob('branch-manifest');
    const names = ['m-1', 'm-2'];
    const id = (await expectCode(create(f, t, names), 200, 'create')).json.id;
    const build = await getBuild(id);
    assert(build.manifestCount === 2 && build.manifestHash === screenManifestHash(names), 'manifest stored at create');
    await expectCode(upload(f, id, t, 'm-1'), 200, 'upload 1');
    await expectCode(upload(f, id, t, 'm-2'), 200, 'upload 2');

    await expectCode(proc(f, id, t, { count: 3, hash: screenManifestHash(names) }), 400, 'wrong count');
    assert((await getBuild(id)).status === 'draft', 'still draft after wrong count');
    await expectCode(proc(f, id, t, { count: 2, hash: screenManifestHash(['m-1', 'm-3']) }), 400, 'wrong hash');
    await expectCode(proc(f, id, t, { count: 2, hash: 'nothex' }), 400, 'malformed hash');
    await expectCode(proc(f, id, t, { count: -1, hash: screenManifestHash(names) }), 400, 'negative count');
    assert((await getBuild(id)).status === 'draft', 'still draft after rejections');
    await expectCode(proc(f, id, t, manifestOf(names)), 200, 'correct manifest');
    assert((await getBuild(id)).status === 'processing', 'processing');
    await expectCode(create(f, newJob('branch-bad-manifest'), []), 200, 'empty manifest is valid');
    console.log('  PASS');
}

async function testDuplicateManifestMismatch(f: Facade) {
    console.log('\nTest: duplicate jobs with a divergent manifest are rejected');
    const { a, b } = newJobPair();
    const c = `${a}-c`;
    const d = `${a}-d`;
    const job = jobs.get(a)!;
    jobs.set(c, { ...job, id: job.id + 1000 });
    jobs.set(d, { ...job, id: job.id + 2000 });
    const h1 = ['dup-1', 'dup-2'];
    const h2 = ['dup-1', 'dup-3'];
    const id = (await expectCode(create(f, a, h1), 200, 'A create')).json.id;
    const before = await getBuild(id);
    const rb = await expectCode(create(f, b, h2), 409, 'B (different manifest)');
    assert(/PIXELCI_SHARD/.test(String(rb.body)), `409 mentions PIXELCI_SHARD, got ${rb.body}`);
    await expectCode(status(f, id, b), 401, 'B gets no read access');
    const after = await getBuild(id);
    assert(after.ciReadTokenHashes.length === before.ciReadTokenHashes.length, 'no read hash added');
    assert(after.manifestHash === before.manifestHash, 'manifest untouched');

    const rc = await expectCode(create(f, c, h1), 200, 'C (same manifest)');
    assert(rc.json.status === 'processing', `C is a reader, got ${rc.json.status}`);
    await expectCode(status(f, id, c), 200, 'C polls');
    const rd = await expectCode(create(f, d), 200, 'D (old CLI, no manifest)');
    assert(rd.json.status === 'processing', `D is a reader, got ${rd.json.status}`);
    await expectCode(status(f, id, d), 200, 'D polls');
    console.log('  PASS');
}

async function testUploaderRecreateClearsScreens(f: Facade) {
    console.log('\nTest: uploader re-create starts from a clean slate');
    const t = newJob('branch-recreate');
    const id = (await expectCode(create(f, t, ['r-1']), 200, 'create')).json.id;
    await expectCode(upload(f, id, t, 'r-1'), 200, 'upload');
    assert((await BuildScreenEntity.query().filter({ buildId: id }).find()).length === 1, 'one screen');
    const again = await expectCode(create(f, t, ['r-2', 'r-3']), 200, 're-create');
    assert(again.json.status === 'draft', 'uploader keeps draft');
    assert((await BuildScreenEntity.query().filter({ buildId: id }).find()).length === 0, 'screens cleared');
    const build = await getBuild(id);
    assert(build.manifestCount === 2 && build.manifestHash === screenManifestHash(['r-2', 'r-3']), 'manifest replaced');
    console.log('  PASS');
}

async function testStaleTakeover(f: Facade) {
    console.log('\nTest (d): stale draft takeover');
    const { a, b } = newJobPair();
    const id = (await expectCode(create(f, a), 200, 'A create')).json.id;
    await BuildEntity.query()
        .filter({ id })
        .patchMany({ draftActiveAt: new Date(Date.now() - STALE_DRAFT_MS - 60_000) });
    const rb = await expectCode(create(f, b), 200, 'B create');
    assert(rb.json.id === id && rb.json.status === 'draft', `B takes over with draft, got ${rb.json.status}`);
    // A further create after takeover must be a reader, not re-take (staleness clock was reset)
    const c = `tok-c-${counter}`;
    jobs.set(c, { id: counter * 10 + 3, ref: 'main', sha: counter.toString(16).padStart(40, '0') });
    const rc = await expectCode(create(f, c), 200, 'C create');
    assert(rc.json.status === 'processing', `C is a reader, got ${rc.json.status}`);
    assert((await getBuild(id)).ciJobId === String(counter * 10 + 2), 'uploader job id preserved');
    await expectCode(upload(f, id, a, 'screen-1'), 401, 'A upload after takeover');
    await expectCode(upload(f, id, b, 'screen-1'), 200, 'B upload');
    await expectCode(proc(f, id, b), 200, 'B process');
    console.log('  PASS');
}

async function testReupload(f: Facade) {
    console.log('\nTest (e): re-uploading a same-named screen replaces it');
    const { a } = newJobPair();
    const id = (await expectCode(create(f, a), 200, 'create')).json.id;
    const first = await expectCode(upload(f, id, a, 'dup'), 200, 'first upload');
    const second = await expectCode(upload(f, id, a, 'dup'), 200, 'second upload');
    assert(first.json.screenId === second.json.screenId, 'same screen');
    assert(first.json.id !== second.json.id, 'new build screen row');
    const rows = await BuildScreenEntity.query().filter({ buildId: id }).find();
    assert(rows.length === 1 && rows[0].id === second.json.id, 'exactly one row, the new one');
    console.log('  PASS');
}

async function testProcessCancelsOnlyStaleDrafts(f: Facade) {
    console.log('\nTest (f): process cancels only stale other drafts');
    const t1 = newJob('branch-f1');
    const t2 = newJob('branch-f2');
    const t3 = newJob('branch-f3');
    const fresh = (await expectCode(create(f, t2), 200, 'fresh create')).json.id;
    const stale = (await expectCode(create(f, t3), 200, 'stale create')).json.id;
    await BuildEntity.query()
        .filter({ id: stale })
        .patchMany({ draftActiveAt: new Date(Date.now() - STALE_DRAFT_MS - 60_000) });
    const main = (await expectCode(create(f, t1), 200, 'main create')).json.id;
    await expectCode(upload(f, main, t1, 'screen'), 200, 'main upload');
    await expectCode(proc(f, main, t1), 200, 'process');
    assert((await getBuild(fresh)).status === 'draft', 'fresh draft untouched');
    assert((await getBuild(stale)).status === 'canceled', 'stale draft canceled');
    console.log('  PASS');
}

async function testJobIdAndUploaderRecreate(f: Facade) {
    console.log('\nTest: ciJobId rules and uploader re-create');
    const { a, b } = newJobPair();
    const jobA = String(jobs.get(a)!.id);
    const jobB = String(jobs.get(b)!.id);
    const id = (await expectCode(create(f, a), 200, 'A create')).json.id;
    await expectCode(create(f, b), 200, 'B create');
    assert((await getBuild(id)).ciJobId === jobA, 'reader does not overwrite ciJobId during fresh draft');

    // Uploader re-creates with the same token
    const again = await expectCode(create(f, a), 200, 'A re-create');
    assert(again.json.status === 'draft', `uploader re-create gets draft, got ${again.json.status}`);
    // A new token with the same (GitLab, numeric) job id is NOT the uploader: only per-job GitHub ids
    // (`run:check_run`) identify the uploader by job id (covered in github-api.test.ts).
    const a2 = `${a}-new`;
    jobs.set(a2, jobs.get(a)!);
    const again2 = await expectCode(create(f, a2), 200, 'A re-create (new token)');
    assert(again2.json.status === 'processing', `numeric job id with a new token is a reader, got ${again2.json.status}`);
    await expectCode(upload(f, id, a2, 'screen-1'), 401, 'reader cannot upload');
    await expectCode(upload(f, id, a, 'screen-2'), 200, 'uploader still uploads');
    await expectCode(create(f, b), 200, 'B re-create');
    assert((await getBuild(id)).ciJobId === jobA, 'still uploader job id');

    // Once processing, readers update ciJobId (approval re-run target)
    await setStatus(id, 'processing');
    await expectCode(create(f, b), 200, 'B create while processing');
    assert((await getBuild(id)).ciJobId === jobB, 'reader updates ciJobId while processing');
    await setStatus(id, 'needs review');
    await expectCode(create(f, a2), 200, 'A create while needs review');
    assert((await getBuild(id)).ciJobId === jobA, 'ciJobId updated while needs review');
    console.log('  PASS');
}

async function testCanceledRevival(f: Facade) {
    console.log('\nTest: canceled build revival and status reporting');
    const { a, b } = newJobPair();
    const id = (await expectCode(create(f, a), 200, 'A create')).json.id;
    await expectCode(upload(f, id, a, 'old-screen'), 200, 'A upload');
    await setStatus(id, 'canceled');
    const s = await expectCode(status(f, id, a), 200, 'poll canceled');
    assert(s.json.status === 'failed', `canceled reported as failed, got ${s.json.status}`);

    // B revives the canceled build (a poll no longer revokes anything)
    const rb = await expectCode(create(f, b), 200, 'B create');
    assert(rb.json.id === id && rb.json.status === 'draft', `revived as draft, got ${rb.json.status}`);
    assert((await BuildScreenEntity.query().filter({ buildId: id }).find()).length === 0, 'old screens deleted');
    await expectCode(upload(f, id, b, 'new-screen'), 200, 'B upload');
    await expectCode(proc(f, id, b), 200, 'B process');
    const rows = await BuildScreenEntity.query().filter({ buildId: id }).find();
    assert(rows.length === 1, 'only the new screen present');
    console.log('  PASS');
}

async function testDraftActiveAtGovernsCancel(f: Facade) {
    console.log('\nTest: process-time cancel uses draftActiveAt, not createdAt');
    const t1 = newJob('branch-h1');
    const t2 = newJob('branch-h2');
    const active = (await expectCode(create(f, t2), 200, 'active create')).json.id;
    // old createdAt but fresh draftActiveAt
    await BuildEntity.query()
        .filter({ id: active })
        .patchMany({ createdAt: new Date(Date.now() - STALE_DRAFT_MS - 60_000), draftActiveAt: new Date() });
    const main = (await expectCode(create(f, t1), 200, 'main create')).json.id;
    await expectCode(upload(f, main, t1, 'screen'), 200, 'main upload');
    await expectCode(proc(f, main, t1), 200, 'process');
    assert((await getBuild(active)).status === 'draft', 'active draft (old createdAt) not canceled');
    console.log('  PASS');
}

async function testFailedRevivalAndEmptyProcess(f: Facade) {
    console.log('\nTest: failed build revival; processing a build with no screens is rejected');
    const { a, b } = newJobPair();
    const id = (await expectCode(create(f, a), 200, 'A create')).json.id;
    await expectCode(proc(f, id, a), 400, 'process with no screens');
    assert((await getBuild(id)).status === 'draft', 'still draft after rejected process');
    await expectCode(upload(f, id, a, 'screen'), 200, 'A upload');
    await setStatus(id, 'failed');
    const rb = await expectCode(create(f, b), 200, 'B create on failed');
    assert(rb.json.id === id && rb.json.status === 'draft', `failed build revived as draft, got ${rb.json.status}`);
    assert((await BuildScreenEntity.query().filter({ buildId: id }).find()).length === 0, 'old screens deleted on revival');
    await expectCode(proc(f, id, a), 401, 'old uploader cannot process after revival');
    await expectCode(upload(f, id, b, 'screen'), 200, 'B upload');
    await expectCode(proc(f, id, b), 200, 'B process');
    console.log('  PASS');
}

async function testNoHashLeaks(f: Facade) {
    console.log('\nTest (g): responses never contain token hashes');
    const { a, b } = newJobPair();
    const ra = await expectCode(create(f, a), 200, 'A create');
    const rb = await expectCode(create(f, b), 200, 'B create');
    const id = ra.json.id;
    const before = await getBuild(id);
    const secrets = [before.ciTokenHash, ...before.ciReadTokenHashes].filter((h): h is string => !!h);
    assert(secrets.length === 2, 'two hashes collected before any are cleared');
    const bodies = [String(ra.body), String(rb.body)];
    bodies.push(String((await status(f, id, b)).body));
    await setStatus(id, 'needs review');
    bodies.push(String((await status(f, id, a)).body));
    const jwt = await JWT.generate({ subject: ZERO_ID });
    const userAuth = (r: HttpRequest) => r.header('authorization', `Bearer ${jwt}`);
    bodies.push(String((await expectCode(f.request(userAuth(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${id}`))), 200, 'show')).body));
    bodies.push(String((await expectCode(f.request(userAuth(HttpRequest.GET(`/api/apps/${APP_ID}/builds`))), 200, 'list')).body));
    // DB-level sanity that the hashes exist (so absence in responses is meaningful)
    for (const body of bodies) {
        assert(!/ciTokenHash|ciReadTokenHashes/.test(body), `field names absent in ${body}`);
        for (const s of secrets) assert(!body.includes(s), 'hash value absent');
    }
    console.log('  PASS');
}

async function testConcurrentFirstBuildsOnNewBranch(f: Facade) {
    console.log('\nTest (h): concurrent first builds on a brand-new branch create exactly one branch and build');
    const CONCURRENCY = 5;
    for (let round = 1; round <= 3; round++) {
        const ref = `branch-race-${round}`;
        // Several jobs (distinct tokens) for the same new branch and commit, all created at once
        counter++;
        const sha = counter.toString(16).padStart(40, '0');
        const tokens = Array.from({ length: CONCURRENCY }, (_, i) => {
            const token = `tok-r${round}-${i}`;
            jobs.set(token, { id: counter * 100 + i, ref, sha });
            return token;
        });
        const results = await Promise.all(tokens.map(t => create(f, t)));
        for (const r of results) assert(r.statusCode === 200, `round ${round}: create returned ${r.statusCode}: ${r.body}`);

        const branches = await BranchEntity.query().filter({ appId: APP_ID, name: ref }).find();
        assert(branches.length === 1, `round ${round}: expected 1 branch, got ${branches.length}`);
        const builds = await BuildEntity.query().filter({ appId: APP_ID, branchId: branches[0].id }).find();
        assert(builds.length === 1, `round ${round}: expected 1 build, got ${builds.length}`);
        const ids = new Set(results.map(r => r.json.id));
        assert(ids.size === 1 && ids.has(builds[0].id), `round ${round}: all requests resolve to the same build`);
        const uploaders = results.filter(r => r.json.status === 'draft');
        assert(uploaders.length === 1, `round ${round}: expected 1 uploader, got ${uploaders.length}`);
        assert(
            builds[0].ciReadTokenHashes.length === CONCURRENCY - 1,
            `round ${round}: expected ${CONCURRENCY - 1} readers, got ${builds[0].ciReadTokenHashes.length}`
        );
    }
    console.log('  PASS');
}

async function testUploadValidation(f: Facade) {
    console.log('\nTest (i): upload validation');
    const t = newJob('branch-validate');
    const id = (await expectCode(create(f, t), 200, 'create')).json.id;

    await expectCode(uploadRaw(f, id, t, Buffer.from('definitely not a png, but long enough to have a header'), 'bad.png'), 400, 'bad signature');
    await expectCode(uploadRaw(f, id, t, fakePng(100000, 100000), 'huge.png'), 400, 'IHDR claims 100000x100000');
    // NOTE: the testing facade delivers the whole multipart body as a single chunk, so this exercises the up-front size rejection
    // (HTTP_MAX_REQUEST_BODY_BYTES) rather than per-chunk streaming accounting.
    await expectCode(uploadRaw(f, id, t, fakePng(100, 100, 17 * 1024 * 1024), 'big.png'), 413, '17MB file');
    const empty = await expectCode(uploadRaw(f, id, t, fakePng(10, 10), '.png'), 400, 'empty name');
    assert(/must not be empty/.test(String(empty.body)), `empty-name 400 comes from parseScreenName, got ${empty.body}`);
    // These names get past the multipart parser, so the 400 must come from parseScreenName
    const bidi = await expectCode(uploadRaw(f, id, t, fakePng(10, 10), 'bidi\u202Ename.png'), 400, 'bidi override in name');
    assert(/forbidden characters/.test(String(bidi.body)), `bidi 400 comes from parseScreenName, got ${bidi.body}`);
    const long = await expectCode(uploadRaw(f, id, t, fakePng(10, 10), `${'a'.repeat(201)}.png`), 400, 'name too long');
    assert(/at most 200 characters/.test(String(long.body)), `length 400 comes from parseScreenName, got ${long.body}`);
    assert((await BuildScreenEntity.query().filter({ buildId: id }).find()).length === 0, 'rejected uploads leave no rows');
    assert((await ScreenEntity.query().filter({ appId: APP_ID, name: 'bad' }).find()).length === 0, 'rejected uploads leave no screens');
    // A header-valid image that is not truncated passes validation (the real fixture, and a bare header)
    await expectCode(upload(f, id, t, 'ok-fixture'), 200, 'fixture');
    await expectCode(uploadRaw(f, id, t, fakePng(5000, 5000), 'max.png'), 200, 'exactly at the pixel cap');
    console.log('  PASS');
}

// Kept below the test DB pool size: each in-flight upload holds a pooled connection while waiting on the build row lock
const CONCURRENT_UPLOADS = 8;

async function testConcurrentUploads(f: Facade) {
    console.log('\nTest (j): concurrent uploads');
    const t = newJob('branch-conc-upload');
    const id = (await expectCode(create(f, t), 200, 'create')).json.id;
    const names = Array.from({ length: CONCURRENT_UPLOADS }, (_, i) => `conc-${i}`);
    const results = await Promise.all(names.map(n => upload(f, id, t, n)));
    for (const r of results) assert(r.statusCode === 200, `concurrent upload returned ${r.statusCode}: ${r.body}`);
    const rows = await BuildScreenEntity.query().filter({ buildId: id }).find();
    assert(rows.length === CONCURRENT_UPLOADS, `expected ${CONCURRENT_UPLOADS} rows, got ${rows.length}`);
    assert(new Set(rows.map(r => r.screenId)).size === CONCURRENT_UPLOADS, `${CONCURRENT_UPLOADS} distinct screens`);

    // The same brand-new screen name uploaded from two builds at once creates exactly one screen
    for (let round = 0; round < 3; round++) {
        const t1 = newJob(`branch-same-${round}-1`);
        const t2 = newJob(`branch-same-${round}-2`);
        const id1 = (await expectCode(create(f, t1), 200, 'create 1')).json.id;
        const id2 = (await expectCode(create(f, t2), 200, 'create 2')).json.id;
        const name = `shared-new-${round}`;
        const [r1, r2] = await Promise.all([upload(f, id1, t1, name), upload(f, id2, t2, name)]);
        assert(r1.statusCode === 200 && r2.statusCode === 200, `same-name uploads: ${r1.statusCode}/${r2.statusCode}: ${r1.body} ${r2.body}`);
        assert(r1.json.screenId === r2.json.screenId, 'both builds use the same screen');
        const screens = await ScreenEntity.query().filter({ appId: APP_ID, name }).find();
        assert(screens.length === 1, `round ${round}: expected 1 screen, got ${screens.length}`);
    }
    console.log('  PASS');
}

async function testTakeoverDuringUpload(f: Facade) {
    console.log('\nTest (k): takeover during the S3 upload');
    const { a, b } = newJobPair('branch-takeover-upload');
    const id = (await expectCode(create(f, a), 200, 'A create')).json.id;

    const s3 = f.get<S3Service>(S3Service);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const reachedS3 = new Promise<void>(r => (entered = r));
    const m = mock.method(
        s3,
        'uploadFile',
        async () => {
            entered();
            await gate;
        },
        { times: 1 }
    );
    try {
        const pending = upload(f, id, a, 'gated');
        await reachedS3;
        await BuildEntity.query()
            .filter({ id })
            .patchMany({ draftActiveAt: new Date(Date.now() - STALE_DRAFT_MS - 60_000) });
        const rb = await expectCode(create(f, b), 200, 'B takes over');
        assert(rb.json.status === 'draft', 'B is the uploader now');
        release();
        const ra = await pending;
        assert(ra.statusCode === 401, `A upload after takeover: expected 401, got ${ra.statusCode}: ${ra.body}`);
        assert((await BuildScreenEntity.query().filter({ buildId: id }).find()).length === 0, 'no row left by A');
    } finally {
        release();
        m.mock.restore();
    }
    console.log('  PASS');
}

async function testS3FailureLeavesNoRow(f: Facade) {
    console.log('\nTest (l): S3 failure leaves no row; retry succeeds');
    const t = newJob('branch-s3-fail');
    const id = (await expectCode(create(f, t), 200, 'create')).json.id;
    const s3 = f.get<S3Service>(S3Service);
    const m = mock.method(
        s3,
        'uploadFile',
        async () => {
            throw new Error('simulated S3 outage');
        },
        { times: 1 }
    );
    try {
        const r = await upload(f, id, t, 'flaky');
        assert(r.statusCode >= 500, `expected 5xx, got ${r.statusCode}: ${r.body}`);
        assert((await BuildScreenEntity.query().filter({ buildId: id }).find()).length === 0, 'no row after failed upload');
        await expectCode(upload(f, id, t, 'flaky'), 200, 'retry');
        assert((await BuildScreenEntity.query().filter({ buildId: id }).find()).length === 1, 'one row after retry');
    } finally {
        m.mock.restore();
    }
    console.log('  PASS');
}

async function testReviewRacesApprove(f: Facade) {
    console.log('\nTest (i): a rejection racing an approval never leaves an approved build with a rejected screen');
    const jwt = await JWT.generate({ subject: ZERO_ID });
    const userAuth = (r: HttpRequest) => r.header('authorization', `Bearer ${jwt}`);
    const ROUNDS = 20;
    const outcomes = { reviewFirst: 0, approveFirst: 0 };

    for (let round = 1; round <= ROUNDS; round++) {
        counter++;
        const build = await createPersistedEntity(BuildEntity, {
            id: uuid7(),
            appId: APP_ID,
            branchId: BRANCH_ID,
            createdAt: new Date(),
            commitHash: counter.toString(16).padStart(40, '0'),
            commitSubject: 'race',
            commitAuthor: 'Test Author',
            ciJobId: String(counter * 10),
            ciTokenHash: null,
            ciReadTokenHashes: [],
            status: 'needs review',
            approvedById: null,
            approvedAt: null
        });
        const screen = await createPersistedEntity(ScreenEntity, { id: uuid7(), appId: APP_ID, name: `race-${round}` });
        await createPersistedEntity(BuildScreenEntity, {
            id: uuid7(),
            appId: APP_ID,
            buildId: build.id,
            screenId: screen.id,
            matchedBuildId: null,
            approvalBuildId: null,
            status: 'needs review',
            storageStatus: 'stored',
            reviewStatus: null,
            reviewComment: null,
            reviewedById: null,
            reviewedAt: null
        });

        const [approve, review] = await Promise.all([
            f.request(userAuth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${build.id}/approve`))),
            f.request(
                userAuth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${build.id}/screens/${screen.id}/review`)).json({
                    reviewStatus: 'rejected',
                    comment: 'race'
                })
            )
        ]);
        assert(approve.statusCode === 200, `round ${round}: approve returned ${approve.statusCode}: ${approve.body}`);
        assert(review.statusCode === 200 || review.statusCode === 400, `round ${round}: review returned ${review.statusCode}: ${review.body}`);

        const after = await getBuild(build.id);
        const rejected = await BuildScreenEntity.query().filter({ buildId: build.id, reviewStatus: 'rejected' }).count();
        assert(
            !(after.status === 'changes approved' && rejected > 0),
            `round ${round}: build is changes approved but has ${rejected} rejected screen(s) (review ${review.statusCode})`
        );
        // The two outcomes a serialized order can produce
        if (review.statusCode === 200) {
            assert(after.status === 'changes rejected' && rejected === 1, `round ${round}: review won but build is ${after.status}`);
            outcomes.reviewFirst++;
        } else {
            assert(after.status === 'changes approved' && rejected === 0, `round ${round}: approve won but build is ${after.status}`);
            outcomes.approveFirst++;
        }
    }
    console.log(`  PASS (review first ${outcomes.reviewFirst}, approve first ${outcomes.approveFirst})`);
}
