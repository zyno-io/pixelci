/**
 * Storage cleanup: which S3 objects the cleaner deletes and which it keeps, end to end against real rows and a real bucket.
 * Rows and objects are seeded directly. Runs use graceMs 0 with `now` a couple of minutes ahead, so objects written a moment
 * ago count as old; the "young" cases use a real grace period.
 */
import { HttpRequest, ScopedLogger } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, TestingHelpers, uuid7, WorkerService } from '@zyno-io/ts-server-foundation';
import { readFileSync } from 'fs';

import { hashCiToken } from '../../src/accessories/AuthMiddleware.accessory';
import { CoreAppOptions } from '../../src/app';
import { AppConfig } from '../../src/config';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';
import { BuildShardEntity } from '../../src/entities/BuildShard.entity';
import { ScreenEntity } from '../../src/entities/Screen.entity';
import { ScreenDecisionEntity } from '../../src/entities/ScreenDecision.entity';
import { StorageSweepEntity } from '../../src/entities/StorageSweep.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { ReclaimBuildStorageJob } from '../../src/jobs/ReclaimBuildStorage.job';
import { S3Service } from '../../src/services/S3.service';
import { sealVcsSession } from '../../src/services/secrets/VcsSecrets';
import { queueBuildReclaims } from '../../src/services/storage/ReclaimQueue';
import { createGcContext, IGcContext, StorageGcService } from '../../src/services/storage/StorageGc.service';
import { configureTestDatabase, ensureTestBucket, useIsolatedRedisPrefix } from './db-defaults';

process.env.CI = 'true';
useIsolatedRedisPrefix('storage-gc');
configureTestDatabase();

const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const DAY = 86_400_000;
const PNG = readFileSync(`${__dirname}/fixtures/finder-1.png`);

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;
type BuildStatus = BuildEntity['status'];

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function eq(actual: unknown, expected: unknown, msg: string) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`Assertion failed: ${msg}\n  expected ${e}\n  actual   ${a}`);
}

let facade: Facade;
let gc: StorageGcService;
let s3: S3Service;
let jwt: string;

/** A context that treats everything written so far as old, deletes (or only counts), and has no time limit. */
const ctx = (overrides: Partial<IGcContext> = {}): IGcContext =>
    createGcContext(gc.getSettings(), {
        mode: 'delete',
        graceMs: 0,
        now: new Date(Date.now() + 120_000),
        deadlineAt: Infinity,
        // the bucket is shared with other suites: never touch prefixes that are not this suite's
        deleteUnknownApps: false,
        ...overrides
    });

// ---- seeding ---------------------------------------------------------------------------------------------------------------

interface IApp {
    id: string;
    branchId: string;
}

async function newApp(patch: Partial<AppEntity> = {}): Promise<IApp> {
    const id = uuid7();
    const branchId = uuid7();
    await createPersistedEntity(AppEntity, {
        id,
        name: `GC ${id.slice(-6)}`,
        defaultBranchId: branchId,
        projectPath: 'group/gc',
        vcsProjectId: 1,
        vcsId: ZERO_ID,
        ...patch
    });
    await createPersistedEntity(BranchEntity, { id: branchId, appId: id, name: 'main' });
    return { id, branchId };
}

async function newScreen(app: IApp, name: string) {
    return (await createPersistedEntity(ScreenEntity, { id: uuid7(), appId: app.id, name })).id;
}

async function newBuild(app: IApp, status: BuildStatus, extra: Partial<BuildEntity> = {}) {
    const id = uuid7();
    await createPersistedEntity(BuildEntity, {
        id,
        appId: app.id,
        branchId: app.branchId,
        createdAt: new Date(),
        commitHash: id.replace(/-/g, '').padEnd(40, '0'),
        commitSubject: 'gc',
        commitAuthor: 'gc',
        ciJobId: id,
        ciTokenHash: null,
        ciReadTokenHashes: [],
        status,
        approvedById: null,
        approvedAt: null,
        ciTokensExpireAt: null,
        ciRunId: null,
        manifestCount: null,
        manifestHash: null,
        processingAttemptId: null,
        processingHeartbeatAt: null,
        processingStartedAt: null,
        baseCommits: null,
        baseSource: null,
        referenceBuildId: null,
        referenceSource: null,
        ...extra
    });
    return id;
}

async function newRow(app: IApp, buildId: string, screenId: string, patch: Partial<BuildScreenEntity> = {}) {
    return createPersistedEntity(BuildScreenEntity, {
        id: uuid7(),
        appId: app.id,
        buildId,
        screenId,
        matchedBuildId: null,
        approvalBuildId: null,
        status: 'needs review',
        storageStatus: 'stored',
        reviewStatus: null,
        reviewComment: null,
        reviewedById: null,
        reviewedAt: null,
        contentHash: null,
        baseImageBuildId: null,
        decisionId: null,
        reviewCarriedFromId: null,
        appliedMasks: null,
        ...patch
    });
}

async function newDecision(app: IApp, screenId: string, buildId: string, patch: Partial<ScreenDecisionEntity>) {
    return createPersistedEntity(ScreenDecisionEntity, {
        id: uuid7(),
        appId: app.id,
        screenId,
        kind: 'approved',
        fromImageBuildId: null,
        fromHash: null,
        toImageBuildId: null,
        toHash: null,
        buildId,
        branchId: app.branchId,
        buildScreenId: uuid7(),
        decidedById: ZERO_ID,
        decidedAt: new Date(),
        comment: null,
        revokedAt: null,
        revokedById: null,
        ...patch
    });
}

const put = (key: string, body: Buffer = Buffer.from('x')) => s3.uploadFile(body, key, 'image/png');
const up = (app: IApp, buildId: string, screenId: string) => s3.getPathForScreen(app.id, buildId, screenId);
const diffKey = (app: IApp, buildId: string, screenId: string) => s3.getPathForDiff(app.id, buildId, screenId);
const thumbKey = (app: IApp, buildId: string, screenId: string, rowId: string) => s3.getPathForThumbnail(app.id, buildId, screenId, rowId);

async function expectGone(keys: string[], msg: string) {
    for (const key of keys) assert(!(await s3.exists(key)), `${msg}: ${key} should be gone`);
}
async function expectKept(keys: string[], msg: string) {
    for (const key of keys) assert(await s3.exists(key), `${msg}: ${key} should still exist`);
}

// ---- tests -----------------------------------------------------------------------------------------------------------------

async function testListing() {
    console.log('\nTest: S3 listing (StartAfter, pagination, common prefixes)');
    const root = `screens/${uuid7()}/`;
    const keys = ['a', 'b', 'c', 'd', 'e'].map(k => `${root}${k}.bin`);
    for (const key of keys) await put(key);
    await put(`${root}sub/f.bin`);

    const after = await s3.listObjects(root, { startAfter: keys[1] });
    eq(
        after.objects.map(o => o.key),
        [keys[2], keys[3], keys[4], `${root}sub/f.bin`],
        'StartAfter returns only keys after the given one, sorted'
    );
    assert(
        after.objects.every(o => o.lastModified instanceof Date && typeof o.size === 'number'),
        'listing carries LastModified and Size'
    );

    // paging with StartAfter alone (what the cleaner does) visits every key exactly once, in order
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
        const page = await s3.listObjects(root, { startAfter: cursor, maxKeys: 2 });
        pages++;
        seen.push(...page.objects.map(o => o.key));
        if (!page.nextToken || !page.objects.length) break;
        cursor = page.objects[page.objects.length - 1].key;
    }
    eq(seen, [...keys, `${root}sub/f.bin`], 'paging by StartAfter sees every key once');
    assert(pages === 3, `maxKeys 2 over 6 keys is 3 pages (got ${pages})`);

    // the continuation token works too
    const first = await s3.listObjects(root, { maxKeys: 4 });
    assert(!!first.nextToken, 'a truncated page has a token');
    const rest = await s3.listObjects(root, { continuationToken: first.nextToken });
    eq(rest.objects.length, 2, 'the token continues after the first page');

    const prefixes = await s3.listCommonPrefixes(root);
    eq(prefixes.prefixes, [`${root}sub/`], 'common prefixes');

    const gone = await s3.deleteFiles([...keys, `${root}sub/f.bin`], 3);
    eq([gone.deleted.length, gone.failed.length], [6, 0], 'deleteFiles deletes each key');
    console.log('  StartAfter honoured by this S3: yes');
    console.log('  PASS');
}

/** One app that has an object for each rule, the garbage the cleaner should remove, and the things it must leave alone. */
async function testRules() {
    console.log('\nTest: keep rules and garbage, end to end');
    const app = await newApp();
    const [s1, s2, s3x, s4, s5, s6, s7] = await Promise.all(['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map(n => newScreen(app, n)));
    const garbage: string[] = [];
    const keep: string[] = [];

    // reference build R: stored upload (rule a), its diff, and a thumbnail for its own row
    const R = await newBuild(app, 'changes approved');
    const rRow = await newRow(app, R, s1, { status: 'changes approved' });
    for (const k of [up(app, R, s1), diffKey(app, R, s1), thumbKey(app, R, s1, rRow.id)]) {
        await put(k);
        keep.push(k);
    }

    // N: unchanged build, row pendingDeletion matched to R. Its upload goes; its diff and thumbnail stay (the row still exists and
    // the thumbnail endpoint serves it from R's image).
    const N = await newBuild(app, 'no changes');
    const nRow = await newRow(app, N, s1, { status: 'no changes', storageStatus: 'pendingDeletion', matchedBuildId: R, baseImageBuildId: R });
    await put(up(app, N, s1));
    garbage.push(up(app, N, s1));
    for (const k of [thumbKey(app, N, s1, nRow.id), diffKey(app, N, s1)]) {
        await put(k);
        keep.push(k);
    }

    // legacy chain: A matched to B, B pendingDeletion -> B's upload stays (rule b), and so does the diff A may fall back to
    const B = await newBuild(app, 'no changes');
    await newRow(app, B, s2, { status: 'no changes', storageStatus: 'pendingDeletion', matchedBuildId: R });
    const A = await newBuild(app, 'no changes');
    await newRow(app, A, s2, { status: 'no changes', storageStatus: 'pendingDeletion', matchedBuildId: B });
    await put(up(app, B, s2));
    await put(diffKey(app, B, s2));
    await put(up(app, A, s2));
    keep.push(up(app, B, s2), diffKey(app, B, s2));
    garbage.push(up(app, A, s2));

    // baseline source (rule c): O's pendingDeletion upload is the baseImageBuildId of a tombstone in P
    const O = await newBuild(app, 'no changes');
    await newRow(app, O, s3x, { status: 'no changes', storageStatus: 'pendingDeletion', matchedBuildId: R });
    const P = await newBuild(app, 'needs review');
    await newRow(app, P, s3x, { status: 'needs review', isRemoved: true, baseImageBuildId: O });
    await put(up(app, O, s3x));
    keep.push(up(app, O, s3x));

    // decisions (rule d): from-image of one, to-image of a revoked one; neither build has a row for the screen any more
    const D1 = await newBuild(app, 'needs review');
    const D2 = await newBuild(app, 'needs review');
    await newDecision(app, s4, P, { fromImageBuildId: D1 });
    await newDecision(app, s5, P, { toImageBuildId: D2, kind: 'rejected', revokedAt: new Date(), revokedById: ZERO_ID });
    await put(up(app, D1, s4));
    await put(up(app, D2, s5));
    keep.push(up(app, D1, s4), up(app, D2, s5));
    // ...but a decision on one screen does not keep another screen's upload in the same build
    await put(up(app, D1, s5));
    garbage.push(up(app, D1, s5));

    // orphans: a screen with no row (a lost clean slate), a tombstone's stray upload, a stale thumbnail from a replaced upload
    const G = await newBuild(app, 'needs review');
    const gRow = await newRow(app, G, s6, { status: 'needs review' });
    await put(up(app, G, s7));
    await put(up(app, G, s6));
    await put(thumbKey(app, G, s6, gRow.id));
    const staleThumb = thumbKey(app, G, s6, uuid7());
    await put(staleThumb);
    garbage.push(up(app, G, s7), staleThumb);
    keep.push(up(app, G, s6), thumbKey(app, G, s6, gRow.id));

    // builds that are not final are skipped entirely, as are keys of builds that have no row
    const skipped: string[] = [];
    for (const status of ['draft', 'processing', 'canceled', 'failed'] as const) {
        const b = await newBuild(app, status);
        const k = up(app, b, s1);
        await put(k);
        skipped.push(k);
    }
    const ghostBuild = uuid7();
    await put(up(app, ghostBuild, s1));
    skipped.push(up(app, ghostBuild, s1));

    // keys that are not ours
    const alien = [`screens/${app.id}/${G}/readme.txt`, `screens/${app.id}/loose.png`, `screens/${app.id}/${G}/${s6}.png.bak`];
    for (const k of alien) await put(k);

    // 1. young: with a real grace period nothing is deleted, and the garbage is counted as young
    const young = ctx({ graceMs: DAY, now: new Date() });
    await gc.sweepApp(app.id, young);
    eq(young.stats.deleted.count, 0, 'young garbage is not deleted');
    eq(young.stats.skippedYoung, garbage.length, 'young garbage is counted');
    await expectKept([...garbage, ...keep, ...skipped, ...alien], 'after the young pass');

    // 2. dry-run: reports what it would delete, deletes nothing, records no progress
    const sweepBeforeDry = await StorageSweepEntity.query().filter({ appId: app.id }).findOne();
    const dry = ctx({ mode: 'dry-run' });
    await gc.sweepApp(app.id, dry);
    eq(dry.stats.deleted.count, 0, 'dry-run deletes nothing');
    eq(dry.stats.wouldDelete.count, garbage.length, 'dry-run reports the garbage');
    eq(dry.stats.wouldDelete.bytes, garbage.length, 'dry-run reports the bytes (1 byte each)');
    eq((await StorageSweepEntity.query().filter({ appId: app.id }).findOne()).updatedAt, sweepBeforeDry.updatedAt, 'dry-run records no progress');
    await expectKept([...garbage, ...keep, ...skipped, ...alien], 'after the dry run');

    // 3. delete
    const real = ctx();
    await gc.sweepApp(app.id, real);
    eq(real.stats.deleted.count, garbage.length, 'delete mode deletes the garbage');
    eq(real.stats.deleteErrors, 0, 'no delete errors');
    eq(real.stats.unrecognized, alien.length, 'alien keys are counted as unrecognized');
    eq(real.stats.unknownBuild, 1, 'the key of a missing build is counted');
    await expectGone(garbage, 'garbage');
    await expectKept([...keep, ...skipped, ...alien], 'after the delete pass');
    eq(real.stats.garbage.upload + real.stats.garbage.diff + real.stats.garbage.thumb, garbage.length, 'garbage by kind adds up');
    const sweep = await StorageSweepEntity.query().filter({ appId: app.id }).findOne();
    assert(sweep.sweptAt !== null && sweep.cursor === null, 'a finished sweep records its time and clears the cursor');

    // 4. a second pass finds nothing
    const again = ctx();
    await gc.sweepApp(app.id, again);
    eq([again.stats.deleted.count, again.stats.wouldDelete.count], [0, 0], 'second pass has nothing to do');

    // 5. reclaimBuild on one build: the same rules, scoped to that build
    const R2 = await newBuild(app, 'no changes');
    await newRow(app, R2, s1, { status: 'no changes', storageStatus: 'pendingDeletion', matchedBuildId: R });
    await put(up(app, R2, s1));
    const reclaim = ctx();
    await gc.reclaimBuild(app.id, R2, undefined, reclaim);
    eq(reclaim.stats.deleted.count, 1, 'reclaimBuild deletes the build garbage');
    await expectGone([up(app, R2, s1)], 'reclaimed');
    await expectKept(keep, 'after reclaim');
    console.log('  PASS');
}

async function testCursorResumes() {
    console.log('\nTest: an interrupted sweep resumes from its cursor');
    const app = await newApp();
    const screen = await newScreen(app, 's');
    const builds: string[] = [];
    for (let i = 0; i < 5; i++) {
        const b = await newBuild(app, 'needs review');
        await put(up(app, b, screen)); // no row: garbage
        builds.push(b);
    }
    builds.sort();

    let flushes = 0;
    const first = ctx({ shouldStop: () => ++flushes > 2 });
    const finished = await gc.sweepApp(app.id, first);
    assert(!finished, 'the first run stopped before the end');
    assert(first.stats.outOfTime, 'and says it ran out of time');
    eq(first.stats.deleted.count, 2, 'two groups were done');
    const mid = await StorageSweepEntity.query().filter({ appId: app.id }).findOne();
    eq(mid.cursor, up(app, builds[1], screen), 'the cursor is the last key of the last finished group');
    assert(mid.sweptAt === null, 'a sweep in progress has not finished');
    await expectGone([up(app, builds[0], screen), up(app, builds[1], screen)], 'first two groups');
    await expectKept(
        builds.slice(2).map(b => up(app, b, screen)),
        'the rest'
    );

    const second = ctx();
    assert(await gc.sweepApp(app.id, second), 'the second run reaches the end');
    eq(second.stats.deleted.count, 3, 'it deletes only the remaining groups');
    const done = await StorageSweepEntity.query().filter({ appId: app.id }).findOne();
    assert(done.cursor === null && done.sweptAt !== null, 'finished: cursor cleared, time recorded');

    // run() respects the interval, and the command's force
    const notDue = ctx({ sweepIntervalMs: DAY });
    await gc.run(notDue, { appIdFilter: app.id });
    eq(notDue.stats.appsSwept, 0, 'an app swept within the interval is skipped');
    const forced = ctx({ sweepIntervalMs: DAY, force: true });
    await gc.run(forced, { appIdFilter: app.id });
    eq(forced.stats.appsSwept, 1, 'force sweeps it anyway');
    console.log('  PASS');
}

async function testPurge() {
    console.log('\nTest: purging soft-deleted apps');
    const seedFull = async (patch: Partial<AppEntity>) => {
        const app = await newApp(patch);
        const screen = await newScreen(app, 's');
        const keys: string[] = [];
        const builds: string[] = [];
        for (let i = 0; i < 3; i++) {
            const b = await newBuild(app, 'changes approved');
            builds.push(b);
            const row = await newRow(app, b, screen);
            for (const k of [up(app, b, screen), diffKey(app, b, screen), thumbKey(app, b, screen, row.id)]) {
                await put(k);
                keys.push(k);
            }
        }
        await createPersistedEntity(BuildShardEntity, {
            id: uuid7(),
            buildId: builds[0],
            shardIndex: 1,
            ciTokenHash: 'h',
            ciJobId: 'j',
            state: 'uploaded',
            manifestCount: 1,
            manifestHash: 'a'.repeat(64),
            runId: null,
            activeAt: new Date()
        });
        await newDecision(app, screen, builds[0], { toImageBuildId: builds[0] });
        await createPersistedEntity(StorageSweepEntity, { appId: app.id, sweptAt: null, cursor: 'x', updatedAt: new Date() });
        // a build with a lot of rows and a build in an odd status are purged too
        const draft = await newBuild(app, 'draft');
        await put(up(app, draft, screen));
        keys.push(up(app, draft, screen));
        return { app, keys, builds: [...builds, draft] };
    };
    const rowCounts = async (appId: string) => ({
        apps: await AppEntity.query().filter({ id: appId }).count(),
        builds: await BuildEntity.query().filter({ appId }).count(),
        screens: await BuildScreenEntity.query().filter({ appId }).count(),
        screenDefs: await ScreenEntity.query().filter({ appId }).count(),
        branches: await BranchEntity.query().filter({ appId }).count(),
        decisions: await ScreenDecisionEntity.query().filter({ appId }).count(),
        sweeps: await StorageSweepEntity.query().filter({ appId }).count()
    });

    const old = await seedFull({ deletedAt: new Date(Date.now() - 40 * DAY) });
    const recent = await seedFull({ deletedAt: new Date(Date.now() - 5 * DAY) });
    const live = await seedFull({});
    const before = await rowCounts(old.app.id);
    assert(before.apps === 1 && before.builds === 4 && before.screens === 3 && before.decisions === 1 && before.sweeps === 1, 'seeded rows');

    // dry-run: counts, changes nothing
    const dry = ctx({ mode: 'dry-run', purgeAfterDays: 30 });
    assert(!(await gc.purgeApp(old.app.id, dry)), 'dry-run purges nothing');
    eq(dry.stats.appsWouldPurge, 1, 'dry-run reports the purge');
    eq(dry.stats.wouldDelete.count, old.keys.length, 'dry-run counts the objects');
    await expectKept(old.keys, 'after the dry run');
    eq(await rowCounts(old.app.id), before, 'rows untouched by the dry run');

    // the recent and live apps are not purged, whatever is asked
    const none = ctx({ purgeAfterDays: 30 });
    assert(!(await gc.purgeApp(recent.app.id, none)), 'a recently deleted app is not purged');
    assert(!(await gc.purgeApp(live.app.id, none)), 'a live app is not purged');

    // a crash part way: objects half deleted and the build rows already gone; the next run finishes the job
    await s3.deleteFile(old.keys[0]);
    await BuildScreenEntity.query().filter({ appId: old.app.id }).deleteMany();

    const real = ctx({ purgeAfterDays: 30 });
    await gc.run(real, { appIdFilter: old.app.id });
    assert(real.stats.appsPurged >= 1, 'run() purged the old app');
    await expectGone(old.keys, 'purged app');
    const gone = await rowCounts(old.app.id);
    eq(Object.values(gone), [0, 0, 0, 0, 0, 0, 0], 'every row of the purged app is gone');

    await expectKept([...recent.keys, ...live.keys], 'other apps');
    eq(await rowCounts(recent.app.id), { apps: 1, builds: 4, screens: 3, screenDefs: 1, branches: 1, decisions: 1, sweeps: 1 }, 'recent app rows');
    eq((await rowCounts(live.app.id)).apps, 1, 'live app row');

    // purge after 0 days = the next run
    const zero = ctx({ purgeAfterDays: 0 });
    assert(await gc.purgeApp(recent.app.id, zero), 'with a 0 day delay the recently deleted app is purged');
    await expectGone(recent.keys, 'purged at 0 days');
    assert(!(await gc.purgeApp(old.app.id, zero)), 'purging an app that is gone does nothing');
    console.log('  PASS');
}

async function testUnknownPrefixes() {
    console.log('\nTest: prefixes that belong to no app');
    const ghostApp = uuid7();
    const build = uuid7();
    const screen = uuid7();
    const keys = [`screens/${ghostApp}/${build}/${screen}.png`, `screens/${ghostApp}/${build}/${screen}.diff.png`];
    const elsewhere = `other-things/${ghostApp}.png`;
    for (const k of [...keys, elsewhere]) await put(k);

    const report = ctx();
    await gc.sweepUnknownAppPrefixes(report, { appIdFilter: ghostApp });
    eq(report.stats.unknownAppPrefixes, [ghostApp], 'reported');
    await expectKept(keys, 'report only by default');

    const young = ctx({ deleteUnknownApps: true, graceMs: DAY, now: new Date() });
    await gc.sweepUnknownAppPrefixes(young, { appIdFilter: ghostApp });
    eq([young.stats.deleted.count, young.stats.skippedYoung], [0, 2], 'young objects are left');

    const dry = ctx({ mode: 'dry-run', deleteUnknownApps: true });
    await gc.sweepUnknownAppPrefixes(dry, { appIdFilter: ghostApp });
    eq([dry.stats.deleted.count, dry.stats.wouldDelete.count], [0, 2], 'dry-run counts');
    await expectKept(keys, 'after the dry run');

    // an app row exists: the prefix is not unknown
    const known = await newApp();
    const knownKey = `screens/${known.id}/${build}/${screen}.png`;
    await put(knownKey);
    const knownRun = ctx({ deleteUnknownApps: true });
    await gc.sweepUnknownAppPrefixes(knownRun, { appIdFilter: known.id });
    eq(knownRun.stats.unknownAppPrefixes, [], 'an app with a row is not unknown');
    await expectKept([knownKey], 'known app');

    const del = ctx({ deleteUnknownApps: true });
    await gc.sweepUnknownAppPrefixes(del, { appIdFilter: ghostApp });
    eq(del.stats.deleted.count, 2, 'deleted when allowed');
    await expectGone(keys, 'unknown app prefix');
    await expectKept([elsewhere], 'keys outside screens/');
    await s3.deleteFile(elsewhere);
    await s3.deleteFile(knownKey);
    console.log('  PASS');
}

async function testDeletedAppFence() {
    console.log('\nTest: a deleted app takes no CI uploads');
    const token = 'glcbt-gc-fence';
    const mk = async (patch: Partial<AppEntity>) => {
        const app = await newApp(patch);
        const build = await newBuild(app, 'draft', { ciTokenHash: hashCiToken(token), ciTokensExpireAt: new Date(Date.now() + 3600_000) });
        return { app, build };
    };
    const upload = (appId: string, buildId: string) =>
        facade.request(
            HttpRequest.POST(`/api/apps/${appId}/builds/${buildId}/screens`)
                .header('authorization', `Bearer ${token}`)
                .multiPart([{ name: 'image', file: PNG, fileName: 'shot.png' }])
        );
    const live = await mk({});
    const ok = await upload(live.app.id, live.build);
    assert(ok.statusCode === 200, `a live app takes the upload (${ok.statusCode} ${ok.body})`);
    const deleted = await mk({ deletedAt: new Date() });
    const res = await upload(deleted.app.id, deleted.build);
    assert(res.statusCode === 401, `a deleted app's upload is refused (${res.statusCode})`);
    eq(await BuildScreenEntity.query().filter({ buildId: deleted.build }).count(), 0, 'nothing was stored');
    console.log('  PASS');
}

async function testPendingImageServed() {
    console.log('\nTest: a pendingDeletion row serves the image it matched');
    const app = await newApp();
    const screen = await newScreen(app, 's');
    const R = await newBuild(app, 'changes approved');
    await newRow(app, R, screen, { status: 'changes approved' });
    await put(up(app, R, screen), PNG);
    const N = await newBuild(app, 'no changes');
    const nRow = await newRow(app, N, screen, { status: 'no changes', storageStatus: 'pendingDeletion', matchedBuildId: R, baseImageBuildId: R });
    await put(up(app, N, screen), PNG);

    // the cleaner removes N's own upload
    const reclaim = ctx();
    await gc.reclaimBuild(app.id, N, undefined, reclaim);
    await expectGone([up(app, N, screen)], 'N upload');
    await expectKept([up(app, R, screen)], 'R upload');

    const get = (kind: 'image' | 'thumbnail') =>
        facade.request(HttpRequest.GET(`/api/apps/${app.id}/builds/${N}/screens/${screen}/${kind}`).header('authorization', `Bearer ${jwt}`));
    const image = await get('image');
    assert(image.statusCode === 302 || image.statusCode === 307, `image redirects (${image.statusCode} ${image.body})`);
    const location = String(image.getHeader('location'));
    assert(location.includes(`/${R}/${screen}.png`), `the image comes from the matched build (${location})`);
    assert(!location.includes(`/${N}/`), 'and not from the cleaned-up build');

    const thumb = await get('thumbnail');
    assert(thumb.statusCode === 302 || thumb.statusCode === 307, `thumbnail redirects (${thumb.statusCode} ${thumb.body})`);
    assert(await s3.exists(thumbKey(app, N, screen, nRow.id)), 'the thumbnail was made from the matched image and stored under N');
    // the cleaner leaves that thumbnail alone, so it is not rebuilt on every view
    await gc.reclaimBuild(app.id, N, undefined, ctx());
    assert(await s3.exists(thumbKey(app, N, screen, nRow.id)), 'the thumbnail survives the next cleanup');

    // the tolerance preview has nothing of its own to compare for such a row: refused, not answered by comparing the baseline with itself
    await BuildEntity.query().filter({ id: N }).patchMany({ referenceBuildId: R, referenceSource: 'ancestor' });
    const compare = await facade.request(
        HttpRequest.POST(`/api/apps/${app.id}/builds/${N}/screens/${screen}/compare`)
            .header('authorization', `Bearer ${jwt}`)
            .json({ colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.01, masks: [] })
    );
    assert(compare.statusCode === 400, `compare is refused (${compare.statusCode} ${compare.body})`);

    // versions before 0.8 also marked approved rows pendingDeletion; those keep their upload, so the image is their own
    const L = await newBuild(app, 'changes approved');
    await newRow(app, L, screen, { status: 'changes approved', storageStatus: 'pendingDeletion', matchedBuildId: R });
    await put(up(app, L, screen), PNG);
    await gc.reclaimBuild(app.id, L, undefined, ctx());
    await expectKept([up(app, L, screen)], 'legacy approved row upload');
    const legacy = await facade.request(
        HttpRequest.GET(`/api/apps/${app.id}/builds/${L}/screens/${screen}/image`).header('authorization', `Bearer ${jwt}`)
    );
    assert(String(legacy.getHeader('location')).includes(`/${L}/${screen}.png`), 'a legacy approved row shows its own upload');
    console.log('  PASS');
}

async function testReclaimQueue() {
    console.log('\nTest: queueing build reclaims');
    const calls: { job: unknown; data: unknown; options: unknown }[] = [];
    const worker = {
        queueJob: async (job: unknown, data: unknown, options: unknown) => {
            calls.push({ job, data, options });
        }
    } as unknown as WorkerService;
    const logger = facade.get<ScopedLogger>(ScopedLogger);
    const config = (mode: string) => ({ ...facade.get<AppConfig>(AppConfig), STORAGE_GC_MODE: mode, STORAGE_GC_GRACE_HOURS: 12 }) as AppConfig;
    const app = uuid7();
    const b1 = uuid7();
    const b2 = uuid7();

    await queueBuildReclaims(worker, config('off'), logger, app, [b1]);
    eq(calls.length, 0, 'nothing is queued when the cleaner is off');
    await queueBuildReclaims(worker, config('dry-run'), logger, app, new Set([b1, b2]));
    eq(calls.length, 2, 'one job per build in dry-run');
    assert(
        calls.every(c => c.job === ReclaimBuildStorageJob),
        'the reclaim job'
    );
    eq(calls[0].options, { delay: 12 * 3_600_000 }, 'delayed by the grace period');
    eq(calls[0].data, { appId: app, buildId: b1 }, 'job data');
    await queueBuildReclaims(worker, config('delete'), logger, app, []);
    eq(calls.length, 2, 'no builds, no jobs');

    const failing = {
        queueJob: async () => {
            throw new Error('redis down');
        }
    } as unknown as WorkerService;
    await queueBuildReclaims(failing, config('delete'), logger, app, [b1]); // must not throw
    console.log('  PASS');
}

async function run() {
    const facadeLocal = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_storagegctest',
        useSavepoints: false
    });
    facade = facadeLocal;
    await ensureTestBucket();
    await facade.start();
    (facade.app.config as unknown as { ENFORCE_VCS_PROJECT_ACCESS: boolean }).ENFORCE_VCS_PROJECT_ACCESS = false;

    await createPersistedEntity(UserEntity, {
        id: ZERO_ID,
        name: 'GC Test User',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: true,
        vcsId: ZERO_ID,
        vcsUserId: ZERO_ID,
        vcsSession: sealVcsSession({ accessToken: 'a', expiresAt: Date.now() + 3600_000, refreshToken: 'r', redirectUri: 'http://localhost' })
    });
    jwt = await JWT.generate({ subject: ZERO_ID });
    gc = facade.get<StorageGcService>(StorageGcService);
    s3 = facade.get<S3Service>(S3Service);

    await testListing();
    await testRules();
    await testCursorResumes();
    await testPurge();
    await testUnknownPrefixes();
    await testDeletedAppFence();
    await testPendingImageServed();
    await testReclaimQueue();
}

run()
    .then(() => {
        console.log('\nAll storage cleanup tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });
