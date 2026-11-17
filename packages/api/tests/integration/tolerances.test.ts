import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, sleepSecs, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { PNG } from 'pngjs/browser';

import type { IBuildScreenCompareResponse, IBuildScreenResponse } from '../../src/controllers/BuildScreens.controller';
import type { IAppGalleryResponse } from '../../src/controllers/Screens.controller';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { S3Service } from '../../src/services/S3.service';
import { sealIntegrationConfig, sealVcsSession } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase, ensureTestBucket, useIsolatedRedisPrefix } from './db-defaults';

process.env.CI = 'true';
useIsolatedRedisPrefix('tolerances');

configureTestDatabase();

const APP_ID = 'f1234567-aaaa-bbbb-cccc-000000000001';
const MAIN_BRANCH_ID = 'f1234567-aaaa-bbbb-cccc-000000000002';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const TEST_CI_TOKEN = 'glcbt-test-ci-token';
const PROJECT_PATH = 'group/tolerance-test';

let mockJob = { id: 0, ref: 'main', sha: '' };
let mockServer: Server;
let mockPort: number;

run()
    .then(() => {
        console.log('\nAll tolerance tests passed!');
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

async function run() {
    await startMockGitLab();
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, { enableDatabase: true, databasePrefix: 'pixelci_tolerancetest' });
    await ensureTestBucket();
    await facade.start();

    await createPersistedEntity(UserEntity, {
        id: ZERO_ID,
        name: 'Tolerance Test User',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: true,
        vcsId: ZERO_ID,
        vcsUserId: ZERO_ID,
        vcsSession: sealVcsSession({ accessToken: 'a', expiresAt: Date.now() + 3600_000, refreshToken: 'r', redirectUri: 'http://localhost' })
    });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: ZERO_ID,
        name: 'Tolerance Test VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({ url: `http://127.0.0.1:${mockPort}`, clientId: 'c', clientSecret: 's' })
    });
    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'Tolerance Test App',
        defaultBranchId: MAIN_BRANCH_ID,
        projectPath: PROJECT_PATH,
        vcsProjectId: 1,
        vcsId: ZERO_ID
    });
    await createPersistedEntity(BranchEntity, { id: MAIN_BRANCH_ID, appId: APP_ID, name: 'main' });

    const jwt = await JWT.generate({ subject: ZERO_ID });
    const user = (r: HttpRequest) => r.header('authorization', `Bearer ${jwt}`);
    const ci = (r: HttpRequest) => r.header('authorization', `Bearer ${TEST_CI_TOKEN}`);

    async function call<T>(req: HttpRequest, expectedStatus = 200): Promise<T> {
        const res = await facade.request(req);
        if (res.statusCode !== expectedStatus) throw new Error(`Expected ${expectedStatus} but got ${res.statusCode}: ${res.body}`);
        return (expectedStatus === 200 ? res.json : undefined) as T;
    }

    let jobSeq = 0;
    async function runBuild(branch: string, screens: { name: string; file: string }[]) {
        jobSeq++;
        mockJob = { id: jobSeq, ref: branch, sha: String(jobSeq).padStart(40, '0') };
        const build = await call<{ id: string }>(ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds`)));
        const screenIds: Record<string, string> = {};
        for (const screen of screens) {
            const r = await call<{ screenId: string }>(
                ci(
                    HttpRequest.POST(`/api/apps/${APP_ID}/builds/${build.id}/screens`).multiPart([
                        { name: 'image', file: readFileSync(`${__dirname}/fixtures/${screen.file}`), fileName: `${screen.name}.png` }
                    ])
                )
            );
            screenIds[screen.name] = r.screenId;
        }
        await call(ci(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${build.id}/process`)));
        const deadline = Date.now() + 15_000;
        let status = 'processing';
        while (status === 'processing') {
            if (Date.now() > deadline) throw new Error('Build processing timed out');
            await sleepSecs(0.5);
            status = (await call<{ status: string }>(ci(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${build.id}/status`)))).status;
        }
        return { id: build.id, status, screenIds };
    }

    async function approve(buildId: string, screenIds: string[]) {
        for (const screenId of screenIds) {
            await call(
                user(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${buildId}/screens/${screenId}/review`)).json({
                    reviewStatus: 'approved',
                    comment: ''
                })
            );
        }
        await call(user(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${buildId}/approve`)));
    }

    // --- baseline on main
    console.log('\nSetup: baseline build on main');
    const base = await runBuild('main', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2.png' }
    ]);
    assertEq(base.status, 'needs review', 'baseline status');
    await approve(base.id, Object.values(base.screenIds));
    const f1 = base.screenIds['finder-1'];
    const f2 = base.screenIds['finder-2'];

    // --- gallery: baseline screens
    console.log('\nTest: gallery lists baseline screens with isBaseline: true');
    let gallery = await call<IAppGalleryResponse>(user(HttpRequest.GET(`/api/apps/${APP_ID}/screens`)));
    assertEq(gallery.baselineBuild?.id, base.id, 'baselineBuild id');
    assertEq(gallery.baselineBuild?.branchName, 'main', 'baselineBuild branchName');
    assertEq(
        gallery.screens.map(s => [s.name, s.image.isBaseline, s.image.buildId, s.image.sourceBuildId]),
        [
            ['finder-1', true, base.id, base.id],
            ['finder-2', true, base.id, base.id]
        ],
        'gallery screens'
    );
    assertEq(gallery.screens[0].tolerances, { colorTolerance: null, shiftTolerance: null, diffPctTolerance: null }, 'gallery tolerances');
    console.log('  PASS');

    // --- feature build: changed finder-2 (flagged at default) + an extra screen
    const feat = await runBuild('feature', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' },
        { name: 'extra', file: 'finder-1.png' }
    ]);
    assertEq(feat.status, 'needs review', 'feature build status at default tolerances');

    console.log('\nTest: gallery includes newer non-baseline screens');
    gallery = await call<IAppGalleryResponse>(user(HttpRequest.GET(`/api/apps/${APP_ID}/screens`)));
    assertEq(
        gallery.screens.map(s => [s.name, s.image.isBaseline]),
        [
            ['extra', false],
            ['finder-1', true],
            ['finder-2', true]
        ],
        'gallery with newer screen'
    );
    const extra = gallery.screens.find(s => s.name === 'extra')!;
    assertEq([extra.image.buildId, extra.image.sourceBuildId], [feat.id, feat.id], 'extra image build ids');
    console.log('  PASS');

    // --- GET builds/:id/screens includes tolerances
    console.log('\nTest: GET builds/:id/screens includes tolerances');
    const listed = await call<IBuildScreenResponse[]>(user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${feat.id}/screens`)));
    assertTrue(listed.length === 3, 'expected 3 screens');
    for (const s of listed)
        assertEq(s.tolerances, { colorTolerance: null, shiftTolerance: null, diffPctTolerance: null }, `tolerances for ${s.name}`);
    console.log('  PASS');

    // --- screen tolerance PUT
    console.log('\nTest: screen tolerances PUT persists and validates');
    const putUrl = `/api/apps/${APP_ID}/screens/${f2}/tolerances`;
    const saved = await call<unknown>(user(HttpRequest.PUT(putUrl)).json({ colorTolerance: 0.3, shiftTolerance: 2, diffPctTolerance: null }));
    assertEq(saved, { colorTolerance: 0.3, shiftTolerance: 2, diffPctTolerance: null }, 'PUT response');
    const listed2 = await call<IBuildScreenResponse[]>(user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${feat.id}/screens`)));
    assertEq(
        listed2.find(s => s.screenId === f2)!.tolerances,
        { colorTolerance: 0.3, shiftTolerance: 2, diffPctTolerance: null },
        'persisted tolerances'
    );
    for (const bad of [{ colorTolerance: 2 }, { shiftTolerance: 9 }, { shiftTolerance: 1.5 }, { diffPctTolerance: 101 }, { diffPctTolerance: -1 }]) {
        await call(user(HttpRequest.PUT(putUrl)).json({ colorTolerance: null, shiftTolerance: null, diffPctTolerance: null, ...bad }), 400);
    }
    assertEq(
        (await call<IBuildScreenResponse[]>(user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${feat.id}/screens`)))).find(s => s.screenId === f2)!
            .tolerances,
        { colorTolerance: 0.3, shiftTolerance: 2, diffPctTolerance: null },
        'tolerances unchanged after rejected PUTs'
    );

    // a looser tolerance can pass a change without review, so saving one needs the review role
    console.log('\nTest: screen tolerances PUT requires the review role');
    const readerId = '00000000-0000-0000-0000-0000000000b1';
    await createPersistedEntity(UserEntity, {
        id: readerId,
        name: 'Tolerance Test Reader',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: false,
        vcsId: ZERO_ID,
        vcsUserId: readerId,
        vcsSession: sealVcsSession({ accessToken: 'a', expiresAt: Date.now() + 3600_000, refreshToken: 'r', redirectUri: 'http://localhost' })
    });
    const readerJwt = await JWT.generate({ subject: readerId });
    const reader = (r: HttpRequest) => r.header('authorization', `Bearer ${readerJwt}`);
    await call(reader(HttpRequest.GET(`/api/apps/${APP_ID}/screens`)));
    await call(reader(HttpRequest.PUT(putUrl)).json({ colorTolerance: null, shiftTolerance: null, diffPctTolerance: 100 }), 403);
    assertEq(
        (await call<IBuildScreenResponse[]>(user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${feat.id}/screens`)))).find(s => s.screenId === f2)!
            .tolerances,
        { colorTolerance: 0.3, shiftTolerance: 2, diffPctTolerance: null },
        'tolerances unchanged after a non-reviewer PUT'
    );
    await call(
        user(HttpRequest.PUT(`/api/apps/${APP_ID}/screens/${ZERO_ID}/tolerances`)).json({
            colorTolerance: null,
            shiftTolerance: null,
            diffPctTolerance: null
        }),
        404
    );
    await call(user(HttpRequest.PUT(putUrl)).json({ colorTolerance: null, shiftTolerance: null, diffPctTolerance: null }));
    console.log('  PASS');

    // --- app PUT / GET
    console.log('\nTest: app PUT accepts tolerance overrides (admin) and GET exposes instanceTolerances');
    const appUrl = `/api/apps/${APP_ID}`;
    await call(user(HttpRequest.PUT(appUrl)).json({ colorTolerance: 0.4, shiftTolerance: 3, diffPctTolerance: 2.5 }));
    let app = await call<Record<string, unknown>>(user(HttpRequest.GET(appUrl)));
    assertEq([app.colorTolerance, app.shiftTolerance, app.diffPctTolerance], [0.4, 3, 2.5], 'app overrides');
    assertEq(app.instanceTolerances, { colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.01 }, 'instanceTolerances');
    await call(user(HttpRequest.PUT(appUrl)).json({ colorTolerance: 5 }), 400);
    await call(user(HttpRequest.PUT(appUrl)).json({ colorTolerance: null, shiftTolerance: null, diffPctTolerance: null }));
    app = await call<Record<string, unknown>>(user(HttpRequest.GET(appUrl)));
    assertEq([app.colorTolerance, app.shiftTolerance, app.diffPctTolerance], [null, null, null], 'app overrides reset');
    console.log('  PASS');

    // --- compare
    console.log('\nTest: compare returns sane numbers and passes flips with diffPctTolerance');
    const compareUrl = `/api/apps/${APP_ID}/builds/${feat.id}/screens/${f2}/compare`;
    const cmp = (t: object) =>
        call<IBuildScreenCompareResponse>(
            user(HttpRequest.POST(compareUrl)).json({ colorTolerance: 0.2, shiftTolerance: 1, diffPctTolerance: 0.01, masks: [], ...t })
        );
    const strict = await cmp({});
    assertTrue(strict.totalPixels > 0 && strict.diffPixels > 0, 'expected differing pixels');
    assertTrue(Math.abs(strict.diffPct - (strict.diffPixels / strict.totalPixels) * 100) < 1e-9, 'diffPct consistent with pixel counts');
    assertTrue(strict.diffPct > 0.01 && strict.passes === false, 'strict tolerance should fail');
    assertTrue(strict.diffImage.startsWith('data:image/png;base64,'), 'diffImage data URI');
    const loose = await cmp({ diffPctTolerance: Math.min(100, strict.diffPct + 0.001) });
    assertEq([loose.passes, loose.diffPct], [true, strict.diffPct], 'loose passes with same diffPct');
    const tight = await cmp({ diffPctTolerance: strict.diffPct - 0.0001 });
    assertEq(tight.passes, false, 'just-below tolerance fails');
    const lenient = await cmp({ colorTolerance: 1 });
    assertTrue(lenient.diffPixels <= strict.diffPixels, 'higher colour tolerance never adds diff pixels');
    await call(user(HttpRequest.POST(compareUrl)).json({ colorTolerance: 0.2, shiftTolerance: 1, masks: [] }), 400);
    await call(user(HttpRequest.POST(compareUrl)).json({ colorTolerance: 0.2, shiftTolerance: null, diffPctTolerance: 1, masks: [] }), 400);
    await call(user(HttpRequest.POST(compareUrl)).json({ colorTolerance: 3, shiftTolerance: 1, diffPctTolerance: 1, masks: [] }), 400);
    // 'extra' is not in the reference build
    await call(
        user(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${feat.id}/screens/${extra.screenId}/compare`)).json({
            colorTolerance: 0.2,
            shiftTolerance: 1,
            diffPctTolerance: 1,
            masks: []
        }),
        400
    );
    console.log('  PASS');

    // --- thumbnails are made when a build is processed
    console.log('\nTest: processing a build generates thumbnails for its own screens');
    {
        const s3 = facade.get<S3Service>(S3Service);
        const rows = await BuildScreenEntity.query().filter({ appId: APP_ID, buildId: base.id }).find();
        assertEq(rows.length, 2, 'baseline build screens');
        const deadline = Date.now() + 10_000;
        for (const row of rows) {
            const path = s3.getPathForThumbnail(APP_ID, base.id, row.screenId, row.id);
            while (!(await s3.exists(path))) {
                if (Date.now() > deadline) throw new Error(`Thumbnail was not generated: ${path}`);
                await sleepSecs(0.25);
            }
        }
    }
    console.log('  PASS');

    // --- thumbnails
    console.log('\nTest: thumbnail is generated on first request and served from storage');
    const thumbUrl = `/api/apps/${APP_ID}/builds/${base.id}/screens/${f1}/thumbnail`;
    for (const attempt of ['first', 'second']) {
        const res = await facade.request(user(HttpRequest.GET(thumbUrl)));
        assertEq(res.statusCode, 302, `${attempt} thumbnail request status`);
        const fetched = await fetch(String(res.getHeader('location')));
        assertEq(fetched.status, 200, `${attempt} thumbnail fetch status`);
        const thumb = PNG.sync.read(Buffer.from(await fetched.arrayBuffer()));
        const full = PNG.sync.read(readFileSync(`${__dirname}/fixtures/finder-1.png`));
        assertEq(thumb.width, Math.min(full.width, 640), `${attempt} thumbnail width`);
        assertTrue(thumb.height <= full.height, `${attempt} thumbnail height`);
    }
    await call(user(HttpRequest.GET(`/api/apps/${APP_ID}/builds/${base.id}/screens/${APP_ID}/thumbnail`)), 404);
    console.log('  PASS');

    // --- ProcessBuild honours per-screen override
    console.log('\nTest: ProcessBuild honours a per-screen diffPctTolerance override');
    const feat2 = await runBuild('feature-2', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' }
    ]);
    assertEq(feat2.status, 'needs review', 'flagged at default');
    await call(user(HttpRequest.PUT(putUrl)).json({ colorTolerance: null, shiftTolerance: null, diffPctTolerance: 100 }));
    const feat3 = await runBuild('feature-3', [
        { name: 'finder-1', file: 'finder-1.png' },
        { name: 'finder-2', file: 'finder-2-changed.png' }
    ]);
    assertEq(feat3.status, 'no changes', 'passes with looser per-screen override');
    console.log('  PASS');

    await call(user(HttpRequest.PUT(putUrl)).json({ colorTolerance: null, shiftTolerance: null, diffPctTolerance: null }));
    mockServer.close();
}
