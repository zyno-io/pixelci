import { assert, type ReceiveType } from '@zyno-io/ts-reflection';
import { HttpRequest, RequestBuilder } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, sleepSecs, TestingFacade, TestingHelpers, uuid7 } from '@zyno-io/ts-server-foundation';
import { readFileSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';
import { ScreenEntity } from '../../src/entities/Screen.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { configureTestDatabase } from './db-defaults';
import { IScenario, TestScenarios } from './scenarios';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

run()
    .then(() => process.exit(0))
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

const APP_ID = 'd0990c28-6aad-497e-9f05-0264414391fa';
const MAIN_BRANCH_ID = '65e94169-1a90-449e-b42f-9094700c4d58';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const TEST_CI_TOKEN = 'glcbt-test-ci-token';
const PROJECT_PATH = 'int-test';

// Mutable state for the mock GitLab server — updated per scenario
let mockJobData = { id: 0, ref: 'main', sha: '0'.repeat(40), title: 'init', author: 'init' };

/**
 * Non-admin users for the approval-rights tests. `permissions` is what GET /projects/:id reports for the user's token;
 * `memberLevel` is the effective level GET /projects/:id/members/all/:vcsUserId reports (undefined → 404).
 */
const ROLE_USERS = {
    reporter: {
        id: 'a0000000-0000-0000-0000-000000000020',
        vcsUserId: '120',
        token: 'tok-reporter',
        permissions: { project_access: { access_level: 20, notification_level: 3 }, group_access: null },
        memberLevel: 20
    },
    developer: {
        id: 'a0000000-0000-0000-0000-000000000030',
        vcsUserId: '130',
        token: 'tok-developer',
        permissions: { project_access: { access_level: 30, notification_level: 3 }, group_access: null },
        memberLevel: 30
    },
    maintainer: {
        id: 'a0000000-0000-0000-0000-000000000040',
        vcsUserId: '140',
        token: 'tok-maintainer',
        permissions: { project_access: { access_level: 20, notification_level: 3 }, group_access: { access_level: 40, notification_level: 3 } },
        memberLevel: 40
    },
    // Access only through a group the project is shared with: GET /projects/:id shows no membership at all.
    shared: {
        id: 'a0000000-0000-0000-0000-000000000031',
        vcsUserId: '131',
        token: 'tok-shared',
        permissions: { project_access: null, group_access: null },
        memberLevel: 30
    },
    // A direct Developer who is Maintainer through a shared group.
    sharedMaintainer: {
        id: 'a0000000-0000-0000-0000-000000000041',
        vcsUserId: '141',
        token: 'tok-shared-maintainer',
        permissions: { project_access: { access_level: 30, notification_level: 3 }, group_access: null },
        memberLevel: 40
    },
    // A shared-group Developer whose membership is still awaiting approval (user cap): not active, so not counted.
    awaiting: {
        id: 'a0000000-0000-0000-0000-000000000032',
        vcsUserId: '132',
        token: 'tok-awaiting',
        permissions: { project_access: null, group_access: null },
        memberLevel: 30,
        membershipState: 'awaiting'
    },
    // A shared-group Developer whose first members/all lookup fails with a 502.
    flaky: {
        id: 'a0000000-0000-0000-0000-000000000033',
        vcsUserId: '133',
        token: 'tok-flaky',
        permissions: { project_access: null, group_access: null },
        memberLevel: 30,
        failFirstLookup: true
    },
    // Guest: used once, for the read threshold, so neither cache holds anything for it.
    guest: {
        id: 'a0000000-0000-0000-0000-000000000010',
        vcsUserId: '110',
        token: 'tok-guest',
        permissions: { project_access: { access_level: 10, notification_level: 3 }, group_access: null },
        memberLevel: 10
    }
} as const;
type IRoleUser = (typeof ROLE_USERS)[keyof typeof ROLE_USERS];
/** `${token} ${vcsUserId}` for every members/all lookup the mock served. */
const memberLookups: string[] = [];
/** Bearer token of every GET /projects/1 the mock served to a role user. */
const projectLookups: string[] = [];

function startMockGitLab(): Promise<number> {
    return new Promise(resolve => {
        const server = createServer((req: IncomingMessage, res: ServerResponse) => {
            const token = req.headers['job-token'] as string | undefined;

            if (req.url === '/api/v4/job') {
                if (token !== TEST_CI_TOKEN) {
                    res.writeHead(401);
                    res.end('Unauthorized');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        id: mockJobData.id,
                        ref: mockJobData.ref,
                        pipeline: { project_id: 1, sha: mockJobData.sha },
                        commit: { title: mockJobData.title, author_name: mockJobData.author }
                    })
                );
                return;
            }

            if (req.method === 'POST' && /^\/api\/v4\/projects\/[^/]+\/jobs\/[^/]+\/retry$/.test(req.url ?? '')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: 999, pipeline: { id: 7 } }));
                return;
            }

            const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
            const roleUser = Object.values(ROLE_USERS).find(u => u.token === bearer);

            const memberMatch = /^\/api\/v4\/projects\/1\/members\/all\/([^/]+)$/.exec(req.url ?? '');
            if (memberMatch) {
                memberLookups.push(`${bearer} ${memberMatch[1]}`);
                if (roleUser && 'failFirstLookup' in roleUser && memberLookups.filter(l => l.startsWith(`${bearer} `)).length === 1) {
                    res.writeHead(502);
                    res.end('Bad Gateway');
                    return;
                }
                if (!roleUser || roleUser.vcsUserId !== memberMatch[1]) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: '404 Not found' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        id: Number(roleUser.vcsUserId),
                        state: 'active',
                        membership_state: 'membershipState' in roleUser ? roleUser.membershipState : 'active',
                        access_level: roleUser.memberLevel
                    })
                );
                return;
            }

            if (req.url?.startsWith('/api/v4/projects/')) {
                if (roleUser && req.url === '/api/v4/projects/1') projectLookups.push(bearer);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: 1, path_with_namespace: PROJECT_PATH, ...(roleUser ? { permissions: roleUser.permissions } : {}) }));
                return;
            }

            res.writeHead(404);
            res.end('Not found');
        });

        server.listen(0, () => {
            resolve((server.address() as { port: number }).port);
        });
    });
}

async function run() {
    const mockGitLabPort = await startMockGitLab();

    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_test'
    });
    await facade.start();

    await createBaseEntities(mockGitLabPort);

    for (const [index, scenario] of Object.entries(TestScenarios)) {
        console.log(`\nRunning scenario ${Number(index) + 1} of ${TestScenarios.length}...`);
        await runScenario(facade, index, scenario);
        console.log(`Scenario ${Number(index) + 1} completed.`);
    }

    await testApprovalRights(facade);
    await testMalformedIds(facade);
    await testBuildsPagination(facade);
    await testImageRoutesRequireStoredRow(facade);
}

async function testApprovalRights(facade: TestingFacade) {
    console.log("\nTest: reviewing and approving require the app's minimum VCS role (non-admin users)");

    for (const u of Object.values(ROLE_USERS)) {
        await createPersistedEntity(UserEntity, {
            id: u.id,
            name: `Role ${u.token}`,
            createdAt: new Date(),
            lastLoginAt: new Date(),
            isAdmin: false,
            vcsId: ZERO_ID,
            vcsUserId: u.vcsUserId,
            vcsSession: { accessToken: u.token, expiresAt: Date.now() + 60 * 60 * 1000, refreshToken: 'r', redirectUri: 'http://localhost' }
        });
    }
    const adminJwt = await JWT.generate({ subject: ZERO_ID });
    const jwtOf = (u: IRoleUser) => JWT.generate({ subject: u.id });
    const authed = (r: RequestBuilder, jwt: string) => r.header('authorization', `Bearer ${jwt}`);

    const branch = await createPersistedEntity(BranchEntity, { id: '65e94169-1a90-449e-b42f-000000000001', appId: APP_ID, name: 'approval-rights' });
    let n = 0;
    /** A build awaiting review with one changed screen. */
    async function reviewBuild() {
        n++;
        const build = await createPersistedEntity(BuildEntity, {
            id: uuid7(),
            appId: APP_ID,
            branchId: branch.id,
            createdAt: new Date(),
            commitHash: `ar${n}`.padStart(40, '0'),
            commitSubject: 'approval rights',
            commitAuthor: 'int-test',
            ciJobId: String(9000 + n),
            ciTokenHash: null,
            ciReadTokenHashes: [],
            status: 'needs review',
            approvedById: null,
            approvedAt: null
        });
        const screen = await createPersistedEntity(ScreenEntity, { id: uuid7(), appId: APP_ID, name: `approval-rights-${n}` });
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
        return { buildId: build.id, screenId: screen.id };
    }
    const review = async (jwt: string, b: { buildId: string; screenId: string }) =>
        facade.request(
            authed(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${b.buildId}/screens/${b.screenId}/review`), jwt).json({
                reviewStatus: 'approved',
                comment: ''
            })
        );
    const approve = async (jwt: string, b: { buildId: string }) =>
        facade.request(authed(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${b.buildId}/approve`), jwt));
    const setThreshold = async (jwt: string, approvalMinRole: unknown) =>
        facade.request(authed(HttpRequest.PUT(`/api/apps/${APP_ID}`), jwt).json({ approvalMinRole }));
    const expectStatus = (res: { statusCode: number; body: unknown }, code: number, label: string) => {
        if (res.statusCode !== code) throw new Error(`${label}: expected ${code}, got ${res.statusCode}: ${res.body}`);
    };
    /** Review then approve one fresh build as `u`, expecting `code` from both. */
    async function expectReviewRights(u: IRoleUser, code: 200 | 403, label: string) {
        const jwt = await jwtOf(u);
        const b = await reviewBuild();
        expectStatus(await review(jwt, b), code, `${label}: review`);
        expectStatus(await approve(jwt, b), code, `${label}: approve`);
        const build = await BuildEntity.query().filter({ id: b.buildId }).findOne();
        const screen = await BuildScreenEntity.query().filter({ buildId: b.buildId }).findOne();
        if (code === 200 && (build.status !== 'changes approved' || build.approvedById !== u.id || screen.reviewedById !== u.id)) {
            throw new Error(`${label}: expected an approved build, got ${build.status} approvedBy=${build.approvedById}`);
        }
        if (code === 403 && (build.status !== 'needs review' || screen.reviewStatus !== null)) {
            throw new Error(`${label}: a denied caller changed the build (${build.status}, review ${screen.reviewStatus})`);
        }
    }

    const app = await AppEntity.query().filter({ id: APP_ID }).findOne();
    if (app.approvalMinRole !== 'write') throw new Error(`apps.approvalMinRole should default to write, got ${app.approvalMinRole}`);

    // write (the default)
    await expectReviewRights(ROLE_USERS.reporter, 403, 'write threshold, Reporter');
    await expectReviewRights(ROLE_USERS.developer, 200, 'write threshold, Developer');
    await expectReviewRights(ROLE_USERS.shared, 200, 'write threshold, Developer through a shared group');
    if (!memberLookups.includes(`${ROLE_USERS.shared.token} ${ROLE_USERS.shared.vcsUserId}`)) throw new Error('expected a members/all lookup');
    await expectReviewRights(ROLE_USERS.maintainer, 200, 'write threshold, Maintainer through a parent group');
    if (memberLookups.some(l => l.startsWith(`${ROLE_USERS.maintainer.token} `))) {
        throw new Error('members/all must not be called when /projects/:id already shows Maintainer');
    }
    await expectReviewRights(ROLE_USERS.awaiting, 403, 'write threshold, awaiting shared-group membership');
    // A failed members/all lookup denies, but isn't cached: the next attempt succeeds.
    {
        const jwt = await jwtOf(ROLE_USERS.flaky);
        const b = await reviewBuild();
        expectStatus(await review(jwt, b), 403, 'write threshold, members/all 502');
        expectStatus(await review(jwt, b), 200, 'write threshold, members/all recovered');
        expectStatus(await approve(jwt, b), 200, 'write threshold, members/all recovered: approve');
    }

    // GET /api/apps/:id tells the UI whether to offer review
    for (const [u, expected] of [
        [ROLE_USERS.reporter, false],
        [ROLE_USERS.developer, true]
    ] as const) {
        const show = await facade.request(authed(HttpRequest.GET(`/api/apps/${APP_ID}`), await jwtOf(u)));
        expectStatus(show, 200, 'show');
        const body = show.json as { canReview?: unknown; approvalMinRole?: unknown };
        if (body.canReview !== expected || body.approvalMinRole !== 'write') {
            throw new Error(`show as ${u.token}: expected canReview=${expected}, got ${JSON.stringify(body)}`);
        }
    }

    // Only PixelCI admins may change the threshold
    expectStatus(await setThreshold(await jwtOf(ROLE_USERS.maintainer), 'read'), 403, 'non-admin sets approvalMinRole');
    expectStatus(await setThreshold(adminJwt, 'owner'), 400, 'invalid approvalMinRole');
    if ((await AppEntity.query().filter({ id: APP_ID }).findOne()).approvalMinRole !== 'write') {
        throw new Error('approvalMinRole changed by a rejected request');
    }

    // maintain
    expectStatus(await setThreshold(adminJwt, 'maintain'), 200, 'admin sets maintain');
    await expectReviewRights(ROLE_USERS.developer, 403, 'maintain threshold, Developer');
    await expectReviewRights(ROLE_USERS.shared, 403, 'maintain threshold, shared-group Developer');
    await expectReviewRights(ROLE_USERS.maintainer, 200, 'maintain threshold, Maintainer');
    await expectReviewRights(ROLE_USERS.sharedMaintainer, 200, 'maintain threshold, Developer who is Maintainer through a shared group');

    // read: anyone who can see the app, without a role lookup
    expectStatus(await setThreshold(adminJwt, 'read'), 200, 'admin sets read');
    await expectReviewRights(ROLE_USERS.reporter, 200, 'read threshold, Reporter');
    // A first-time Guest: the read gate makes the only GET /projects/1; a role lookup would add a second and a members/all.
    await expectReviewRights(ROLE_USERS.guest, 200, 'read threshold, Guest');
    const guestCalls = projectLookups.filter(t => t === ROLE_USERS.guest.token).length;
    if (guestCalls !== 1 || memberLookups.some(l => l.startsWith(`${ROLE_USERS.guest.token} `))) {
        throw new Error(`a read threshold must not look up the role (project GETs: ${guestCalls})`);
    }

    expectStatus(await setThreshold(adminJwt, 'write'), 200, 'admin restores write');

    // Admins create apps with a threshold
    const created = await facade.request(
        authed(HttpRequest.POST('/api/apps'), adminJwt).json({
            name: 'Approval Rights App',
            vcsId: ZERO_ID,
            projectPath: 'approval-rights',
            vcsProjectId: 2,
            approvalMinRole: 'maintain'
        })
    );
    expectStatus(created, 200, 'create app with approvalMinRole');
    const createdApp = await AppEntity.query()
        .filter({ id: (created.json as { id: string }).id })
        .findOne();
    if (createdApp.approvalMinRole !== 'maintain') throw new Error(`created app approvalMinRole: ${createdApp.approvalMinRole}`);
    await AppEntity.query().filter({ id: createdApp.id }).patchMany({ deletedAt: new Date() });

    console.log('  PASS');
}

async function testMalformedIds(facade: TestingFacade) {
    console.log('\nTest: malformed ids are rejected with 400 before reaching the database');
    const jwt = await JWT.generate({ subject: ZERO_ID });
    const get = (path: string) => facade.request(HttpRequest.GET(path).header('authorization', `Bearer ${jwt}`));

    for (const path of [
        '/api/apps/not-a-uuid',
        `/api/apps/${APP_ID}/builds/not-a-uuid`,
        `/api/apps/${APP_ID}/builds?branchId=not-a-uuid`,
        `/api/apps/${APP_ID}/builds?before=not-a-uuid`,
        '/api/apps/not-a-uuid/builds',
        '/api/apps/vcs-projects/search?vcsId=not-a-uuid&search=x'
    ]) {
        const response = await get(path);
        if (response.statusCode !== 400) {
            throw new Error(`Expected 400 for ${path} but got ${response.statusCode}: ${response.body}`);
        }
    }

    // A well-formed id that doesn't exist is still a plain 404
    const missing = await get(`/api/apps/${ZERO_ID}`);
    if (missing.statusCode !== 404) {
        throw new Error(`Expected 404 for unknown app but got ${missing.statusCode}: ${missing.body}`);
    }
    console.log('  PASS');
}

async function testBuildsPagination(facade: TestingFacade) {
    console.log('\nTest: builds list pages are disjoint, ordered, and honour limit/before');
    const jwt = await JWT.generate({ subject: ZERO_ID });
    const list = async (query: string) => {
        const response = await facade.request(HttpRequest.GET(`/api/apps/${APP_ID}/builds${query}`).header('authorization', `Bearer ${jwt}`));
        if (response.statusCode !== 200) throw new Error(`Expected 200 for builds${query} but got ${response.statusCode}: ${response.body}`);
        return (response.json as { id: string }[]).map(b => b.id);
    };

    const all = await list('?limit=200');
    if (all.length < 3) throw new Error(`Expected at least 3 builds from the scenarios, got ${all.length}`);
    if (JSON.stringify(all) !== JSON.stringify([...all].sort().reverse())) throw new Error('Builds are not ordered newest first');
    if (JSON.stringify(await list('')) !== JSON.stringify(all.slice(0, 50))) throw new Error('Default page is not the first 50 builds');
    if ((await list('?limit=0')).length !== 1) throw new Error('limit=0 should clamp to 1');
    if ((await list('?limit=100000')).length !== all.length) throw new Error('limit above the maximum should clamp to 200');

    const paged: string[] = [];
    let before = '';
    for (let i = 0; i < all.length + 1; i++) {
        const page = await list(`?limit=2${before && `&before=${before}`}`);
        if (page.length > 2) throw new Error('Page exceeds the limit');
        if (!page.length) break;
        paged.push(...page);
        before = page[page.length - 1];
    }
    if (JSON.stringify(paged) !== JSON.stringify(all)) {
        throw new Error(`Pages are not disjoint and ordered: ${JSON.stringify(paged)} vs ${JSON.stringify(all)}`);
    }
    console.log('  PASS');
}

async function testImageRoutesRequireStoredRow(facade: TestingFacade) {
    console.log('\nTest: image/diff routes 404 for unknown screens, draft builds and foreign builds; stored rows redirect');
    const jwt = await JWT.generate({ subject: ZERO_ID });
    const get = (path: string) => facade.request(HttpRequest.GET(path).header('authorization', `Bearer ${jwt}`));
    const expect = async (path: string, code: number) => {
        const response = await get(path);
        if (response.statusCode !== code) throw new Error(`Expected ${code} for ${path} but got ${response.statusCode}: ${response.body}`);
    };

    const branch = await createPersistedEntity(BranchEntity, { id: uuid7(), appId: APP_ID, name: 'image-routes' });
    const newBuild = (status: BuildEntity['status'], n: number) =>
        createPersistedEntity(BuildEntity, {
            id: uuid7(),
            appId: APP_ID,
            branchId: branch.id,
            createdAt: new Date(),
            commitHash: `1ae${n}`.padStart(40, '0'),
            commitSubject: 'image routes',
            commitAuthor: 'int-test',
            ciJobId: String(9500 + n),
            ciTokenHash: null,
            ciReadTokenHashes: [],
            status,
            approvedById: null,
            approvedAt: null
        });
    const screen = await createPersistedEntity(ScreenEntity, { id: uuid7(), appId: APP_ID, name: 'image-routes-screen' });
    const addRow = (buildId: string) =>
        createPersistedEntity(BuildScreenEntity, {
            id: uuid7(),
            appId: APP_ID,
            buildId,
            screenId: screen.id,
            matchedBuildId: null,
            approvalBuildId: null,
            status: 'new',
            storageStatus: 'stored',
            reviewStatus: null,
            reviewComment: null,
            reviewedById: null,
            reviewedAt: null
        });

    const stored = await newBuild('needs review', 1);
    await addRow(stored.id);
    const draft = await newBuild('draft', 2);
    await addRow(draft.id);
    const canceled = await newBuild('canceled', 3);
    await addRow(canceled.id);
    const noRow = await newBuild('needs review', 4);

    for (const kind of ['image', 'diff']) {
        const base = (buildId: string, screenId: string) => `/api/apps/${APP_ID}/builds/${buildId}/screens/${screenId}/${kind}`;
        await expect(base(stored.id, screen.id), 302);
        await expect(base(stored.id, uuid7()), 404); // unknown screen
        await expect(base(draft.id, screen.id), 404); // draft build
        await expect(base(canceled.id, screen.id), 404); // canceled build
        await expect(base(noRow.id, screen.id), 404); // build without a row for this screen
        await expect(base(uuid7(), screen.id), 404); // unknown build
    }

    // A build of another app is not reachable through this app's path
    const otherApp = await createPersistedEntity(AppEntity, {
        id: uuid7(),
        name: 'Other App',
        defaultBranchId: null,
        projectPath: 'other',
        vcsProjectId: 1,
        vcsId: ZERO_ID
    });
    const otherBranch = await createPersistedEntity(BranchEntity, { id: uuid7(), appId: otherApp.id, name: 'main' });
    const foreign = await createPersistedEntity(BuildEntity, {
        id: uuid7(),
        appId: otherApp.id,
        branchId: otherBranch.id,
        createdAt: new Date(),
        commitHash: '1ae5'.padStart(40, '0'),
        commitSubject: 'foreign',
        commitAuthor: 'int-test',
        ciJobId: '9505',
        ciTokenHash: null,
        ciReadTokenHashes: [],
        status: 'needs review',
        approvedById: null,
        approvedAt: null
    });
    await expect(`/api/apps/${APP_ID}/builds/${foreign.id}/screens/${screen.id}/image`, 404);
    console.log('  PASS');
}

async function createBaseEntities(mockGitLabPort: number) {
    await createPersistedEntity(UserEntity, {
        id: ZERO_ID,
        name: 'Integration Test User',
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
        name: 'Integration Test VCS',
        platform: 'gitlab',
        config: {
            url: `http://127.0.0.1:${mockGitLabPort}`,
            clientId: 'client-id',
            clientSecret: 'client-secret'
        }
    });

    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'Integration Test App',
        defaultBranchId: MAIN_BRANCH_ID,
        projectPath: PROJECT_PATH,
        vcsProjectId: 1,
        vcsId: ZERO_ID
    });

    await createPersistedEntity(BranchEntity, {
        id: MAIN_BRANCH_ID,
        appId: APP_ID,
        name: 'main'
    });
}

async function runScenario(facade: TestingFacade, scenarioId: string, scenario: IScenario) {
    const commitHash = scenarioId.padStart(40, '0');

    // Update mock GitLab state for this scenario
    mockJobData = {
        id: Number(scenarioId),
        ref: scenario.branch,
        sha: commitHash,
        title: `Integration test commit ${scenarioId}`,
        author: 'int-test'
    };

    console.log('Creating build...');
    const buildResponse = await makeRequest<{ id: string; status: 'draft' }>(
        facade,
        HttpRequest.POST(`/api/apps/${APP_ID}/builds`).header('authorization', `Bearer ${TEST_CI_TOKEN}`)
    );
    const buildId = buildResponse.id;

    const expectedStatuses: Record<string, BuildScreenEntity['status']> = {};
    const screensToReview: string[] = [];

    for (const [index, screen] of Object.entries(scenario.screens)) {
        console.log(`Uploading screen ${Number(index) + 1} of ${scenario.screens.length}...`);
        const screenResponse = await makeRequest<{ id: string; screenId: string }>(
            facade,
            HttpRequest.POST(`/api/apps/${APP_ID}/builds/${buildId}/screens`)
                .header('authorization', `Bearer ${TEST_CI_TOKEN}`)
                .multiPart([
                    {
                        name: 'image',
                        file: readFileSync(`${__dirname}/fixtures/${screen.file}`),
                        fileName: `${screen.name}.png`
                    }
                ])
        );
        expectedStatuses[screenResponse.id] = screen.expectedStatus;
        if (screen.expectedStatus === 'new' || screen.expectedStatus === 'needs review') {
            screensToReview.push(screenResponse.screenId);
        }
    }

    console.log('Processing build...');
    await makeRequest<{ ok: true }>(
        facade,
        HttpRequest.POST(`/api/apps/${APP_ID}/builds/${buildId}/process`).header('authorization', `Bearer ${TEST_CI_TOKEN}`)
    );

    console.log('Waiting for build to be processed...');
    let buildStatus: BuildEntity['status'] = 'processing';
    const expTime = Date.now() + 10 * 1000;
    while (true) {
        const buildStatusResponse = await makeRequest<{ status: BuildEntity['status'] }>(
            facade,
            HttpRequest.GET(`/api/apps/${APP_ID}/builds/${buildId}/status`).header('authorization', `Bearer ${TEST_CI_TOKEN}`)
        );
        buildStatus = buildStatusResponse.status;

        if (buildStatus === 'processing') {
            console.log('Build is still processing.');
            if (Date.now() > expTime) {
                throw new Error('Build processing timed out');
            }
            await sleepSecs(1);
        } else {
            break;
        }
    }

    if (buildStatus !== scenario.expectedStatus) {
        throw new Error(`Expected build status ${scenario.expectedStatus}, but got ${buildStatus}`);
    } else {
        console.log(`Build status: ${buildStatus}`);
    }

    if (scenario.expectedRemoved) {
        const tombstones = await BuildScreenEntity.query().filter({ buildId, isRemoved: true }).find();
        const names = await ScreenEntity.query()
            .filter({ id: { $in: tombstones.map(t => t.screenId) } })
            .find();
        const actual = tombstones
            .map(t => ({
                name: names.find(n => n.id === t.screenId)?.name,
                status: t.status
            }))
            .sort((x, y) => String(x.name).localeCompare(String(y.name)));
        const expected = [...scenario.expectedRemoved].sort((x, y) => x.name.localeCompare(y.name));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`Expected removed screens ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`);
        }
    }

    if (scenario.shouldApprove) {
        const jwt = await JWT.generate({ subject: ZERO_ID });

        // per-screen approval is now required before a build can be approved
        for (const screenId of screensToReview) {
            await makeRequest<{ reviewStatus: string }>(
                facade,
                HttpRequest.POST(`/api/apps/${APP_ID}/builds/${buildId}/screens/${screenId}/review`)
                    .header('authorization', `Bearer ${jwt}`)
                    .json({ reviewStatus: 'approved', comment: '' })
            );
        }

        console.log('Approving build...');
        const approval = await makeRequest<{ vcsUrl: string | false; vcsError?: string }>(
            facade,
            HttpRequest.POST(`/api/apps/${APP_ID}/builds/${buildId}/approve`).header('authorization', `Bearer ${jwt}`)
        );
        if (typeof approval.vcsUrl !== 'string' || !approval.vcsUrl.endsWith(`/${PROJECT_PATH}/-/pipelines/7`)) {
            throw new Error(`Expected vcsUrl ending in /${PROJECT_PATH}/-/pipelines/7, got ${JSON.stringify(approval)}`);
        }
    }
}

async function makeRequest<T>(facade: TestingFacade, request: RequestBuilder, type?: ReceiveType<T>): Promise<T> {
    const response = await facade.request(request);
    if (response.statusCode !== 200) {
        throw new Error(`Request failed: ${response.status} ${response.body}`);
    }
    assert(response.json, undefined, type);
    return response.json as T;
}
