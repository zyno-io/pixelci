import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, TestingHelpers } from '@zyno-io/ts-server-foundation';

import { CoreAppOptions } from '../../src/app';
import { UserEntity } from '../../src/entities/User.entity';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

TestingHelpers.setDefaultDatabaseConfig({
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: 3306,
    MYSQL_USER: 'root',
    MYSQL_PASSWORD_SECRET: 'secret'
});

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

    // Phase 7: VCS integration CRUD
    await testVcsIntegrationCrud(facade, adminJwt);
}

async function testOnboardingStatusFresh(facade: ReturnType<typeof TestingHelpers.createTestingFacade>) {
    console.log('\nTest: onboarding status on fresh install → not onboarded');
    const response = await facade.request(HttpRequest.GET('/api/session/onboarding-status'));
    assertStatus(response, 200);
    const body = response.json as { isOnboarded: boolean };
    if (body.isOnboarded !== false) {
        throw new Error(`Expected isOnboarded=false, got ${body.isOnboarded}`);
    }
    console.log('  PASS');
}

async function testCreateOnboardingVcsIntegration(facade: ReturnType<typeof TestingHelpers.createTestingFacade>) {
    console.log('\nTest: create onboarding VCS integration → 200');
    const response = await facade.request(
        HttpRequest.POST('/api/session/onboarding/vcs-integration').json({
            name: 'Test GitLab',
            platform: 'gitlab',
            config: {
                url: 'https://gitlab.example.com',
                clientId: 'test-client-id',
                clientSecret: 'test-client-secret'
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
    console.log('\nTest: unauthenticated providers list exposes only id/name (no config/secrets)');
    const response = await facade.request(HttpRequest.GET('/api/session/providers'));
    assertStatus(response, 200);
    if (String(response.body).includes('test-client-secret')) {
        throw new Error(`Providers response leaks the client secret: ${response.body}`);
    }
    const providers = response.json as Record<string, unknown>[];
    if (!providers.length || providers.some(p => Object.keys(p).sort().join(',') !== 'id,name')) {
        throw new Error(`Expected providers with exactly {id, name}, got ${response.body}`);
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
    console.log('\nTest: create onboarding VCS integration when already onboarded → 400');
    const response = await facade.request(
        HttpRequest.POST('/api/session/onboarding/vcs-integration').json({
            name: 'Second GitLab',
            platform: 'gitlab',
            config: {
                url: 'https://gitlab2.example.com',
                clientId: 'test-client-id-2',
                clientSecret: 'test-client-secret-2'
            }
        })
    );
    assertStatus(response, 400);
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

async function testAdminCanListVcsIntegrations(facade: ReturnType<typeof TestingHelpers.createTestingFacade>, jwt: string) {
    console.log('\nTest: admin can list VCS integrations → 200');
    const response = await facade.request(HttpRequest.GET('/api/admin/vcs-integrations').header('authorization', `Bearer ${jwt}`));
    assertStatus(response, 200);
    const body = response.json as Array<{ id: string; name: string; platform: string }>;
    if (!Array.isArray(body) || body.length === 0) {
        throw new Error('Expected non-empty array of integrations');
    }
    console.log('  PASS');
}

async function testAdminCanListUsers(facade: ReturnType<typeof TestingHelpers.createTestingFacade>, jwt: string) {
    console.log('\nTest: admin can list users → 200');
    const response = await facade.request(HttpRequest.GET('/api/admin/users').header('authorization', `Bearer ${jwt}`));
    assertStatus(response, 200);
    const body = response.json as Array<{ id: string; name: string; isAdmin: boolean }>;
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
    const created = createResponse.json as { id: string; name: string; platform: string };
    if (created.name !== 'CRUD Test GitLab') {
        throw new Error(`Expected name='CRUD Test GitLab', got ${created.name}`);
    }

    // Show
    console.log('  Reading integration...');
    const showResponse = await facade.request(HttpRequest.GET(`/api/admin/vcs-integrations/${created.id}`).header('authorization', `Bearer ${jwt}`));
    assertStatus(showResponse, 200);
    const shown = showResponse.json as { id: string; name: string; config: { url: string } };
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
