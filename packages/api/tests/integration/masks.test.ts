import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, sleepSecs, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { PNG } from 'pngjs/browser';

import type { IBuildScreenCompareResponse, IBuildScreenResponse } from '../../src/controllers/BuildScreens.controller';
import type { IAppGalleryResponse } from '../../src/controllers/Screens.controller';
import type { IAppMasksResponse, IMaskRect, IScreenMasksResponse } from '../../src/services/Mask';

import { CoreAppOptions } from '../../src/app';
import { AppConfig } from '../../src/config';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { PixelMatchService } from '../../src/services/PixelMatch.service';
import { sealIntegrationConfig, sealVcsSession } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_masktest';

configureTestDatabase();

const APP_ID = 'f2345678-aaaa-bbbb-cccc-000000000001';
const MAIN_BRANCH_ID = 'f2345678-aaaa-bbbb-cccc-000000000002';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const TEST_CI_TOKEN = 'glcbt-test-ci-token';
const PROJECT_PATH = 'group/mask-test';

let mockJob = { id: 0, ref: 'main', sha: '' };
let mockServer: Server;
let mockPort: number;

run()
    .then(() => {
        console.log('\nAll mask tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

function startMockGitLab(): Promise<void> {
    return new Promise(resolve => {
        mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            const json = (body: unknown) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (req.url === '/api/v4/job') {
                if (req.headers['job-token'] !== TEST_CI_TOKEN) {
                    res.writeHead(401);
                    return res.end('Unauthorized');
                }
                return json({
                    id: mockJob.id,
                    ref: mockJob.ref,
                    pipeline: { project_id: 1, sha: mockJob.sha },
                    commit: { title: `commit ${mockJob.id}`, author_name: 'int-test' }
                });
            }
            if (req.method === 'POST' && /\/jobs\/[^/]+\/retry$/.test(req.url ?? '')) return json({ id: 999, pipeline: { id: 7 } });
            if (req.url?.startsWith('/api/v4/projects/')) return json({ id: 1, path_with_namespace: PROJECT_PATH });
            res.writeHead(404);
            res.end('Not found');
        });
        mockServer.listen(0, () => {
            mockPort = (mockServer.address() as { port: number }).port;
            resolve();
        });
    });
}

function assertEq(actual: unknown, expected: unknown, msg: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}
function assertTrue(cond: unknown, msg: string) {
    if (!cond) throw new Error(msg);
}

function readFixture(name: string) {
    return PNG.sync.read(readFileSync(`${__dirname}/fixtures/${name}`));
}

/** Bounding box of the pixels that differ between two same-sized fixtures. */
function diffBox(nameA: string, nameB: string): IMaskRect {
    const a = readFixture(nameA);
    const b = readFixture(nameB);
    assertEq([a.width, a.height], [b.width, b.height], `fixture sizes ${nameA} / ${nameB}`);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
            const i = (y * a.width + x) * 4;
            if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
                x0 = Math.min(x0, x);
                y0 = Math.min(y0, y);
                x1 = Math.max(x1, x);
                y1 = Math.max(y1, y);
            }
        }
    }
    assertTrue(x1 >= 0, `fixtures ${nameA} / ${nameB} should differ`);
    return { id: randomUUID(), x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, label: null };
}

async function run() {
    await startMockGitLab();
    // real connections (no savepoint isolation), so the concurrent-save test exercises the row lock
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_masktest',
        useSavepoints: false
    });
    await facade.start();

    await createPersistedEntity(UserEntity, {
        id: ZERO_ID,
        name: 'Mask Test User',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: true,
        vcsId: ZERO_ID,
        vcsUserId: ZERO_ID,
        vcsSession: sealVcsSession({ accessToken: 'a', expiresAt: Date.now() + 3600_000, refreshToken: 'r', redirectUri: 'http://localhost' })
    });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: ZERO_ID,
        name: 'Mask Test VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({ url: `http://127.0.0.1:${mockPort}`, clientId: 'c', clientSecret: 's' })
    });
    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'Mask Test App',
        defaultBranchId: MAIN_BRANCH_ID,
        projectPath: PROJECT_PATH,
        vcsProjectId: 1,
        vcsId: ZERO_ID
    });
    await createPersistedEntity(BranchEntity, { id: MAIN_BRANCH_ID, appId: APP_ID, name: 'main' });

    const readerId = '00000000-0000-0000-0000-0000000000b1';
    await createPersistedEntity(UserEntity, {
        id: readerId,
        name: 'Mask Test Reader',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: false,
        vcsId: ZERO_ID,
        vcsUserId: readerId,
        vcsSession: sealVcsSession({ accessToken: 'a', expiresAt: Date.now() + 3600_000, refreshToken: 'r', redirectUri: 'http://localhost' })
    });

    const jwt = await JWT.generate({ subject: ZERO_ID });
    const readerJwt = await JWT.generate({ subject: readerId });
    const user = (r: HttpRequest) => r.header('authorization', `Bearer ${jwt}`);
    const reader = (r: HttpRequest) => r.header('authorization', `Bearer ${readerJwt}`);
    const ci = (r: HttpRequest) => r.header('authorization', `Bearer ${TEST_CI_TOKEN}`);

    async function call<T>(req: HttpRequest, expectedStatus = 200): Promise<T> {
        const res = await facade.request(req);
        if (res.statusCode !== expectedStatus) throw new Error(`Expected ${expectedStatus} but got ${res.statusCode}: ${res.body}`);
        return (expectedStatus === 200 ? res.json : undefined) as T;
    }

    let jobSeq = 0;
    async function runBuild(branch: string, screens: { name: string; file?: string; data?: Buffer }[]) {
        jobSeq++;
        mockJob = { id: jobSeq, ref: branch, sha: String(jobSeq).padStart(40, '0') };
        const build = await call<{ id: string }>(ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds`)));
        const screenIds: Record<string, string> = {};
        for (const screen of screens) {
            const r = await call<{ screenId: string }>(
                ci(
                    HttpRequest.POST(`/api/apps/${APP_ID}/builds/${build.id}/screens`).multiPart([
                        { name: 'image', file: screen.data ?? readFileSync(`${__dirname}/fixtures/${screen.file}`), fileName: `${screen.name}.png` }
                    ])
                )
            );
            screenIds[screen.name] = r.screenId;
        }
        await call(ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${build.id}/process`)));
        const deadline = Date.now() + 60_000;
        let status = 'processing';
        while (status === 'processing') {
            if (Date.now() > deadline) throw new Error('Build processing timed out');
            await sleepSecs(0.5);
            status = (await call<{ status: string }>(ci(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${build.id}/status`)))).status;
        }
        return { id: build.id, status, screenIds };
    }

    async function review(buildId: string, screenId: string, reviewStatus: 'approved' | 'rejected', comment = '') {
        await call(user(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${buildId}/screens/${screenId}/review`)).json({ reviewStatus, comment }));
    }
    async function approve(buildId: string, screenIds: string[]) {
        for (const screenId of screenIds) await review(buildId, screenId, 'approved');
        await call(user(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${buildId}/approve`)));
    }

    const listScreens = (buildId: string) => call<IBuildScreenResponse[]>(user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${buildId}/screens`)));
    const currentOf = async (buildId: string, screenId: string) =>
        (await listScreens(buildId)).find(s => s.screenId === screenId)!.currentBuildScreen!;
    const stripIds = (masks: IMaskRect[] | null | undefined) => (masks ?? []).map(({ x, y, width, height }) => ({ x, y, width, height }));

    // screen masks: the PUT carries the version it was loaded at, read back from the last save
    const screenVersions: Record<string, number> = {};
    async function setScreenMasks(screenId: string, masks: IMaskRect[], inheritAppMasks = true) {
        const res = await call<IScreenMasksResponse>(
            user(HttpRequest.PUT(`/api/apps/${APP_ID}/screens/${screenId}/masks`)).json({
                masks,
                inheritAppMasks,
                baseVersion: screenVersions[screenId] ?? 0
            })
        );
        screenVersions[screenId] = res.version;
        return res;
    }
    let appVersion = 0;
    async function setAppMasks(masks: IMaskRect[]) {
        const res = await call<IAppMasksResponse>(user(HttpRequest.PUT(`/api/apps/${APP_ID}/masks`)).json({ masks, baseVersion: appVersion }));
        appVersion = res.version;
        return res;
    }

    const box1 = diffBox('finder-2.png', 'finder-2-changed.png'); // everything that differs between finder-2 and its changed version
    const box2 = diffBox('finder-2-changed.png', 'finder-2-changed-2.png'); // the difference between the two changed versions only

    // --- baseline on main
    console.log('\nSetup: baseline build on main, and a feature build with an unmasked change');
    const base = await runBuild('main', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2.png' }
    ]);
    assertEq(base.status, 'needs review', 'baseline status');
    await approve(base.id, Object.values(base.screenIds));
    const f1 = base.screenIds['finder-1'];
    const f2 = base.screenIds['finder-2'];

    const featOld = await runBuild('feature-old', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' }
    ]);
    assertEq(featOld.status, 'needs review', 'unmasked change needs review');
    assertEq((await currentOf(featOld.id, f2)).appliedMasks, [], 'appliedMasks is an empty list when nothing was masked');

    // --- saving screen masks
    console.log('\nTest: screen masks PUT persists, versions, and rejects invalid input');
    const putUrl = `/api/apps/${APP_ID}/screens/${f2}/masks`;
    const m1: IMaskRect = { id: randomUUID(), x: 10, y: 20, width: 30, height: 40, label: 'clock' };
    const saved = await setScreenMasks(f2, [m1]);
    assertEq(saved.masks, [m1], 'PUT response masks');
    assertEq([saved.inheritAppMasks, saved.version, saved.updatedByName], [true, 1, 'Mask Test User'], 'PUT response metadata');
    assertTrue(saved.updatedAt != null, 'updatedAt is set');

    const listed = (await listScreens(featOld.id)).find(s => s.screenId === f2)!;
    assertEq(listed.masks.masks, [m1], 'build screens list the screen masks');
    assertEq([listed.masks.version, listed.masks.updatedByName], [1, 'Mask Test User'], 'build screens list the mask metadata');
    const other = (await listScreens(featOld.id)).find(s => s.screenId === f1)!;
    assertEq(
        [other.masks.masks, other.masks.inheritAppMasks, other.masks.version, other.masks.updatedAt],
        [[], true, 0, null],
        'untouched screen defaults'
    );
    const gallery = await call<IAppGalleryResponse>(user(HttpRequest.GET(`/api/apps/${APP_ID}/screens`)));
    assertEq(gallery.screens.find(s => s.name === 'finder-2')!.masks.masks, [m1], 'gallery lists the screen masks');

    // a build processed before the save keeps its status and its record
    assertEq((await BuildEntity.query().filter({ id: featOld.id }).findOne()).status, 'needs review', 'existing build is not reprocessed');
    assertEq((await currentOf(featOld.id, f2)).appliedMasks, [], 'existing build keeps its appliedMasks');

    // a stale save is rejected and changes nothing
    await call(user(HttpRequest.PUT(putUrl)).json({ masks: [], inheritAppMasks: true, baseVersion: 0 }), 409);
    assertEq((await listScreens(featOld.id)).find(s => s.screenId === f2)!.masks.masks, [m1], 'masks unchanged after a stale save');

    const bad = (patch: object) => call(user(HttpRequest.PUT(putUrl)).json({ masks: [], inheritAppMasks: true, baseVersion: 1, ...patch }), 400);
    const ok = { id: randomUUID(), x: 0, y: 0, width: 5, height: 5, label: null };
    await bad({ masks: [{ ...ok, x: -1 }] });
    await bad({ masks: [{ ...ok, y: 1.5 }] });
    await bad({ masks: [{ ...ok, width: 0 }] });
    await bad({ masks: [{ ...ok, height: -3 }] });
    await bad({ masks: [{ ...ok, x: 99_999, width: 5 }] });
    await bad({ masks: [{ ...ok, id: 'not-a-uuid' }] });
    await bad({ masks: [ok, { ...ok, x: 9 }] });
    await bad({ masks: [{ ...ok, label: 'x'.repeat(81) }] });
    await bad({ masks: Array.from({ length: 51 }, () => ({ ...ok, id: randomUUID() })) });
    await bad({ masks: 'nope' });
    await bad({ inheritAppMasks: 'yes' });
    await bad({ baseVersion: -1 });
    await bad({ baseVersion: 1.5 });
    await call(user(HttpRequest.PUT(putUrl)).json({ masks: [] }), 400);
    await call(
        user(HttpRequest.PUT(putUrl)).json({
            masks: Array.from({ length: 50 }, () => ({ ...ok, id: randomUUID() })),
            inheritAppMasks: true,
            baseVersion: 1
        })
    );
    screenVersions[f2] = 2;
    assertEq((await setScreenMasks(f2, [])).version, 3, 'version keeps counting');
    console.log('  PASS');

    console.log('\nTest: screen masks PUT requires the review role, and a known screen');
    await call(reader(HttpRequest.GET(`/api/apps/${APP_ID}/screens`)));
    await call(reader(HttpRequest.PUT(putUrl)).json({ masks: [m1], inheritAppMasks: true, baseVersion: screenVersions[f2] }), 403);
    await call(user(HttpRequest.PUT(`/api/apps/${APP_ID}/screens/${ZERO_ID}/masks`)).json({ masks: [], inheritAppMasks: true, baseVersion: 0 }), 404);
    assertEq((await listScreens(featOld.id)).find(s => s.screenId === f2)!.masks.masks, [], 'masks unchanged after a non-reviewer PUT');
    console.log('  PASS');

    // --- app masks
    console.log('\nTest: app masks PUT is admin-only, versioned, and validated');
    const appMasksUrl = `/api/apps/${APP_ID}/masks`;
    await call(reader(HttpRequest.PUT(appMasksUrl)).json({ masks: [m1], baseVersion: 0 }), 403);
    const savedApp = await setAppMasks([m1]);
    assertEq(savedApp.masks, [m1], 'app PUT response masks');
    assertEq([savedApp.version, savedApp.updatedByName], [1, 'Mask Test User'], 'app PUT metadata');
    const shownApp = await call<{ masks: IMaskRect[]; masksVersion: number }>(user(HttpRequest.GET(`/api/apps/${APP_ID}`)));
    assertEq([shownApp.masks, shownApp.masksVersion], [[m1], 1], 'app show exposes masks and version');
    await call(user(HttpRequest.PUT(appMasksUrl)).json({ masks: [], baseVersion: 0 }), 409);
    await call(user(HttpRequest.PUT(appMasksUrl)).json({ masks: [{ ...ok, width: 0 }], baseVersion: 1 }), 400);
    await call(user(HttpRequest.PUT(appMasksUrl)).json({ masks: [ok, ok], baseVersion: 1 }), 400);
    await call(user(HttpRequest.PUT(appMasksUrl)).json({ masks: [] }), 400);
    await call(user(HttpRequest.PUT(`/api/apps/${ZERO_ID}/masks`)).json({ masks: [], baseVersion: 0 }), 404);
    assertEq((await setAppMasks([])).masks, [], 'app masks cleared');
    console.log('  PASS');

    // --- compare
    console.log('\nTest: compare takes masks, reports maskedPixels, and a mask flips passes');
    const compareUrl = `/api/apps/${APP_ID}/builds/${featOld.id}/screens/${f2}/compare`;
    const cmp = (masks: unknown, t: object = {}) =>
        call<IBuildScreenCompareResponse>(
            user(HttpRequest.POST(compareUrl)).json({ colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.01, masks, ...t })
        );
    const unmasked = await cmp([]);
    assertTrue(unmasked.diffPixels > 0 && unmasked.passes === false, 'unmasked change fails');
    assertEq(unmasked.maskedPixels, 0, 'maskedPixels without masks');
    const masked = await cmp([box1]);
    assertEq([masked.diffPixels, masked.diffPct, masked.passes], [0, 0, true], 'masking the whole change passes');
    assertEq(masked.maskedPixels, box1.width * box1.height, 'maskedPixels is the clipped mask area');
    assertEq(masked.totalPixels, unmasked.totalPixels, 'totalPixels still counts the whole canvas');
    const partial = await cmp([{ ...box1, width: Math.floor(box1.width / 2) }]);
    assertTrue(partial.diffPixels > 0 && partial.diffPixels < unmasked.diffPixels, 'a partial mask removes part of the change');
    assertTrue(
        Math.abs(partial.diffPct - (partial.diffPixels / (partial.totalPixels - partial.maskedPixels)) * 100) < 1e-9,
        'diffPct is over the unmasked pixels'
    );
    const overlap = await cmp([box1, { ...box1, id: randomUUID() }]);
    assertEq(overlap.maskedPixels, masked.maskedPixels, 'overlapping masks count once');
    assertTrue(masked.diffImage.startsWith('data:image/png;base64,'), 'diffImage data URI');
    const offCanvas = await cmp([{ id: randomUUID(), x: 50_000, y: 50_000, width: 10, height: 10, label: null }]);
    assertEq([offCanvas.maskedPixels, offCanvas.diffPixels], [0, unmasked.diffPixels], 'a mask off the canvas masks nothing');
    await call(user(HttpRequest.POST(compareUrl)).json({ colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 1 }), 400);
    await call(
        user(HttpRequest.POST(compareUrl)).json({ colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 1, masks: [{ ...box1, width: 0 }] }),
        400
    );
    // compare carries the app's masks and the screen's together; each is saved on its own, so they may share an id
    const sharedId = await cmp([box1, box1]);
    assertEq(sharedId.maskedPixels, masked.maskedPixels, 'masks sharing an id are accepted by compare');
    await call(
        user(HttpRequest.POST(compareUrl)).json({
            colorTolerance: 0.2,
            shiftTolerance: 1,
            diffPctTolerance: 1,
            masks: Array.from({ length: 101 }, () => ({ ...box1, id: randomUUID() }))
        }),
        400
    );
    console.log('  PASS');

    // --- processing: screen masks
    console.log('\nTest: ProcessBuild ignores a change inside a screen mask and records appliedMasks');
    await setScreenMasks(f2, [box1]);
    const featMasked = await runBuild('feature-masked', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' }
    ]);
    assertEq(featMasked.status, 'no changes', 'masked change gives no changes');
    assertEq(stripIds((await currentOf(featMasked.id, f2)).appliedMasks), stripIds([box1]), 'appliedMasks written for the masked screen');
    assertEq((await currentOf(featMasked.id, f2)).appliedMasks, [box1], 'appliedMasks keeps ids and labels');
    assertEq((await currentOf(featMasked.id, f1)).appliedMasks, [], 'unmasked screen has an empty appliedMasks');
    assertEq((await BuildEntity.query().filter({ id: featOld.id }).findOne()).status, 'needs review', 'older build still needs review');
    console.log('  PASS');

    // --- processing: app masks combine with screen masks, and a screen can opt out
    console.log('\nTest: app masks apply to every screen, combine with screen masks, and can be opted out of');
    await setScreenMasks(f2, []);
    await setAppMasks([box1]);
    const featApp = await runBuild('feature-app', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' }
    ]);
    assertEq(featApp.status, 'no changes', 'app mask covers the change');
    assertEq((await currentOf(featApp.id, f2)).appliedMasks, [box1], 'app mask recorded on f2');
    assertEq((await currentOf(featApp.id, f1)).appliedMasks, [box1], 'app mask recorded on every screen');

    const m2 = { id: randomUUID(), x: 1, y: 2, width: 3, height: 4, label: 'own' };
    await setScreenMasks(f2, [m2]);
    const featCombined = await runBuild('feature-combined', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' }
    ]);
    assertEq(featCombined.status, 'no changes', 'combined masks still cover the change');
    assertEq((await currentOf(featCombined.id, f2)).appliedMasks, [box1, m2], 'app masks come first, then the screen masks');

    await setScreenMasks(f2, [], false);
    const featOptOut = await runBuild('feature-optout', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' }
    ]);
    assertEq(featOptOut.status, 'needs review', 'opting out of app masks brings the change back');
    assertEq((await currentOf(featOptOut.id, f2)).appliedMasks, [], 'opted-out screen records no masks');
    assertEq((await currentOf(featOptOut.id, f1)).appliedMasks, [box1], 'other screens still use the app mask');
    assertEq((await listScreens(featOptOut.id)).find(s => s.screenId === f2)!.masks.inheritAppMasks, false, 'inheritAppMasks is exposed');

    await setScreenMasks(f2, [], true);
    await setAppMasks([]);
    console.log('  PASS');

    // --- processing: carried reviews
    console.log('\nTest: carried review decisions use the masked comparison');
    const carryA = await runBuild('carry-a', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' }
    ]);
    assertEq(carryA.status, 'needs review', 'carry-a needs review');
    await review(carryA.id, f2, 'rejected', 'not this');

    const carryB = await runBuild('carry-b', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed-2.png' }
    ]);
    assertEq(carryB.status, 'needs review', 'carry-b needs review');
    assertEq((await currentOf(carryB.id, f2)).reviewStatus, null, 'no decision is carried without a mask');

    await setScreenMasks(f2, [box2]);
    const carryC = await runBuild('carry-c', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed-2.png' }
    ]);
    assertEq(carryC.status, 'needs review', 'carry-c still differs from the reference outside the mask');
    const carried = await currentOf(carryC.id, f2);
    assertEq([carried.reviewStatus, carried.reviewComment], ['rejected', 'not this'], 'the decision is carried across the masked region');
    console.log('  PASS');

    // --- processing: cross-branch approvals
    console.log('\nTest: a change differing only inside a mask matches an approval made on another branch');
    const xbA = await runBuild('xb-a', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' }
    ]);
    assertEq(xbA.status, 'needs review', 'xb-a needs review');
    await review(xbA.id, f2, 'approved');
    await call(user(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${xbA.id}/approve`)));

    await setScreenMasks(f2, []);
    const xbControl = await runBuild('xb-control', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed-2.png' }
    ]);
    assertEq(xbControl.status, 'needs review', 'without the mask the other approval does not match');

    // xb-control differs from the reference (base) and from xb-a's approved change. Checking that candidate must not clobber the
    // stored diff: the review UI shows the reference as the left-hand image, so the stored diff must be against the reference.
    const storedDiff = async (buildId: string, screenId: string) => {
        const res = await facade.request(user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${buildId}/screens/${screenId}/diff`)));
        assertEq(res.statusCode, 302, 'diff redirects to the stored image');
        return Buffer.from(await (await fetch(String(res.getHeader('location')))).arrayBuffer());
    };
    const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
    const localDiff = async (leftFile: string, rightFile: string) => {
        const svc = new PixelMatchService(quiet, facade.app.config as AppConfig);
        const diff = await svc.getDiff(
            readFileSync(`${__dirname}/fixtures/${leftFile}`),
            readFileSync(`${__dirname}/fixtures/${rightFile}`),
            0.2,
            1,
            []
        );
        return diff.getDiffPng();
    };
    const xbStored = await storedDiff(xbControl.id, f2);
    const xbReferenceDiff = await localDiff('finder-2.png', 'finder-2-changed-2.png');
    assertTrue(xbStored.equals(xbReferenceDiff), 'stored diff for the build screen is the diff against the reference build');
    // and it is not the diff against xb-a's approved change (which is what a candidate comparison would have stored)
    const xbCandidateDiff = await localDiff('finder-2-changed.png', 'finder-2-changed-2.png');
    assertTrue(!xbStored.equals(xbCandidateDiff), 'stored diff is not xb-a candidate comparison output');

    await setScreenMasks(f2, [box2]);
    const xbB = await runBuild('xb-b', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed-2.png' }
    ]);
    assertEq(xbB.status, 'changes approved', 'with the mask the other branch approval matches');
    const xbScreen = await currentOf(xbB.id, f2);
    assertEq([xbScreen.status, xbScreen.approvalBuildId], ['changes approved', xbA.id], 'the approval is inherited from xb-a');
    console.log('  PASS');

    // --- processing: previous approved build on the same branch
    console.log('\nTest: a change differing only inside a mask matches the previous approved build on the same branch');
    // finder-1 has never had a change approved on any branch, so only the same-branch path can match here
    const box3 = diffBox('finder-1-changed.png', 'finder-1-changed-2.png');
    await setScreenMasks(f2, []);
    const prevScreens = (file: string) => [
        { name: 'finder-1', file },
        { name: 'finder-2', file: 'finder-2.png' }
    ];
    const prevA = await runBuild('prev-branch', prevScreens('finder-1-changed.png'));
    assertEq(prevA.status, 'needs review', 'prev-a needs review');
    await approve(prevA.id, [f1]);
    assertEq((await BuildEntity.query().filter({ id: prevA.id }).findOne()).status, 'changes approved', 'prev-a is approved');

    const prevControl = await runBuild('prev-branch', prevScreens('finder-1-changed-2.png'));
    assertEq(prevControl.status, 'needs review', 'without the mask the change is not matched to the previous build');

    await setScreenMasks(f1, [box3]);
    const prevB = await runBuild('prev-branch', prevScreens('finder-1-changed-2.png'));
    assertEq(prevB.status, 'changes approved', 'with the mask the previous approved build on the branch matches');
    const prevScreen = await currentOf(prevB.id, f1);
    assertEq([prevScreen.status, prevScreen.approvalBuildId], ['changes approved', prevA.id], 'the approval comes from prev-a');
    assertEq(prevScreen.appliedMasks, [box3], 'appliedMasks recorded on the previous-build path');
    await setScreenMasks(f1, []);
    console.log('  PASS');

    // --- concurrent saves
    console.log('\nTest: two concurrent screen mask saves from the same version: one wins, one gets 409');
    const raceBase = screenVersions[f2];
    const race = (box: IMaskRect) =>
        facade.request(user(HttpRequest.PUT(putUrl)).json({ masks: [box], inheritAppMasks: true, baseVersion: raceBase }));
    const raceA: IMaskRect = { id: randomUUID(), x: 1, y: 1, width: 10, height: 10, label: 'a' };
    const raceB: IMaskRect = { id: randomUUID(), x: 2, y: 2, width: 20, height: 20, label: 'b' };
    const raceResults = await Promise.all([race(raceA), race(raceB)]);
    assertEq(raceResults.map(r => r.statusCode).sort(), [200, 409], 'exactly one concurrent save succeeds and the other conflicts');
    const winner = raceResults.findIndex(r => r.statusCode === 200) === 0 ? raceA : raceB;
    const stored = (await listScreens(prevB.id)).find(s => s.screenId === f2)!.masks;
    assertEq([stored.masks, stored.version], [[winner], raceBase + 1], 'only the winning save was applied, once');
    console.log('  PASS');

    // --- nothing above reprocessed an earlier build
    assertEq(
        (await BuildEntity.query().filter({ id: featOld.id }).findOne()).status,
        'needs review',
        'the first feature build was never reprocessed'
    );

    // --- processing: oversized comparison canvas
    console.log('\nTest: a pair whose padded canvas exceeds the pixel cap counts as changed and still gets a diff stored');
    const solid = (w: number, h: number, rgb: [number, number, number]) => {
        const png = new PNG({ width: w, height: h });
        for (let i = 0; i < w * h; i++) {
            png.data[i * 4] = rgb[0];
            png.data[i * 4 + 1] = rgb[1];
            png.data[i * 4 + 2] = rgb[2];
            png.data[i * 4 + 3] = 255;
        }
        return PNG.sync.write(png);
    };
    // each is 2.4 MP, within the cap below (and the finder fixtures); padded together they are 2400x2400 = 5.76 MP
    const config = facade.app.config as unknown as { SCREEN_MAX_PIXELS: number };
    const originalCap = config.SCREEN_MAX_PIXELS;
    config.SCREEN_MAX_PIXELS = 3_000_000;
    try {
        const stable = [
            { name: 'finder-1', file: 'finder-1.png' },
            { name: 'finder-2', file: 'finder-2.png' }
        ];
        const bigBase = await runBuild('main', [...stable, { name: 'wide', data: solid(2400, 1000, [0, 0, 255]) }]);
        await approve(bigBase.id, [bigBase.screenIds['wide']]);
        const wideId = bigBase.screenIds['wide'];

        const bigFeat = await runBuild('oversize', [...stable, { name: 'wide', data: solid(1000, 2400, [0, 255, 0]) }]);
        assertEq(bigFeat.status, 'needs review', 'oversized pair is flagged, processing did not crash');
        assertEq((await currentOf(bigFeat.id, wideId)).status, 'needs review', 'oversized screen needs review');
        const diffPng = PNG.sync.read(await storedDiff(bigFeat.id, wideId));
        assertEq([diffPng.width, diffPng.height], [1000, 2400], 'stored diff is the new screenshot, not the padded canvas');

        const preview = await call<IBuildScreenCompareResponse>(
            user(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${bigFeat.id}/screens/${wideId}/compare`)).json({
                colorTolerance: 0.2,
                shiftTolerance: 1,
                diffPctTolerance: 0.01,
                masks: []
            })
        );
        assertEq([preview.canvasTooLarge, preview.passes, preview.diffPct], [true, false, 100], 'compare endpoint reports canvasTooLarge');
    } finally {
        config.SCREEN_MAX_PIXELS = originalCap;
    }
    console.log('  PASS');

    mockServer.close();
}
