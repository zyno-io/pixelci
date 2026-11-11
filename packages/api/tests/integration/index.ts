import { assert, type ReceiveType } from '@zyno-io/ts-reflection';
import { HttpRequest, RequestBuilder } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, sleepSecs, TestingFacade, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { readFileSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';
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

            if (req.url?.startsWith('/api/v4/projects/')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: 1, path_with_namespace: PROJECT_PATH }));
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

    await testMalformedIds(facade);
}

async function testMalformedIds(facade: TestingFacade) {
    console.log('\nTest: malformed ids are rejected with 400 before reaching the database');
    const jwt = await JWT.generate({ subject: ZERO_ID });
    const get = (path: string) => facade.request(HttpRequest.GET(path).header('authorization', `Bearer ${jwt}`));

    for (const path of [
        '/api/apps/not-a-uuid',
        `/api/apps/${APP_ID}/builds/not-a-uuid`,
        `/api/apps/${APP_ID}/builds?branchId=not-a-uuid`,
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
