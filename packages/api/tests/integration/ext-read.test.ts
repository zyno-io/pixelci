import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { BuildScreenEntity } from '../../src/entities/BuildScreen.entity';
import { ScreenEntity } from '../../src/entities/Screen.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { sealIntegrationConfig } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

const VCS_ID = '00000000-0000-0000-0000-000000000000';
const USER_ID = 'e2222222-aaaa-bbbb-cccc-000000000001';
const APP_ID = 'e2222222-aaaa-bbbb-cccc-000000000010';
const APP_NO_ACCESS_ID = 'e2222222-aaaa-bbbb-cccc-000000000011';
const BRANCH_ID = 'e2222222-aaaa-bbbb-cccc-000000000020';
const BRANCH_NO_ACCESS_ID = 'e2222222-aaaa-bbbb-cccc-000000000021';
const SCREEN_ID = 'e2222222-aaaa-bbbb-cccc-000000000030';
const BUILD_ID = 'e2222222-aaaa-bbbb-cccc-000000000040';
const REMOVED_SCREEN_ID = 'e2222222-aaaa-bbbb-cccc-000000000031';
const BUILD_SCREEN_ID = 'e2222222-aaaa-bbbb-cccc-000000000050';

// GitLab numeric user ids (as strings, matching how vcsUserId is stored from the OIDC `sub`)
const KNOWN_GITLAB_USER_ID = '4242';
const UNKNOWN_GITLAB_USER_ID = '9999';

// Which GitLab projects the caller can access. APP_ID maps to project 100 (accessible);
// APP_NO_ACCESS_ID maps to project 200 (not accessible → /projects/200 returns 404).
const ACCESSIBLE_PROJECT_ID = 100;
const INACCESSIBLE_PROJECT_ID = 200;

const VALID_PAT = 'glpat-valid-token';
const UNKNOWN_USER_PAT = 'glpat-unknown-user-token';
const MULTI_PAT = 'glpat-multi-provider-token';

const SECOND_VCS_ID = 'e2222222-aaaa-bbbb-cccc-0000000000ff';

const GITHUB_VCS_ID = 'e2222222-aaaa-bbbb-cccc-0000000000aa';
const GITHUB_PAT = 'ghp_githubStyleToken';

// Every credential the mock GitLab receives, so we can assert foreign tokens never reach it
const gitlabSeenCredentials: string[] = [];

let mockGitLabPort: number;
let mockGitLabServer: Server;

run()
    .then(() => {
        console.log('\nAll /api/ext read tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

function createMockGitLab(): Promise<void> {
    return new Promise(resolve => {
        mockGitLabServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            const url = req.url ?? '';
            gitlabSeenCredentials.push(String(req.headers['private-token'] ?? ''), String(req.headers['authorization'] ?? ''));

            // Identity lookup, used by VcsTokenAuthMiddleware (PRIVATE-TOKEN header)
            if (url === '/api/v4/user') {
                const pat = req.headers['private-token'] as string | undefined;
                if (pat === VALID_PAT || pat === MULTI_PAT) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ id: Number(KNOWN_GITLAB_USER_ID), username: 'rita', name: 'Reviewer Rita' }));
                    return;
                }
                if (pat === UNKNOWN_USER_PAT) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ id: Number(UNKNOWN_GITLAB_USER_ID), username: 'nobody', name: 'Nobody' }));
                    return;
                }
                res.writeHead(401);
                res.end('Unauthorized');
                return;
            }

            // Project access check (Authorization: Bearer header). 200 = accessible, 404 = not.
            if (url.startsWith('/api/v4/projects/')) {
                const projectId = Number(url.slice('/api/v4/projects/'.length));
                if (projectId === ACCESSIBLE_PROJECT_ID) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ id: projectId, path_with_namespace: 'group/accessible' }));
                    return;
                }
                res.writeHead(404);
                res.end('Not Found');
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
        databasePrefix: 'pixelci_exttest'
    });
    await facade.start();

    await createBaseEntities();

    await testNoToken(facade);
    await testInvalidToken(facade);
    await testUnknownUser(facade);
    await testListAppsFiltersByAccess(facade);
    await testListBuilds(facade);
    await testGetBuildDetail(facade);
    await testInaccessibleAppForbidden(facade);
    await testImageRequiresToken(facade);
    await testImageForbiddenWithoutAccess(facade);
    await testImageRedirectsWithAccess(facade);
    await testRemovedScreenTombstone(facade);
    await testGitHubTokenNeverReachesGitLab(facade);
    await testMultiProviderRequiresVcsId(facade);
    await testMalformedIds(facade);
    await testMcp(facade);

    mockGitLabServer.close();
}

async function createBaseEntities() {
    await createPersistedEntity(VcsIntegrationEntity, {
        id: VCS_ID,
        name: 'Ext Test VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({
            url: `http://127.0.0.1:${mockGitLabPort}`,
            clientId: 'client-id',
            clientSecret: 'client-secret'
        })
    });

    // A GitHub integration coexisting with the GitLab one: GitLab PATs must still resolve with no header.
    await createPersistedEntity(VcsIntegrationEntity, {
        id: GITHUB_VCS_ID,
        name: 'Ext Test GitHub',
        platform: 'github',
        // url points at a closed local port so tests never contact real GitHub
        config: sealIntegrationConfig({
            url: 'http://127.0.0.1:9',
            clientId: 'gh-client',
            clientSecret: 'gh-secret',
            oidcAudience: 'https://pixelci.example.com'
        })
    });

    await createPersistedEntity(UserEntity, {
        id: USER_ID,
        name: 'Reviewer Rita',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: false,
        vcsId: VCS_ID,
        vcsUserId: KNOWN_GITLAB_USER_ID
    });

    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'Accessible App',
        defaultBranchId: BRANCH_ID,
        projectPath: 'group/accessible',
        vcsProjectId: ACCESSIBLE_PROJECT_ID,
        vcsId: VCS_ID
    });

    await createPersistedEntity(AppEntity, {
        id: APP_NO_ACCESS_ID,
        name: 'Secret App',
        defaultBranchId: BRANCH_NO_ACCESS_ID,
        projectPath: 'group/secret',
        vcsProjectId: INACCESSIBLE_PROJECT_ID,
        vcsId: VCS_ID
    });

    await createPersistedEntity(BranchEntity, { id: BRANCH_ID, appId: APP_ID, name: 'main' });
    await createPersistedEntity(BranchEntity, { id: BRANCH_NO_ACCESS_ID, appId: APP_NO_ACCESS_ID, name: 'main' });

    await createPersistedEntity(ScreenEntity, { id: SCREEN_ID, appId: APP_ID, name: 'home' });
    await createPersistedEntity(ScreenEntity, { id: REMOVED_SCREEN_ID, appId: APP_ID, name: 'legacy' });

    await createPersistedEntity(BuildEntity, {
        ciReadTokenHashes: [],
        id: BUILD_ID,
        appId: APP_ID,
        branchId: BRANCH_ID,
        createdAt: new Date(),
        commitHash: 'abc1234567',
        commitSubject: 'Tweak the homepage',
        commitAuthor: 'Dev Dan',
        ciJobId: '1',
        ciTokenHash: null,
        status: 'changes approved',
        approvedById: USER_ID,
        approvedAt: new Date()
    });

    await createPersistedEntity(BuildScreenEntity, {
        id: BUILD_SCREEN_ID,
        appId: APP_ID,
        buildId: BUILD_ID,
        screenId: SCREEN_ID,
        matchedBuildId: null,
        approvalBuildId: null,
        status: 'changes approved',
        storageStatus: 'stored',
        reviewStatus: 'approved',
        reviewComment: 'Looks good to me',
        reviewedById: USER_ID,
        reviewedAt: new Date()
    });

    // tombstone: a screen removed in this build (no image)
    await createPersistedEntity(BuildScreenEntity, {
        id: 'e2222222-aaaa-bbbb-cccc-000000000051',
        appId: APP_ID,
        buildId: BUILD_ID,
        screenId: REMOVED_SCREEN_ID,
        matchedBuildId: null,
        approvalBuildId: null,
        status: 'changes approved',
        storageStatus: null,
        reviewStatus: null,
        reviewComment: null,
        reviewedById: null,
        reviewedAt: null,
        isRemoved: true
    });
}

function authed(request: ReturnType<typeof HttpRequest.GET>, pat: string) {
    return request.header('authorization', `Bearer ${pat}`);
}

async function testNoToken(facade: Facade) {
    console.log('\nTest: /api/ext/apps with no token → 401');
    const response = await facade.request(HttpRequest.GET('/api/ext/apps'));
    expectStatus(response.statusCode, 401);
    console.log('  PASS');
}

async function testInvalidToken(facade: Facade) {
    console.log('\nTest: /api/ext/apps with invalid token → 401');
    const response = await facade.request(authed(HttpRequest.GET('/api/ext/apps'), 'glpat-bogus'));
    expectStatus(response.statusCode, 401);
    console.log('  PASS');
}

async function testUnknownUser(facade: Facade) {
    console.log('\nTest: valid GitLab token but no matching PixelCI user → 401');
    const response = await facade.request(authed(HttpRequest.GET('/api/ext/apps'), UNKNOWN_USER_PAT));
    expectStatus(response.statusCode, 401);
    console.log('  PASS');
}

async function testListAppsFiltersByAccess(facade: Facade) {
    console.log('\nTest: /api/ext/apps returns only apps the token can access');
    const response = await facade.request(authed(HttpRequest.GET('/api/ext/apps'), VALID_PAT));
    expectStatus(response.statusCode, 200);

    const apps = response.json as { id: string; name: string }[];
    const ids = apps.map(a => a.id);
    if (!ids.includes(APP_ID)) throw new Error(`Expected accessible app ${APP_ID} in ${JSON.stringify(ids)}`);
    if (ids.includes(APP_NO_ACCESS_ID)) throw new Error(`Inaccessible app ${APP_NO_ACCESS_ID} should have been filtered out`);
    console.log('  PASS');
}

async function testListBuilds(facade: Facade) {
    console.log('\nTest: /api/ext/apps/:appId/builds returns builds with approver name');
    const response = await facade.request(authed(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds`), VALID_PAT));
    expectStatus(response.statusCode, 200);

    const builds = response.json as { id: string; branchName: string; status: string; approvedByName: string | null }[];
    const build = builds.find(b => b.id === BUILD_ID);
    if (!build) throw new Error(`Expected build ${BUILD_ID} in response`);
    if (build.branchName !== 'main') throw new Error(`Expected branchName 'main', got '${build.branchName}'`);
    if (build.approvedByName !== 'Reviewer Rita') throw new Error(`Expected approvedByName 'Reviewer Rita', got '${build.approvedByName}'`);
    console.log('  PASS');
}

async function testGetBuildDetail(facade: Facade) {
    console.log('\nTest: /api/ext/apps/:appId/builds/:buildId returns per-screen review data');
    const response = await facade.request(authed(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds/${BUILD_ID}`), VALID_PAT));
    expectStatus(response.statusCode, 200);

    const build = response.json as {
        screens: { screenId: string; name: string; reviewStatus: string | null; reviewComment: string | null; reviewedByName: string | null }[];
    };
    const screen = build.screens.find(s => s.screenId === SCREEN_ID);
    if (!screen) throw new Error(`Expected screen ${SCREEN_ID} in response`);
    if (screen.name !== 'home') throw new Error(`Expected screen name 'home', got '${screen.name}'`);
    if (screen.reviewStatus !== 'approved') throw new Error(`Expected reviewStatus 'approved', got '${screen.reviewStatus}'`);
    if (screen.reviewComment !== 'Looks good to me') throw new Error(`Expected reviewComment, got '${screen.reviewComment}'`);
    if (screen.reviewedByName !== 'Reviewer Rita') throw new Error(`Expected reviewedByName 'Reviewer Rita', got '${screen.reviewedByName}'`);
    console.log('  PASS');
}

async function testInaccessibleAppForbidden(facade: Facade) {
    console.log('\nTest: reading a build under an app the token cannot access → 403');
    const response = await facade.request(authed(HttpRequest.GET(`/api/ext/apps/${APP_NO_ACCESS_ID}/builds`), VALID_PAT));
    expectStatus(response.statusCode, 403);
    console.log('  PASS');
}

async function testImageRequiresToken(facade: Facade) {
    console.log('\nTest: screen image with no token → 401');
    const response = await facade.request(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds/${BUILD_ID}/screens/${SCREEN_ID}/image`));
    expectStatus(response.statusCode, 401);
    console.log('  PASS');
}

async function testImageForbiddenWithoutAccess(facade: Facade) {
    console.log('\nTest: screen image under an inaccessible app → 403');
    const response = await facade.request(
        authed(HttpRequest.GET(`/api/ext/apps/${APP_NO_ACCESS_ID}/builds/${BUILD_ID}/screens/${SCREEN_ID}/image`), VALID_PAT)
    );
    expectStatus(response.statusCode, 403);
    console.log('  PASS');
}

async function testImageRedirectsWithAccess(facade: Facade) {
    console.log('\nTest: screen image with access → 302 redirect to signed URL');
    const response = await facade.request(
        authed(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds/${BUILD_ID}/screens/${SCREEN_ID}/image?kind=new`), VALID_PAT)
    );
    expectStatus(response.statusCode, 302);
    console.log('  PASS');
}

async function testRemovedScreenTombstone(facade: Facade) {
    console.log('\nTest: a removed screen is flagged removed: true and has no image (404)');
    const detail = await facade.request(authed(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds/${BUILD_ID}`), VALID_PAT));
    expectStatus(detail.statusCode, 200);
    const screens = (detail.json as { screens: { screenId: string; removed: boolean }[] }).screens;
    if (screens.find(s => s.screenId === REMOVED_SCREEN_ID)?.removed !== true) throw new Error('Expected the tombstone to have removed: true');
    if (screens.find(s => s.screenId === SCREEN_ID)?.removed !== false) throw new Error('Expected a normal screen to have removed: false');
    for (const kind of ['new', 'diff']) {
        const image = await facade.request(
            authed(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds/${BUILD_ID}/screens/${REMOVED_SCREEN_ID}/image?kind=${kind}`), VALID_PAT)
        );
        expectStatus(image.statusCode, 404);
    }
    console.log('  PASS');
}

async function testGitHubTokenNeverReachesGitLab(facade: Facade) {
    console.log('\nTest: a GitHub-style token is never sent to a GitLab provider');
    gitlabSeenCredentials.length = 0;

    // No header: routed to the (only) GitHub integration, whose lookup fails -> 401
    const noHint = await facade.request(authed(HttpRequest.GET('/api/ext/apps'), GITHUB_PAT));
    expectStatus(noHint.statusCode, 401);

    // Explicitly pointed at the GitLab integration: refused before any outbound request
    const gitlabHint = await facade.request(authed(HttpRequest.GET('/api/ext/apps'), GITHUB_PAT).header('x-pixelci-vcs-id', VCS_ID));
    expectStatus(gitlabHint.statusCode, 401);

    // Leading whitespace must not defeat prefix detection
    const padded = await facade.request(HttpRequest.GET('/api/ext/apps').header('authorization', `Bearer  ${GITHUB_PAT}`));
    expectStatus(padded.statusCode, 401);

    if (gitlabSeenCredentials.some(c => c.includes(GITHUB_PAT))) {
        throw new Error('GitHub-style token was sent to the GitLab mock');
    }

    // Reverse direction: an unprefixed (GitLab-style) token pointed at the GitHub integration is refused
    const reverse = await facade.request(authed(HttpRequest.GET('/api/ext/apps'), 'glpat-unprefixedStyle').header('x-pixelci-vcs-id', GITHUB_VCS_ID));
    expectStatus(reverse.statusCode, 401);
    console.log('  PASS');
}

async function testMultiProviderRequiresVcsId(facade: Facade) {
    console.log('\nTest: with multiple VCS providers, a token without a provider hint is refused (no fan-out)');

    // Add a second GitLab integration so the token can no longer be auto-resolved to a single provider.
    await createPersistedEntity(VcsIntegrationEntity, {
        id: SECOND_VCS_ID,
        name: 'Second VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({
            url: `http://127.0.0.1:${mockGitLabPort}`,
            clientId: 'client-id',
            clientSecret: 'client-secret'
        })
    });

    const noHint = await facade.request(authed(HttpRequest.GET('/api/ext/apps'), MULTI_PAT));
    expectStatus(noHint.statusCode, 401);

    const withHint = await facade.request(authed(HttpRequest.GET('/api/ext/apps'), MULTI_PAT).header('x-pixelci-vcs-id', VCS_ID));
    expectStatus(withHint.statusCode, 200);
    console.log('  PASS');
}

async function testMalformedIds(facade: Facade) {
    console.log('\nTest: malformed X-PixelCI-Vcs-Id → 401; malformed path ids → 400');
    const badHeader = await facade.request(authed(HttpRequest.GET('/api/ext/apps'), VALID_PAT).header('x-pixelci-vcs-id', 'not-a-uuid'));
    expectStatus(badHeader.statusCode, 401);

    const badApp = await facade.request(authed(HttpRequest.GET('/api/ext/apps/not-a-uuid/builds'), VALID_PAT));
    expectStatus(badApp.statusCode, 400);

    const badBranch = await facade.request(authed(HttpRequest.GET(`/api/ext/apps/${APP_ID}/builds?branchId=not-a-uuid`), VALID_PAT));
    expectStatus(badBranch.statusCode, 400);
    console.log('  PASS');
}

function mcpPost(facade: Facade, body: object, pat: string | null = VALID_PAT) {
    let req = HttpRequest.POST('/api/mcp')
        .header('accept', 'application/json, text/event-stream')
        .header('content-type', 'application/json')
        .header('mcp-protocol-version', '2025-06-18');
    if (pat) req = authed(req, pat);
    return facade.request(req.json(body));
}

type McpToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

async function mcpCall(facade: Facade, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const response = await mcpPost(facade, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } });
    expectStatus(response.statusCode, 200);
    return (response.json as { result: McpToolResult }).result;
}

async function testMcp(facade: Facade) {
    console.log('\nTest: /api/mcp with no token → 401');
    const noToken = await mcpPost(facade, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null);
    expectStatus(noToken.statusCode, 401);
    console.log('  PASS');

    console.log('\nTest: /api/mcp initialize → serverInfo');
    const init = await mcpPost(facade, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } }
    });
    expectStatus(init.statusCode, 200);
    const serverName = (init.json as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo?.name;
    if (serverName !== 'pixelci') throw new Error(`Expected serverInfo.name 'pixelci', got ${JSON.stringify(init.json)}`);
    console.log('  PASS');

    console.log('\nTest: /api/mcp tools/list returns the 4 tools');
    const list = await mcpPost(facade, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expectStatus(list.statusCode, 200);
    const names = (list.json as { result: { tools: { name: string }[] } }).result.tools.map(t => t.name).sort();
    if (names.join(',') !== 'get_build,get_screen_image,list_apps,list_builds') throw new Error(`Unexpected tools: ${names.join(',')}`);
    console.log('  PASS');

    console.log('\nTest: /api/mcp list_apps returns only the accessible app');
    const apps = await mcpCall(facade, 'list_apps', {});
    if (apps.isError) throw new Error(`list_apps errored: ${JSON.stringify(apps)}`);
    const parsed = JSON.parse(apps.content[0].text ?? '[]') as { id: string }[];
    if (parsed.length !== 1 || parsed[0].id !== APP_ID) throw new Error(`Expected only ${APP_ID}, got ${JSON.stringify(parsed)}`);
    console.log('  PASS');

    console.log('\nTest: /api/mcp get_build on accessible app works; no-access app and bad ids → isError');
    const ok = await mcpCall(facade, 'get_build', { appId: APP_ID, buildId: BUILD_ID });
    if (ok.isError) throw new Error(`get_build errored: ${JSON.stringify(ok)}`);
    const denied = await mcpCall(facade, 'get_build', { appId: APP_NO_ACCESS_ID, buildId: BUILD_ID });
    if (!denied.isError) throw new Error(`Expected isError for no-access app, got ${JSON.stringify(denied)}`);
    const deniedImage = await mcpCall(facade, 'get_screen_image', { appId: APP_NO_ACCESS_ID, buildId: BUILD_ID, screenId: SCREEN_ID });
    if (!deniedImage.isError) throw new Error(`Expected isError for no-access image, got ${JSON.stringify(deniedImage)}`);
    const badArgs = await mcpCall(facade, 'get_build', { appId: 'nope' });
    if (!badArgs.isError) throw new Error(`Expected isError for bad args, got ${JSON.stringify(badArgs)}`);
    console.log('  PASS');

    console.log('\nTest: /api/mcp JSON-RPC batch → 400 -32600');
    const batch = await mcpPost(facade, [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    ]);
    expectStatus(batch.statusCode, 400);
    const batchCode = (batch.json as { error?: { code?: number } }).error?.code;
    if (batchCode !== -32600) throw new Error(`Expected error code -32600, got ${JSON.stringify(batch.json)}`);
    console.log('  PASS');

    console.log('\nTest: GET/DELETE /api/mcp → 405 with Allow: POST');
    for (const method of ['GET', 'DELETE'] as const) {
        const req = authed(method === 'GET' ? HttpRequest.GET('/api/mcp') : HttpRequest.DELETE('/api/mcp'), VALID_PAT);
        const response = await facade.request(req);
        expectStatus(response.statusCode, 405);
        const allow = response.getHeader?.('allow') ?? (response as unknown as { headers?: Record<string, unknown> }).headers?.allow;
        if (String(allow).toUpperCase() !== 'POST') throw new Error(`Expected Allow: POST, got ${String(allow)}`);
    }
    console.log('  PASS');
}

function expectStatus(actual: number, expected: number) {
    if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
    }
}
