import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { generateKeyPairSync } from 'crypto';

import { CoreAppOptions } from '../../src/app';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { SEALED_PREFIX, SecretBox, setSecretBoxForTesting } from '../../src/services/secrets/SecretBox';
import { openIntegrationConfig, sealIntegrationConfig } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
const SETUP_TOKEN = 'test-setup-token-0123456789';
process.env.SETUP_TOKEN = SETUP_TOKEN;
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

function assertSealed(cfg: Record<string, string>, fields: string[]) {
    for (const f of fields) {
        if (!cfg[f]?.startsWith(SEALED_PREFIX)) throw new Error(`Expected ${f} to be stored sealed`);
    }
}

const ZERO_ID = '00000000-0000-0000-0000-000000000000';

run()
    .then(() => {
        console.log('\nAll onboarding tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

async function run() {
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_onboard'
    });
    await facade.start();

    // Phase 1: fresh install (no VCS integrations, no users)
    await testOnboardingStatusFresh(facade);
    await testOnboardingRejectsBadToken(facade);
    await testCreateOnboardingVcsIntegration(facade);
    await testOnboardingStatusAfterSetup(facade);
    await testProvidersDoNotLeakConfig(facade);
    await testCreateOnboardingVcsIntegrationBlocked(facade);

    // Phase 2: admin endpoints require auth
    await testAdminEndpointsRequireAuth(facade);

    // Phase 3: admin user can access admin endpoints
    await createAdminUser();
    const adminJwt = await JWT.generate({ subject: ZERO_ID });
    await testAdminCanListVcsIntegrations(facade, adminJwt);
    await testAdminCanListUsers(facade, adminJwt);

    // Phase 4: non-admin user cannot access admin endpoints
    const nonAdminId = '11111111-1111-1111-1111-111111111111';
    await createNonAdminUser(nonAdminId);
    const nonAdminJwt = await JWT.generate({ subject: nonAdminId });
    await testNonAdminCannotAccessAdmin(facade, nonAdminJwt);

    // Phase 5: admin can toggle user admin status
    await testAdminCanToggleUserAdmin(facade, adminJwt, nonAdminId);
    await testAdminCannotToggleSelf(facade, adminJwt);

    // Phase 6: session includes isAdmin
    await testSessionIncludesIsAdmin(facade, adminJwt);
    await testOnboardingStatusHasAdmin(facade);

    // Phase 7: VCS integration CRUD
    await testVcsIntegrationCrud(facade, adminJwt);

    // Phase 8: GitHub integrations, redaction, merge semantics
    await testGitLabShowRedactsSecret(facade, adminJwt);
    await testGitLabUpdateWithoutPlatform(facade, adminJwt);
    await testGitHubIntegrationLifecycle(facade, adminJwt);
    await testGitHubValidation(facade, adminJwt);
    await testLegacyGitHubRowPartialUpdate(facade, adminJwt);
    await testLostKeyRecovery(facade, adminJwt);
    await testSessionIncludesVcsId(facade, adminJwt);
    await testAppCreateRequiresVcsProjectId(facade, adminJwt);
    await testOnboardingGitHubOnFreshDb();
    await testOnboardingConcurrentRequests();
    await testOnboardingDisabledWithoutToken();
}

const GITHUB_KEY = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
}).privateKey;

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;

function githubInput(overrides: Record<string, unknown> = {}) {
    return {
        name: 'Test GitHub',
        platform: 'github',
        config: {
            clientId: 'gh-client',
            clientSecret: 'gh-secret',
            appId: '12345',
            privateKey: GITHUB_KEY,
            oidcAudience: 'https://pixelci.example.com/',
            ...overrides
        }
    };
}

function adminReq(request: HttpRequest, jwt: string) {
    return request.header('authorization', `Bearer ${jwt}`);
}

async function testGitLabShowRedactsSecret(facade: Facade, jwt: string) {
    console.log('\nTest: admin show does not expose the GitLab clientSecret');
    const list = (await facade.request(adminReq(HttpRequest.GET('/api/admin/vcs-integrations'), jwt))).json as Array<{
        id: string;
        platform: string;
    }>;
    const gl = list.find(i => i.platform === 'gitlab')!;
    const response = await facade.request(adminReq(HttpRequest.GET(`/api/admin/vcs-integrations/${gl.id}`), jwt));
    assertStatus(response, 200);
    if (String(response.body).includes('secret')) throw new Error(`show leaks a secret: ${response.body}`);
    const body = response.json as {
        platform: string;
        config: { url: string; clientId: string };
    };
    if (body.platform !== 'gitlab' || !body.config.url || !body.config.clientId) throw new Error(`Unexpected show body: ${response.body}`);
    console.log('  PASS');
}

async function testGitLabUpdateWithoutPlatform(facade: Facade, jwt: string) {
    console.log('\nTest: GitLab PUT without platform still works (and an empty clientSecret keeps the stored one)');
    const list = (await facade.request(adminReq(HttpRequest.GET('/api/admin/vcs-integrations'), jwt))).json as Array<{
        id: string;
        platform: string;
    }>;
    const gl = list.find(i => i.platform === 'gitlab')!;
    const response = await facade.request(
        adminReq(HttpRequest.PUT(`/api/admin/vcs-integrations/${gl.id}`), jwt).json({
            name: 'Renamed GitLab',
            config: {
                url: 'https://gitlab.example.com',
                clientId: 'new-client-id',
                clientSecret: ''
            }
        })
    );
    assertStatus(response, 200);
    const stored = await VcsIntegrationEntity.query().filter({ id: gl.id }).findOne();
    assertSealed(stored.config as unknown as Record<string, string>, ['clientSecret']);
    const cfg = openIntegrationConfig(stored) as { clientId: string; clientSecret: string };
    if (cfg.clientId !== 'new-client-id' || cfg.clientSecret !== 'test-client-secret') {
        throw new Error(`Unexpected stored GitLab config: ${JSON.stringify(stored.config)}`);
    }
    console.log('  PASS');
}

async function testGitHubIntegrationLifecycle(facade: Facade, jwt: string) {
    console.log('\nTest: GitHub integration create keeps appId/privateKey/oidcAudience; Enterprise url is not coerced');
    const create = await facade.request(
        adminReq(HttpRequest.POST('/api/admin/vcs-integrations'), jwt).json(githubInput({ url: 'https://ghe.example.com/' }))
    );
    assertStatus(create, 200);
    const created = create.json as { id: string; platform: string };
    if (created.platform !== 'github') throw new Error(`Expected github, got ${created.platform}`);

    const stored = await VcsIntegrationEntity.query().filter({ id: created.id }).findOne();
    assertSealed(stored.config as unknown as Record<string, string>, ['clientSecret', 'privateKey']);
    const cfg = openIntegrationConfig(stored) as unknown as Record<string, string>;
    if (
        cfg.appId !== '12345' ||
        cfg.privateKey !== GITHUB_KEY.trim() ||
        cfg.oidcAudience !== 'https://pixelci.example.com' ||
        cfg.url !== 'https://ghe.example.com'
    ) {
        throw new Error(`Stored GitHub config mismatch: ${JSON.stringify(stored.config)}`);
    }

    const show = await facade.request(adminReq(HttpRequest.GET(`/api/admin/vcs-integrations/${created.id}`), jwt));
    assertStatus(show, 200);
    if (String(show.body).includes('gh-secret') || String(show.body).includes('PRIVATE KEY')) throw new Error(`show leaks secrets: ${show.body}`);
    const detail = show.json as {
        platform: string;
        config: Record<string, unknown>;
    };
    if (
        detail.platform !== 'github' ||
        detail.config.hasPrivateKey !== true ||
        detail.config.appId !== '12345' ||
        detail.config.url !== 'https://ghe.example.com'
    ) {
        throw new Error(`Unexpected GitHub show body: ${show.body}`);
    }

    console.log('  merge: name-only, partial config, blank secrets keep stored, blank url removes it');
    const nameOnly = await facade.request(adminReq(HttpRequest.PUT(`/api/admin/vcs-integrations/${created.id}`), jwt).json({ name: 'GH renamed' }));
    assertStatus(nameOnly, 200);
    const merge = await facade.request(
        adminReq(HttpRequest.PUT(`/api/admin/vcs-integrations/${created.id}`), jwt).json({
            platform: 'github',
            config: {
                oidcAudience: 'https://other.example.com//',
                clientSecret: '',
                privateKey: '',
                url: ''
            }
        })
    );
    assertStatus(merge, 200);
    const after = openIntegrationConfig(await VcsIntegrationEntity.query().filter({ id: created.id }).findOne()) as unknown as Record<string, string>;
    if (
        after.oidcAudience !== 'https://other.example.com' ||
        after.clientSecret !== 'gh-secret' ||
        after.privateKey !== GITHUB_KEY.trim() ||
        after.appId !== '12345' ||
        'url' in after
    ) {
        throw new Error(`Unexpected merged GitHub config: ${JSON.stringify(after)}`);
    }

    console.log('  wrong-platform PUT -> 400');
    assertStatus(
        await facade.request(
            adminReq(HttpRequest.PUT(`/api/admin/vcs-integrations/${created.id}`), jwt).json({
                config: { url: 'https://x.example.com', clientId: 'x' }
            })
        ),
        400
    );

    assertStatus(await facade.request(adminReq(HttpRequest.DELETE(`/api/admin/vcs-integrations/${created.id}`), jwt)), 200);
    console.log('  PASS');
}

async function testGitHubValidation(facade: Facade, jwt: string) {
    console.log('\nTest: invalid GitHub config -> 400');
    const bad = [
        githubInput({ privateKey: 'not a pem' }),
        githubInput({ appId: 'abc' }),
        githubInput({ appId: '' }),
        githubInput({ url: 'ftp://ghe.example.com' }),
        githubInput({ oidcAudience: '' })
    ];
    for (const input of bad) {
        assertStatus(await facade.request(adminReq(HttpRequest.POST('/api/admin/vcs-integrations'), jwt).json(input)), 400);
    }
    console.log('  PASS');
}

async function testLegacyGitHubRowPartialUpdate(facade: Facade, jwt: string) {
    console.log('\nTest: GitHub row without appId/privateKey accepts partial updates until app credentials are configured');
    const id = '00000000-0000-0000-0000-0000000000b1';
    await createPersistedEntity(VcsIntegrationEntity, {
        id,
        name: 'Legacy GitHub',
        platform: 'github',
        config: {
            clientId: 'cid',
            clientSecret: 'csecret',
            oidcAudience: 'https://old.example'
        }
    });
    const put = (config: Record<string, string>) =>
        facade.request(
            adminReq(HttpRequest.PUT(`/api/admin/vcs-integrations/${id}`), jwt).json({
                platform: 'github',
                config
            })
        );

    assertStatus(await put({ oidcAudience: 'https://new.example' }), 200);
    const stored = await VcsIntegrationEntity.query().filter({ id }).findOne();
    if ((stored.config as { oidcAudience?: string }).oidcAudience !== 'https://new.example') {
        throw new Error(`Expected oidcAudience to be updated, got ${JSON.stringify(stored.config)}`);
    }
    // Supplying appId without a privateKey is incomplete -> 400
    assertStatus(await put({ appId: '123' }), 400);

    assertStatus(await facade.request(adminReq(HttpRequest.DELETE(`/api/admin/vcs-integrations/${id}`), jwt)), 200);
    console.log('  PASS');
}

async function testSessionIncludesVcsId(facade: Facade, jwt: string) {
    console.log('\nTest: session response includes vcsId');
    const response = await facade.request(HttpRequest.GET('/api/session/me').header('authorization', `Bearer ${jwt}`));
    assertStatus(response, 200);
    if ((response.json as { vcsId: string }).vcsId !== ZERO_ID) throw new Error(`Expected vcsId=${ZERO_ID}, got ${response.body}`);
    console.log('  PASS');
}

async function testOnboardingGitHubOnFreshDb() {
    console.log('\nTest: onboarding with a GitHub integration on a fresh DB');
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_onboardgh'
    });
    await facade.start();
    const response = await facade.request(
        HttpRequest.POST('/api/session/onboarding/vcs-integration').json({
            setupToken: SETUP_TOKEN,
            integration: githubInput()
        })
    );
    assertStatus(response, 200);
    const body = response.json as { id: string; platform: string };
    if (body.platform !== 'github') throw new Error(`Expected github, got ${response.body}`);
    const stored = await VcsIntegrationEntity.query().filter({ id: body.id }).findOne();
    assertSealed(stored.config as unknown as Record<string, string>, ['clientSecret', 'privateKey']);
    const cfg = openIntegrationConfig(stored) as unknown as Record<string, string>;
    if (cfg.appId !== '12345' || !cfg.privateKey || cfg.oidcAudience !== 'https://pixelci.example.com' || 'url' in cfg) {
        throw new Error(`Stored onboarding GitHub config mismatch: ${JSON.stringify(stored.config)}`);
    }
    const providers = (await facade.request(HttpRequest.GET('/api/session/providers'))).json as Array<{ platform: string }>;
    if (providers[0].platform !== 'github') throw new Error('providers should report platform=github');
    console.log('  PASS');
}

async function testOnboardingStatusFresh(facade: ReturnType<typeof TestingHelpers.createTestingFacade>) {
    console.log('\nTest: onboarding status on fresh install → not onboarded');
    const response = await facade.request(HttpRequest.GET('/api/session/onboarding-status'));
    assertStatus(response, 200);
    const body = response.json as { isOnboarded: boolean; setupEnabled: boolean };
    if (body.isOnboarded !== false) {
        throw new Error(`Expected isOnboarded=false, got ${body.isOnboarded}`);
    }
    if ((body as { hasAdmin?: boolean }).hasAdmin !== false) {
        throw new Error('Expected hasAdmin=false on a fresh install');
    }
    if (body.setupEnabled !== true) {
        throw new Error(`Expected setupEnabled=true, got ${body.setupEnabled}`);
    }
    console.log('  PASS');
}

function onboardingBody(setupToken?: string) {
    return {
        ...(setupToken === undefined ? {} : { setupToken }),
        integration: githubInput()
    };
}

async function testOnboardingRejectsBadToken(facade: Facade) {
    console.log('\nTest: onboarding without / with a wrong setup token -> 403, nothing created');
    for (const body of [onboardingBody(), onboardingBody('wrong'), onboardingBody(SETUP_TOKEN + 'x'), onboardingBody('')]) {
        assertStatus(await facade.request(HttpRequest.POST('/api/session/onboarding/vcs-integration').json(body)), 403);
    }
    if ((await VcsIntegrationEntity.query().count()) !== 0) throw new Error('A rejected request created an integration');
    console.log('  PASS');
}

async function testOnboardingConcurrentRequests() {
    console.log('\nTest: concurrent onboarding with the correct token -> exactly one 200');
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_onboardrace',
        useSavepoints: false
    });
    await facade.start();
    const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
            facade.request(
                HttpRequest.POST('/api/session/onboarding/vcs-integration').json({
                    setupToken: SETUP_TOKEN,
                    integration: { ...githubInput(), name: `Race ${i}` }
                })
            )
        )
    );
    const codes = responses.map(r => r.statusCode).sort();
    if (codes.filter(c => c === 200).length !== 1 || codes.filter(c => c === 400 || c === 403).length !== 5) {
        throw new Error(`Expected one 200 and five 400/403, got ${codes.join(',')}`);
    }
    if ((await VcsIntegrationEntity.query().count()) !== 1) throw new Error('Expected exactly one integration row');
    console.log('  PASS');
}

async function testOnboardingDisabledWithoutToken() {
    console.log('\nTest: SETUP_TOKEN unset (or too short) -> setup disabled, onboarding 403');
    for (const value of [undefined, 'short']) {
        // An empty value stands in for "unset": .env.development would otherwise re-supply SETUP_TOKEN
        process.env.SETUP_TOKEN = value ?? '';
        const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
            enableDatabase: true,
            databasePrefix: 'pixelci_onboardoff'
        });
        await facade.start();
        const status = (await facade.request(HttpRequest.GET('/api/session/onboarding-status'))).json as { setupEnabled: boolean };
        if (status.setupEnabled !== false) throw new Error(`Expected setupEnabled=false for ${value}`);
        for (const token of [SETUP_TOKEN, value ?? '', 'undefined']) {
            assertStatus(await facade.request(HttpRequest.POST('/api/session/onboarding/vcs-integration').json(onboardingBody(token))), 403);
        }
        await facade.stop();
    }
    process.env.SETUP_TOKEN = SETUP_TOKEN;
    console.log('  PASS');
}

async function testCreateOnboardingVcsIntegration(facade: ReturnType<typeof TestingHelpers.createTestingFacade>) {
    console.log('\nTest: create onboarding VCS integration → 200');
    const response = await facade.request(
        HttpRequest.POST('/api/session/onboarding/vcs-integration').json({
            setupToken: SETUP_TOKEN,
            integration: {
                name: 'Test GitLab',
                platform: 'gitlab',
                config: {
                    url: 'https://gitlab.example.com',
                    clientId: 'test-client-id',
                    clientSecret: 'test-client-secret'
                }
            }
        })
    );
    assertStatus(response, 200);
    const body = response.json as { id: string; name: string; platform: string };
    if (body.name !== 'Test GitLab') {
        throw new Error(`Expected name='Test GitLab', got ${body.name}`);
    }
    if (body.platform !== 'gitlab') {
        throw new Error(`Expected platform='gitlab', got ${body.platform}`);
    }
    console.log('  PASS');
}

async function testProvidersDoNotLeakConfig(facade: ReturnType<typeof TestingHelpers.createTestingFacade>) {
    console.log('\nTest: unauthenticated providers list exposes only id/name/platform (no config/secrets)');
    const response = await facade.request(HttpRequest.GET('/api/session/providers'));
    assertStatus(response, 200);
    if (String(response.body).includes('test-client-secret')) {
        throw new Error(`Providers response leaks the client secret: ${response.body}`);
    }
    const providers = response.json as Record<string, unknown>[];
    if (!providers.length || providers.some(p => Object.keys(p).sort().join(',') !== 'id,name,platform')) {
        throw new Error(`Expected providers with exactly {id, name, platform}, got ${response.body}`);
    }
    console.log('  PASS');
}

async function testOnboardingStatusAfterSetup(facade: ReturnType<typeof TestingHelpers.createTestingFacade>) {
    console.log('\nTest: onboarding status after setup → onboarded');
    const response = await facade.request(HttpRequest.GET('/api/session/onboarding-status'));
    assertStatus(response, 200);
    const body = response.json as { isOnboarded: boolean };
    if (body.isOnboarded !== true) {
        throw new Error(`Expected isOnboarded=true, got ${body.isOnboarded}`);
    }
    console.log('  PASS');
}

async function testCreateOnboardingVcsIntegrationBlocked(facade: ReturnType<typeof TestingHelpers.createTestingFacade>) {
    console.log('\nTest: create onboarding VCS integration when already onboarded → 403 (even with the correct token)');
    const response = await facade.request(
        HttpRequest.POST('/api/session/onboarding/vcs-integration').json({
            setupToken: SETUP_TOKEN,
            integration: {
                name: 'Second GitLab',
                platform: 'gitlab',
                config: {
                    url: 'https://gitlab2.example.com',
                    clientId: 'test-client-id-2',
                    clientSecret: 'test-client-secret-2'
                }
            }
        })
    );
    assertStatus(response, 403);
    console.log('  PASS');
}

async function testAdminEndpointsRequireAuth(facade: ReturnType<typeof TestingHelpers.createTestingFacade>) {
    console.log('\nTest: admin endpoints require authentication → 401');
    const endpoints = [HttpRequest.GET('/api/admin/vcs-integrations'), HttpRequest.GET('/api/admin/users')];
    for (const request of endpoints) {
        const response = await facade.request(request);
        if (response.statusCode !== 401) {
            throw new Error(`Expected 401, got ${response.statusCode}`);
        }
    }
    console.log('  PASS');
}

async function createAdminUser() {
    await createPersistedEntity(UserEntity, {
        id: ZERO_ID,
        name: 'Admin User',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: true,
        vcsId: ZERO_ID,
        vcsUserId: 'admin-vcs-user'
    });
}

async function createNonAdminUser(id: string) {
    await createPersistedEntity(UserEntity, {
        id,
        name: 'Regular User',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: false,
        vcsId: ZERO_ID,
        vcsUserId: 'regular-vcs-user'
    });
}

async function testAppCreateRequiresVcsProjectId(facade: Facade, jwt: string) {
    console.log('\nTest: POST /api/apps for a GitLab integration without vcsProjectId → 400');
    const integrations = (await facade.request(HttpRequest.GET('/api/admin/vcs-integrations').header('authorization', `Bearer ${jwt}`)))
        .json as Array<{
        id: string;
        platform: string;
    }>;
    const gitlab = integrations.find(i => i.platform === 'gitlab');
    if (!gitlab) throw new Error('No GitLab integration available');
    const post = (extra: Record<string, unknown>) =>
        facade.request(
            HttpRequest.POST('/api/apps')
                .header('authorization', `Bearer ${jwt}`)
                .json({ name: 'Unbound', vcsId: gitlab.id, projectPath: 'group/unbound', defaultBranchName: 'main', ...extra })
        );
    assertStatus(await post({}), 400);
    assertStatus(await post({ vcsProjectId: 0 }), 400);
    assertStatus(await post({ vcsProjectId: -5 }), 400);
    assertStatus(await post({ vcsProjectId: 1.5 }), 400);
    console.log('  PASS');
}

async function testAdminCanListVcsIntegrations(facade: ReturnType<typeof TestingHelpers.createTestingFacade>, jwt: string) {
    console.log('\nTest: admin can list VCS integrations → 200');
    const response = await facade.request(HttpRequest.GET('/api/admin/vcs-integrations').header('authorization', `Bearer ${jwt}`));
    assertStatus(response, 200);
    const body = response.json as Array<{
        id: string;
        name: string;
        platform: string;
    }>;
    if (!Array.isArray(body) || body.length === 0) {
        throw new Error('Expected non-empty array of integrations');
    }
    console.log('  PASS');
}

async function testAdminCanListUsers(facade: ReturnType<typeof TestingHelpers.createTestingFacade>, jwt: string) {
    console.log('\nTest: admin can list users → 200');
    const response = await facade.request(HttpRequest.GET('/api/admin/users').header('authorization', `Bearer ${jwt}`));
    assertStatus(response, 200);
    const body = response.json as Array<{
        id: string;
        name: string;
        isAdmin: boolean;
    }>;
    if (!Array.isArray(body) || body.length === 0) {
        throw new Error('Expected non-empty array of users');
    }
    console.log('  PASS');
}

async function testNonAdminCannotAccessAdmin(facade: ReturnType<typeof TestingHelpers.createTestingFacade>, jwt: string) {
    console.log('\nTest: non-admin cannot access admin endpoints → 403');
    const endpoints = [HttpRequest.GET('/api/admin/vcs-integrations'), HttpRequest.GET('/api/admin/users')];
    for (const request of endpoints) {
        const response = await facade.request(request.header('authorization', `Bearer ${jwt}`));
        if (response.statusCode !== 403) {
            throw new Error(`Expected 403, got ${response.statusCode}`);
        }
    }
    console.log('  PASS');
}

async function testAdminCanToggleUserAdmin(facade: ReturnType<typeof TestingHelpers.createTestingFacade>, jwt: string, targetUserId: string) {
    console.log('\nTest: admin can promote user to admin → 200');
    const promoteResponse = await facade.request(
        HttpRequest.PUT(`/api/admin/users/${targetUserId}`).header('authorization', `Bearer ${jwt}`).json({ isAdmin: true })
    );
    assertStatus(promoteResponse, 200);
    const promoteBody = promoteResponse.json as { id: string; isAdmin: boolean };
    if (promoteBody.isAdmin !== true) {
        throw new Error(`Expected isAdmin=true after promotion, got ${promoteBody.isAdmin}`);
    }

    console.log('\nTest: admin can demote user from admin → 200');
    const demoteResponse = await facade.request(
        HttpRequest.PUT(`/api/admin/users/${targetUserId}`).header('authorization', `Bearer ${jwt}`).json({ isAdmin: false })
    );
    assertStatus(demoteResponse, 200);
    const demoteBody = demoteResponse.json as { id: string; isAdmin: boolean };
    if (demoteBody.isAdmin !== false) {
        throw new Error(`Expected isAdmin=false after demotion, got ${demoteBody.isAdmin}`);
    }
    console.log('  PASS');
}

async function testAdminCannotToggleSelf(facade: ReturnType<typeof TestingHelpers.createTestingFacade>, jwt: string) {
    console.log('\nTest: admin cannot toggle own admin status → 400');
    const response = await facade.request(
        HttpRequest.PUT(`/api/admin/users/${ZERO_ID}`).header('authorization', `Bearer ${jwt}`).json({ isAdmin: false })
    );
    assertStatus(response, 400);
    console.log('  PASS');
}

async function testOnboardingStatusHasAdmin(facade: Facade) {
    console.log('\nTest: onboarding-status reports hasAdmin=true once an admin exists');
    const body = (await facade.request(HttpRequest.GET('/api/session/onboarding-status'))).json as { hasAdmin: boolean };
    if (body.hasAdmin !== true) throw new Error(`Expected hasAdmin=true, got ${JSON.stringify(body)}`);
    console.log('  PASS');
}

async function testSessionIncludesIsAdmin(facade: ReturnType<typeof TestingHelpers.createTestingFacade>, jwt: string) {
    console.log('\nTest: session response includes isAdmin → true');
    const response = await facade.request(HttpRequest.GET('/api/session/me').header('authorization', `Bearer ${jwt}`));
    assertStatus(response, 200);
    const body = response.json as { id: string; name: string; isAdmin: boolean };
    if (body.isAdmin !== true) {
        throw new Error(`Expected isAdmin=true, got ${body.isAdmin}`);
    }
    console.log('  PASS');
}

async function testVcsIntegrationCrud(facade: ReturnType<typeof TestingHelpers.createTestingFacade>, jwt: string) {
    console.log('\nTest: VCS integration CRUD');

    // Create
    console.log('  Creating integration...');
    const createResponse = await facade.request(
        HttpRequest.POST('/api/admin/vcs-integrations')
            .header('authorization', `Bearer ${jwt}`)
            .json({
                name: 'CRUD Test GitLab',
                platform: 'gitlab',
                config: {
                    url: 'https://crud-gitlab.example.com',
                    clientId: 'crud-client-id',
                    clientSecret: 'crud-client-secret'
                }
            })
    );
    assertStatus(createResponse, 200);
    const created = createResponse.json as {
        id: string;
        name: string;
        platform: string;
    };
    if (created.name !== 'CRUD Test GitLab') {
        throw new Error(`Expected name='CRUD Test GitLab', got ${created.name}`);
    }

    // Show
    console.log('  Reading integration...');
    const showResponse = await facade.request(HttpRequest.GET(`/api/admin/vcs-integrations/${created.id}`).header('authorization', `Bearer ${jwt}`));
    assertStatus(showResponse, 200);
    const shown = showResponse.json as {
        id: string;
        name: string;
        config: { url: string };
    };
    if (shown.config.url !== 'https://crud-gitlab.example.com') {
        throw new Error(`Expected config.url='https://crud-gitlab.example.com', got ${shown.config.url}`);
    }

    // Update
    console.log('  Updating integration...');
    const updateResponse = await facade.request(
        HttpRequest.PUT(`/api/admin/vcs-integrations/${created.id}`)
            .header('authorization', `Bearer ${jwt}`)
            .json({
                name: 'Updated GitLab',
                config: {
                    url: 'https://updated-gitlab.example.com',
                    clientId: 'updated-client-id',
                    clientSecret: 'updated-client-secret'
                }
            })
    );
    assertStatus(updateResponse, 200);
    const updated = updateResponse.json as { id: string; name: string };
    if (updated.name !== 'Updated GitLab') {
        throw new Error(`Expected name='Updated GitLab', got ${updated.name}`);
    }

    // Delete
    console.log('  Deleting integration...');
    const deleteResponse = await facade.request(
        HttpRequest.DELETE(`/api/admin/vcs-integrations/${created.id}`).header('authorization', `Bearer ${jwt}`)
    );
    assertStatus(deleteResponse, 200);

    // Verify deleted
    console.log('  Verifying deletion...');
    const verifyResponse = await facade.request(
        HttpRequest.GET(`/api/admin/vcs-integrations/${created.id}`).header('authorization', `Bearer ${jwt}`)
    );
    assertStatus(verifyResponse, 404);

    console.log('  PASS');
}

function assertStatus(response: { statusCode: number; body?: Buffer | string }, expected: number) {
    if (response.statusCode !== expected) {
        throw new Error(`Expected ${expected} but got ${response.statusCode}: ${response.body}`);
    }
}

async function testLostKeyRecovery(facade: Facade, jwt: string) {
    console.log('\nTest: integration with unreadable secrets (lost key) can be recovered by PUT with new secrets');
    const hex = (n: number) => Buffer.alloc(32, n).toString('hex');
    const create = async (input: object) => {
        const r = await facade.request(adminReq(HttpRequest.POST('/api/admin/vcs-integrations'), jwt).json(input));
        assertStatus(r, 200);
        return (r.json as { id: string }).id;
    };
    const glId = await create({
        name: 'Lost GL',
        platform: 'gitlab',
        config: { url: 'https://gl-lost.example.com', clientId: 'c', clientSecret: 'old-gl' }
    });
    const ghId = await create(githubInput({ oidcAudience: 'https://lost.example.com' }));
    const put = (id: string, body: object) => facade.request(adminReq(HttpRequest.PUT(`/api/admin/vcs-integrations/${id}`), jwt).json(body));

    // Two different secrets, neither of which can decrypt what was sealed under the original dev secret.
    for (const spec of [hex(9), hex(7)]) {
        setSecretBoxForTesting(new SecretBox(spec));
        try {
            assertStatus(await put(glId, { config: { clientId: 'c2', clientSecret: '' } }), 400);
            assertStatus(await put(ghId, { platform: 'github', config: { clientSecret: 'new-gh' } }), 400);
            assertStatus(await put(glId, { config: { clientSecret: 'new-gl' } }), 200);
            assertStatus(await put(ghId, { platform: 'github', config: { clientSecret: 'new-gh', privateKey: GITHUB_KEY } }), 200);

            const gl = openIntegrationConfig(await VcsIntegrationEntity.query().filter({ id: glId }).findOne()) as unknown as Record<string, string>;
            const gh = openIntegrationConfig(await VcsIntegrationEntity.query().filter({ id: ghId }).findOne()) as unknown as Record<string, string>;
            if (gl.clientSecret !== 'new-gl' || gh.clientSecret !== 'new-gh' || gh.privateKey !== GITHUB_KEY.trim()) {
                throw new Error('Recovered config does not hold the new secrets');
            }
        } finally {
            setSecretBoxForTesting(undefined);
        }
        // Make them unreadable again for the next key spec (sealed under the original dev key).
        for (const [id, _platform, cfg] of [
            [glId, 'gitlab', { url: 'https://gl-lost.example.com', clientId: 'c', clientSecret: 'old-gl' }],
            [ghId, 'github', { ...githubInput().config, privateKey: GITHUB_KEY.trim(), oidcAudience: 'https://lost.example.com' }]
        ] as const) {
            await VcsIntegrationEntity.query()
                .filter({ id })
                .patchMany({ config: sealIntegrationConfig(cfg as never) });
        }
    }
    console.log('  PASS');
}
