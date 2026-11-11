import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { createServer, Server } from 'http';
import { exportJWK, generateKeyPair, JWK, SignJWT } from 'jose';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { IGitHubConfig, VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

const VCS_ID = 'e2234567-aaaa-bbbb-cccc-000000000001';
const VCS_ROUNDTRIP_ID = 'e2234567-aaaa-bbbb-cccc-000000000002';
const APP_ID = 'e2234567-aaaa-bbbb-cccc-000000000010';
const BRANCH_ID = 'e2234567-aaaa-bbbb-cccc-000000000011';
const UNBOUND_APP_ID = 'e2234567-aaaa-bbbb-cccc-000000000020';
const UNBOUND_BRANCH_ID = 'e2234567-aaaa-bbbb-cccc-000000000021';
const VCS_NO_AUD_ID = 'e2234567-aaaa-bbbb-cccc-000000000003';
const NO_AUD_APP_ID = 'e2234567-aaaa-bbbb-cccc-000000000030';
const NO_AUD_BRANCH_ID = 'e2234567-aaaa-bbbb-cccc-000000000031';
const AUDIENCE = 'https://pixelci.test';
const REPO_ID = 12345;
const KID = 'test-key';

let issuer: string;
let jwksServer: Server;
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;

run()
    .then(() => {
        console.log('\nAll GitHub OIDC tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

async function startJwksServer(publicJwk: JWK): Promise<void> {
    jwksServer = createServer((req, res) => {
        if (req.url === '/.well-known/jwks') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>(resolve => jwksServer.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(jwksServer.address() as { port: number }).port}`;
}

interface ITokenOpts {
    claims?: Record<string, unknown>;
    aud?: string;
    iss?: string;
    exp?: string | number;
    key?: CryptoKey;
}

async function mintToken(opts: ITokenOpts = {}): Promise<string> {
    const claims = {
        repository: 'acme/app',
        repository_id: String(REPO_ID),
        ref: 'refs/heads/main',
        ref_type: 'branch',
        head_ref: '',
        sha: 'a'.repeat(40),
        run_id: '987654',
        check_run_id: '128602857139',
        run_attempt: '1',
        actor: 'octocat',
        event_name: 'push',
        ...opts.claims
    };
    return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(opts.iss ?? issuer)
        .setAudience(opts.aud ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '5m')
        .sign(opts.key ?? privateKey);
}

async function createBuild(facade: Facade, token: string, appId = APP_ID) {
    return facade.request(HttpRequest.POST(`/api/apps/${appId}/builds`).header('authorization', `Bearer ${token}`));
}

async function expectStatus(facade: Facade, name: string, token: string, expected: number, appId = APP_ID) {
    console.log(`\nTest: ${name} → ${expected}`);
    const response = await createBuild(facade, token, appId);
    if (response.statusCode !== expected) {
        throw new Error(`Expected ${expected} but got ${response.statusCode}: ${response.body}`);
    }
    console.log('  PASS');
    return response;
}

async function run() {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    otherPrivateKey = (await generateKeyPair('RS256')).privateKey;
    await startJwksServer(await exportJWK(pair.publicKey));

    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, {
        enableDatabase: true,
        databasePrefix: 'pixelci_ghtest'
    });
    await facade.start();

    await createPersistedEntity(VcsIntegrationEntity, {
        id: VCS_ID,
        name: 'GitHub Test VCS',
        platform: 'github',
        config: { clientId: 'client-id', clientSecret: 'client-secret', oidcAudience: AUDIENCE, oidcIssuer: issuer } satisfies IGitHubConfig
    });
    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'GitHub Test App',
        defaultBranchId: BRANCH_ID,
        projectPath: 'acme/app',
        vcsProjectId: REPO_ID,
        vcsId: VCS_ID
    });
    await createPersistedEntity(BranchEntity, { id: BRANCH_ID, appId: APP_ID, name: 'main' });
    await createPersistedEntity(AppEntity, {
        id: UNBOUND_APP_ID,
        name: 'GitHub Unbound App',
        defaultBranchId: UNBOUND_BRANCH_ID,
        projectPath: 'acme/unbound',
        vcsProjectId: null,
        vcsId: VCS_ID
    });
    await createPersistedEntity(BranchEntity, { id: UNBOUND_BRANCH_ID, appId: UNBOUND_APP_ID, name: 'main' });

    // Valid push token
    const pushToken = await mintToken();
    const pushRes = await expectStatus(facade, 'valid push token', pushToken, 200);
    const pushBuild = await BuildEntity.query().filter({ id: pushRes.json.id }).findOne();
    const pushBranch = await BranchEntity.query().filter({ id: pushBuild.branchId }).findOne();
    if (pushBranch.name !== 'main' || pushBuild.commitHash !== 'a'.repeat(40) || pushBuild.ciJobId !== '987654:128602857139') {
        throw new Error(`Unexpected build data: branch=${pushBranch.name} commit=${pushBuild.commitHash} job=${pushBuild.ciJobId}`);
    }

    // PR token
    const prToken = await mintToken({ claims: { event_name: 'pull_request', ref: 'refs/pull/7/merge', head_ref: 'feature/x', run_id: '987655' } });
    const prRes = await expectStatus(facade, 'valid pull request token', prToken, 200);
    const prBuild = await BuildEntity.query().filter({ id: prRes.json.id }).findOne();
    const prBranch = await BranchEntity.query().filter({ id: prBuild.branchId }).findOne();
    if (prBranch.name !== 'feature/x') throw new Error(`Expected branch feature/x but got ${prBranch.name}`);

    // Without check_run_id (older GitHub Enterprise) the job id is just the run id
    const noCheckRes = await expectStatus(
        facade,
        'token without check_run_id → ciJobId is the run id',
        await mintToken({ claims: { check_run_id: undefined, sha: 'c'.repeat(40), run_id: '987660' } }),
        200
    );
    const noCheckBuild = await BuildEntity.query().filter({ id: noCheckRes.json.id }).findOne();
    if (noCheckBuild.ciJobId !== '987660') throw new Error(`Expected ciJobId 987660 but got ${noCheckBuild.ciJobId}`);

    // Hash-based follow-up
    console.log('\nTest: follow-up status call with same token → 200');
    const statusRes = await facade.request(
        HttpRequest.GET(`/api/apps/${APP_ID}/builds/${pushRes.json.id}/status`).header('authorization', `Bearer ${pushToken}`)
    );
    if (statusRes.statusCode !== 200) throw new Error(`Expected 200 but got ${statusRes.statusCode}: ${statusRes.body}`);
    console.log('  PASS');

    // Rejections
    await expectStatus(facade, 'wrong audience', await mintToken({ aud: 'https://other.test' }), 401);
    await expectStatus(facade, 'wrong issuer', await mintToken({ iss: 'https://evil.example' }), 401);
    await expectStatus(facade, 'expired token', await mintToken({ exp: Math.floor(Date.now() / 1000) - 3600 }), 401);
    await expectStatus(facade, 'token signed with a different key', await mintToken({ key: otherPrivateKey }), 401);
    await expectStatus(facade, 'repository_id mismatch', await mintToken({ claims: { repository_id: '999' } }), 401);
    await expectStatus(
        facade,
        'unsupported ref without head_ref',
        await mintToken({ claims: { event_name: 'pull_request', ref: 'refs/pull/7/merge', head_ref: '' } }),
        401
    );
    await expectStatus(
        facade,
        'pull_request_target event (base ref/sha) rejected',
        await mintToken({ claims: { event_name: 'pull_request_target', head_ref: 'feature/x', run_id: '987656' } }),
        401
    );
    await expectStatus(facade, 'missing event_name rejected', await mintToken({ claims: { event_name: undefined } }), 401);
    const ignoredHeadRefRes = await expectStatus(
        facade,
        'head_ref ignored outside pull_request (push → refs/heads branch)',
        await mintToken({ claims: { head_ref: 'evil', sha: 'b'.repeat(40), run_id: '987657' } }),
        200
    );
    if (ignoredHeadRefRes.json.branchName !== 'main') throw new Error(`Expected branch main but got ${ignoredHeadRefRes.json.branchName}`);
    await expectStatus(facade, 'GitHub app with null vcsProjectId (fail closed)', pushToken, 401, UNBOUND_APP_ID);

    // An integration without oidcAudience must not accept tokens for any audience (jose skips aud when undefined)
    await createPersistedEntity(VcsIntegrationEntity, {
        id: VCS_NO_AUD_ID,
        name: 'GitHub No Audience',
        platform: 'github',
        config: { clientId: 'client-id', clientSecret: 'client-secret', oidcIssuer: issuer } as unknown as IGitHubConfig
    });
    await createPersistedEntity(AppEntity, {
        id: NO_AUD_APP_ID,
        name: 'GitHub No Audience App',
        defaultBranchId: NO_AUD_BRANCH_ID,
        projectPath: 'acme/app',
        vcsProjectId: REPO_ID,
        vcsId: VCS_NO_AUD_ID
    });
    await createPersistedEntity(BranchEntity, { id: NO_AUD_BRANCH_ID, appId: NO_AUD_APP_ID, name: 'main' });
    await expectStatus(facade, 'integration without oidcAudience (fail closed)', await mintToken({ aud: 'sts.amazonaws.com' }), 401, NO_AUD_APP_ID);

    await testConfigRoundtrip();

    jwksServer.close();
}

async function testConfigRoundtrip() {
    console.log('\nTest: GitHub config (with url) survives persistence roundtrip');
    await createPersistedEntity(VcsIntegrationEntity, {
        id: VCS_ROUNDTRIP_ID,
        name: 'GHES Roundtrip',
        platform: 'github',
        config: {
            url: 'https://ghe.example.com',
            clientId: 'cid',
            clientSecret: 'csecret',
            oidcAudience: AUDIENCE,
            oidcIssuer: 'https://ghe.example.com/_services/token'
        } satisfies IGitHubConfig
    });
    const loaded = await VcsIntegrationEntity.query().filter({ id: VCS_ROUNDTRIP_ID }).findOne();
    const config = loaded.config as Partial<IGitHubConfig>;
    if (config.oidcAudience !== AUDIENCE || config.oidcIssuer !== 'https://ghe.example.com/_services/token') {
        throw new Error(`GitHub-only config fields were lost on reload: ${JSON.stringify(loaded.config)}`);
    }
    console.log('  PASS');
}
