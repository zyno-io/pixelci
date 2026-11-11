import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

const APP_ID = 'e1234567-aaaa-bbbb-cccc-000000000001';
const BRANCH_ID = 'e1234567-aaaa-bbbb-cccc-000000000002';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const TEST_CI_TOKEN = 'glcbt-test-ci-token';
const PROJECT_PATH = 'group/auth-test';

let mockGitLabPort: number;
let jobHitCount = 0;
let mockGitLabServer: Server;

type MockOverride = (req: IncomingMessage, res: ServerResponse) => boolean;
let mockOverride: MockOverride | null = null;

run()
    .then(() => {
        console.log('\nAll CI token auth tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

function createMockGitLab(): Promise<void> {
    return new Promise(resolve => {
        mockGitLabServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            // Allow per-test overrides to intercept requests
            if (mockOverride && mockOverride(req, res)) return;

            const token = req.headers['job-token'] as string | undefined;

            if (req.url === '/api/v4/job') {
                jobHitCount++;
                if (token !== TEST_CI_TOKEN) {
                    res.writeHead(401);
                    res.end('Unauthorized');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        id: 42,
                        ref: 'main',
                        pipeline: { project_id: 1, sha: 'abc123' },
                        commit: { title: 'test commit', author_name: 'Test Author' }
                    })
                );
                return;
            }

            res.writeHead(404);
            res.end('Not found');
        });

        mockGitLabServer.listen(0, () => {
            mockGitLabPort = (mockGitLabServer.address() as { port: number }).port;
            resolve();
        });
    });
}

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;

async function run() {
    await createMockGitLab();

    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_authtest'
    });
    await facade.start();

    await createBaseEntities();

    await testNoToken(facade);
    await testInvalidToken(facade);
    await testValidTokenWrongProject(facade);
    await testUnboundApp(facade);
    await testValidToken(facade);
    await testHashBasedAuth(facade);
    await testWrongTokenOnSubsequentCall(facade);
    await testMalformedBuildId(facade);

    // Mock GitLab failure scenarios
    await testGitLabJobEndpointDown(facade);
    await testGitLabJobMissingProjectId(facade);
    await testBadVcsIntegration(facade);

    mockGitLabServer.close();
}

async function createBaseEntities() {
    await createPersistedEntity(VcsIntegrationEntity, {
        id: ZERO_ID,
        name: 'Auth Test VCS',
        platform: 'gitlab',
        config: {
            url: `http://127.0.0.1:${mockGitLabPort}`,
            clientId: 'client-id',
            clientSecret: 'client-secret'
        }
    });

    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'Auth Test App',
        defaultBranchId: BRANCH_ID,
        projectPath: PROJECT_PATH,
        vcsProjectId: 1,
        vcsId: ZERO_ID
    });

    await createPersistedEntity(BranchEntity, {
        id: BRANCH_ID,
        appId: APP_ID,
        name: 'main'
    });
}

async function testNoToken(facade: Facade) {
    console.log('\nTest: createBuild with no token → 401');
    const response = await facade.request(HttpRequest.POST(`/api/apps/${APP_ID}/builds`));
    if (response.statusCode !== 401) {
        throw new Error(`Expected 401 but got ${response.statusCode}: ${response.body}`);
    }
    console.log('  PASS');
}

async function testInvalidToken(facade: Facade) {
    console.log('\nTest: createBuild with invalid token → 401');
    const response = await facade.request(HttpRequest.POST(`/api/apps/${APP_ID}/builds`).header('authorization', 'Bearer invalid-token'));
    if (response.statusCode !== 401) {
        throw new Error(`Expected 401 but got ${response.statusCode}: ${response.body}`);
    }
    console.log('  PASS');
}

async function testValidTokenWrongProject(facade: Facade) {
    console.log('\nTest: valid token but vcsProjectId mismatch → 401');
    const wrongAppId = 'e1234567-aaaa-bbbb-cccc-000000000099';
    const wrongBranchId = 'e1234567-aaaa-bbbb-cccc-000000000098';
    await createPersistedEntity(AppEntity, {
        id: wrongAppId,
        name: 'Wrong Project App',
        defaultBranchId: wrongBranchId,
        projectPath: 'group/wrong-project',
        vcsProjectId: 9999,
        vcsId: ZERO_ID
    });
    await createPersistedEntity(BranchEntity, {
        id: wrongBranchId,
        appId: wrongAppId,
        name: 'main'
    });

    const response = await facade.request(HttpRequest.POST(`/api/apps/${wrongAppId}/builds`).header('authorization', `Bearer ${TEST_CI_TOKEN}`));
    if (response.statusCode !== 401) {
        throw new Error(`Expected 401 but got ${response.statusCode}: ${response.body}`);
    }
    console.log('  PASS');
}

async function testUnboundApp(facade: Facade) {
    console.log('\nTest: GitLab app with null vcsProjectId + valid token → 401, provider not called');
    const unboundAppId = 'e1234567-aaaa-bbbb-cccc-000000000091';
    const unboundBranchId = 'e1234567-aaaa-bbbb-cccc-000000000092';
    await createPersistedEntity(AppEntity, {
        id: unboundAppId,
        name: 'Unbound App',
        defaultBranchId: unboundBranchId,
        projectPath: 'group/unbound',
        vcsProjectId: null,
        vcsId: ZERO_ID
    });
    await createPersistedEntity(BranchEntity, {
        id: unboundBranchId,
        appId: unboundAppId,
        name: 'main'
    });

    const hitsBefore = jobHitCount;
    const response = await facade.request(HttpRequest.POST(`/api/apps/${unboundAppId}/builds`).header('authorization', `Bearer ${TEST_CI_TOKEN}`));
    if (response.statusCode !== 401) {
        throw new Error(`Expected 401 but got ${response.statusCode}: ${response.body}`);
    }
    if (jobHitCount !== hitsBefore) {
        throw new Error(`Expected no GitLab /api/v4/job call, but hit count went ${hitsBefore} -> ${jobHitCount}`);
    }
    console.log('  PASS');
}

async function testValidToken(facade: Facade) {
    console.log('\nTest: createBuild with valid CI token → 200');
    const response = await facade.request(HttpRequest.POST(`/api/apps/${APP_ID}/builds`).header('authorization', `Bearer ${TEST_CI_TOKEN}`));
    if (response.statusCode !== 200) {
        throw new Error(`Expected 200 but got ${response.statusCode}: ${response.body}`);
    }
    console.log('  PASS');
}

async function testHashBasedAuth(facade: Facade) {
    console.log('\nTest: subsequent call with same token (hash-based auth) → 200');
    // First create a build to get a build ID with a stored token hash
    const createResponse = await facade.request(HttpRequest.POST(`/api/apps/${APP_ID}/builds`).header('authorization', `Bearer ${TEST_CI_TOKEN}`));
    if (createResponse.statusCode !== 200) {
        throw new Error(`Setup failed: ${createResponse.statusCode}: ${createResponse.body}`);
    }
    const buildId = createResponse.json.id;

    // Now call getBuildStatus using the same token — should work via hash matching
    const statusResponse = await facade.request(
        HttpRequest.GET(`/api/apps/${APP_ID}/builds/${buildId}/status`).header('authorization', `Bearer ${TEST_CI_TOKEN}`)
    );
    if (statusResponse.statusCode !== 200) {
        throw new Error(`Expected 200 but got ${statusResponse.statusCode}: ${statusResponse.body}`);
    }
    console.log('  PASS');
}

async function testWrongTokenOnSubsequentCall(facade: Facade) {
    console.log('\nTest: subsequent call with wrong token → 401');
    // Create a build first
    const createResponse = await facade.request(HttpRequest.POST(`/api/apps/${APP_ID}/builds`).header('authorization', `Bearer ${TEST_CI_TOKEN}`));
    if (createResponse.statusCode !== 200) {
        throw new Error(`Setup failed: ${createResponse.statusCode}: ${createResponse.body}`);
    }
    const buildId = createResponse.json.id;

    // Try calling getBuildStatus with a different token
    const statusResponse = await facade.request(
        HttpRequest.GET(`/api/apps/${APP_ID}/builds/${buildId}/status`).header('authorization', 'Bearer wrong-token')
    );
    if (statusResponse.statusCode !== 401) {
        throw new Error(`Expected 401 but got ${statusResponse.statusCode}: ${statusResponse.body}`);
    }
    console.log('  PASS');
}

async function testMalformedBuildId(facade: Facade) {
    console.log('\nTest: malformed buildId in URL → 401 (no DB lookup)');
    const response = await facade.request(
        HttpRequest.GET(`/api/apps/${APP_ID}/builds/not-a-uuid/status`).header('authorization', `Bearer ${TEST_CI_TOKEN}`)
    );
    if (response.statusCode !== 401) {
        throw new Error(`Expected 401 but got ${response.statusCode}: ${response.body}`);
    }
    console.log('  PASS');
}

async function testGitLabJobEndpointDown(facade: Facade) {
    console.log('\nTest: GitLab /api/v4/job returns 500 → 401');
    mockOverride = (req, res) => {
        if (req.url === '/api/v4/job') {
            res.writeHead(500);
            res.end('Internal Server Error');
            return true;
        }
        return false;
    };

    const response = await facade.request(HttpRequest.POST(`/api/apps/${APP_ID}/builds`).header('authorization', `Bearer ${TEST_CI_TOKEN}`));
    mockOverride = null;

    if (response.statusCode !== 401) {
        throw new Error(`Expected 401 but got ${response.statusCode}: ${response.body}`);
    }
    console.log('  PASS');
}

async function testGitLabJobMissingProjectId(facade: Facade) {
    console.log('\nTest: GitLab job response missing pipeline.project_id → 401');
    mockOverride = (req, res) => {
        if (req.url === '/api/v4/job') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    id: 42,
                    ref: 'main',
                    pipeline: { sha: 'abc123' },
                    commit: { title: 'test commit', author_name: 'Test Author' }
                })
            );
            return true;
        }
        return false;
    };

    const response = await facade.request(HttpRequest.POST(`/api/apps/${APP_ID}/builds`).header('authorization', `Bearer ${TEST_CI_TOKEN}`));
    mockOverride = null;

    if (response.statusCode !== 401) {
        throw new Error(`Expected 401 but got ${response.statusCode}: ${response.body}`);
    }
    console.log('  PASS');
}

async function testBadVcsIntegration(facade: Facade) {
    console.log('\nTest: app with non-existent VCS integration → 401');
    const badVcsAppId = 'e1234567-aaaa-bbbb-cccc-000000000077';
    const badVcsBranchId = 'e1234567-aaaa-bbbb-cccc-000000000076';
    await createPersistedEntity(AppEntity, {
        id: badVcsAppId,
        name: 'Bad VCS App',
        defaultBranchId: badVcsBranchId,
        projectPath: PROJECT_PATH,
        vcsProjectId: 1,
        vcsId: 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    });
    await createPersistedEntity(BranchEntity, {
        id: badVcsBranchId,
        appId: badVcsAppId,
        name: 'main'
    });

    const response = await facade.request(HttpRequest.POST(`/api/apps/${badVcsAppId}/builds`).header('authorization', `Bearer ${TEST_CI_TOKEN}`));
    if (response.statusCode !== 401) {
        throw new Error(`Expected 401 but got ${response.statusCode}: ${response.body}`);
    }
    console.log('  PASS');
}
