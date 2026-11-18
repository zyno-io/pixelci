import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { readdirSync, readFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { exportJWK, generateKeyPair, JWK, SignJWT } from 'jose';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { IGitHubConfig, VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { screenManifestHash } from '../../src/services/ScreenManifest';
import { sealIntegrationConfig } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase, ensureTestBucket, useIsolatedRedisPrefix } from './db-defaults';

process.env.CI = 'true';
process.env.PUBLIC_URL = 'https://pixelci.test';
process.env.GITLAB_ID_TOKEN_AUDIENCES = 'https://alt.pixelci.test';
useIsolatedRedisPrefix('gitlab-id-token');

configureTestDatabase();

const VCS_ID = 'e3234567-aaaa-bbbb-cccc-000000000001';
const GH_VCS_ID = 'e3234567-aaaa-bbbb-cccc-000000000002';
const APP_ID = 'e3234567-aaaa-bbbb-cccc-000000000010';
const BRANCH_ID = 'e3234567-aaaa-bbbb-cccc-000000000011';
const UNBOUND_APP_ID = 'e3234567-aaaa-bbbb-cccc-000000000020';
const UNBOUND_BRANCH_ID = 'e3234567-aaaa-bbbb-cccc-000000000021';
const GH_APP_ID = 'e3234567-aaaa-bbbb-cccc-000000000030';
const GH_BRANCH_ID = 'e3234567-aaaa-bbbb-cccc-000000000031';
const AUDIENCE = 'https://pixelci.test';
const PROJECT_ID = 4242;
const KID = 'gl-test-key';
const JOB_TOKEN = 'glcbt-test-job-token';
const FIXTURE = readFileSync(`${__dirname}/fixtures/${readdirSync(`${__dirname}/fixtures`).find(f => f.endsWith('.png'))}`);

let base: string;
let mockServer: Server;
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let publicJwk: JWK;
let jwksDown = false;
let jobHitCount = 0;

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;

run()
    .then(() => {
        console.log('\nAll GitLab ID token tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

function startMockGitLab(): Promise<void> {
    mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.url === '/oauth/discovery/keys') {
            if (jwksDown) {
                res.writeHead(500);
                res.end('boom');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] }));
            return;
        }
        if (req.url === '/api/v4/job') {
            jobHitCount++;
            if (req.headers['job-token'] !== JOB_TOKEN) {
                res.writeHead(401);
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    id: 77,
                    ref: 'main',
                    pipeline: { project_id: PROJECT_ID, sha: 'f'.repeat(40) },
                    commit: { title: 'job token commit', author_name: 'Job Author' }
                })
            );
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise(resolve =>
        mockServer.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}`;
            resolve();
        })
    );
}

interface ITokenOpts {
    claims?: Record<string, unknown>;
    aud?: string;
    iss?: string;
    exp?: string | number;
    key?: CryptoKey;
    alg?: string;
}

let jobCounter = 1000;
async function mintToken(opts: ITokenOpts = {}): Promise<string> {
    const claims = {
        namespace_id: '1',
        project_id: String(PROJECT_ID),
        project_path: 'group/app',
        user_login: 'ann',
        ref: 'main',
        ref_type: 'branch',
        sha: 'a'.repeat(40),
        job_id: String(++jobCounter),
        pipeline_id: '5',
        ...opts.claims
    };
    return new SignJWT(claims)
        .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: KID })
        .setIssuer(opts.iss ?? base)
        .setAudience(opts.aud ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '5m')
        .sign(opts.key ?? privateKey);
}

const auth = (r: HttpRequest, token: string) => r.header('authorization', `Bearer ${token}`);
const create = (f: Facade, token: string, body: Record<string, unknown> = {}, appId = APP_ID) =>
    f.request(auth(HttpRequest.POST(`/api/apps/${appId}/builds`), token).json(body));

async function expectStatus(f: Facade, name: string, token: string, expected: number, body: Record<string, unknown> = {}, appId = APP_ID) {
    console.log(`\nTest: ${name} → ${expected}`);
    const response = await create(f, token, body, appId);
    if (response.statusCode !== expected) throw new Error(`Expected ${expected} but got ${response.statusCode}: ${response.body}`);
    console.log('  PASS');
    return response;
}

function assert(cond: unknown, message: string): asserts cond {
    if (!cond) throw new Error(message);
}

async function seed(prefix: string): Promise<Facade> {
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, { enableDatabase: true, databasePrefix: prefix });
    await ensureTestBucket();
    await facade.start();

    await createPersistedEntity(VcsIntegrationEntity, {
        id: VCS_ID,
        name: 'GitLab ID Token VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({ url: base, clientId: 'client-id', clientSecret: 'client-secret' })
    });
    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'GitLab ID Token App',
        defaultBranchId: BRANCH_ID,
        projectPath: 'group/app',
        vcsProjectId: PROJECT_ID,
        vcsId: VCS_ID
    });
    await createPersistedEntity(BranchEntity, { id: BRANCH_ID, appId: APP_ID, name: 'main' });
    await createPersistedEntity(AppEntity, {
        id: UNBOUND_APP_ID,
        name: 'GitLab Unbound App',
        defaultBranchId: UNBOUND_BRANCH_ID,
        projectPath: 'group/unbound',
        vcsProjectId: null,
        vcsId: VCS_ID
    });
    await createPersistedEntity(BranchEntity, { id: UNBOUND_BRANCH_ID, appId: UNBOUND_APP_ID, name: 'main' });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: GH_VCS_ID,
        name: 'GitHub VCS',
        platform: 'github',
        config: sealIntegrationConfig({
            clientId: 'client-id',
            clientSecret: 'client-secret',
            oidcAudience: AUDIENCE,
            oidcIssuer: 'https://token.actions.githubusercontent.com'
        } satisfies IGitHubConfig)
    });
    await createPersistedEntity(AppEntity, {
        id: GH_APP_ID,
        name: 'GitHub App',
        defaultBranchId: GH_BRANCH_ID,
        projectPath: 'acme/app',
        vcsProjectId: PROJECT_ID,
        vcsId: GH_VCS_ID
    });
    await createPersistedEntity(BranchEntity, { id: GH_BRANCH_ID, appId: GH_APP_ID, name: 'main' });
    return facade;
}

async function run() {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    otherPrivateKey = (await generateKeyPair('RS256')).privateKey;
    publicJwk = await exportJWK(pair.publicKey);
    await startMockGitLab();

    const facade = await seed('pixelci_glidtest');

    // Before any successful JWKS fetch, so nothing is cached
    jwksDown = true;
    await expectStatus(facade, 'JWKS endpoint down → retryable', await mintToken(), 503);
    jwksDown = false;

    // Valid token with display-only commit hints
    const sha = 'b'.repeat(40);
    const validToken = await mintToken({ claims: { sha, job_id: '555', ref: 'feature/x' } });
    const manifest = { count: 1, hash: screenManifestHash(['home']) };
    const validRes = await expectStatus(facade, 'valid ID token', validToken, 200, {
        screens: manifest,
        commit: { subject: 'Fix the thing\nlong body', author: 'Ann Dev' }
    });
    const build = await BuildEntity.query().filter({ id: validRes.json.id }).findOne();
    const branch = await BranchEntity.query().filter({ id: build.branchId }).findOne();
    assert(
        branch.name === 'feature/x' && build.commitHash === sha && build.ciJobId === '555',
        `Unexpected build: ${branch.name} ${build.commitHash} ${build.ciJobId}`
    );
    assert(
        build.commitSubject === 'Fix the thing' && build.commitAuthor === 'Ann Dev',
        `Unexpected commit: ${build.commitSubject} / ${build.commitAuthor}`
    );

    // Without hints: empty subject, author from user_login
    const bareRes = await expectStatus(facade, 'valid ID token without hints', await mintToken({ claims: { sha: 'c'.repeat(40) } }), 200);
    const bare = await BuildEntity.query().filter({ id: bareRes.json.id }).findOne();
    assert(bare.commitSubject === '' && bare.commitAuthor === 'ann', `Unexpected fallback: "${bare.commitSubject}" / "${bare.commitAuthor}"`);

    // Follow-up calls use the same token
    console.log('\nTest: status, upload and process with the same ID token → 200');
    const statusRes = await f_get(facade, `/api/apps/${APP_ID}/builds/${validRes.json.id}/status`, validToken);
    assert(statusRes.statusCode === 200, `status ${statusRes.statusCode}: ${statusRes.body}`);
    const uploadRes = await facade.request(
        auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${validRes.json.id}/screens`), validToken).multiPart([
            { name: 'image', file: FIXTURE, fileName: 'home.png' }
        ])
    );
    assert(uploadRes.statusCode === 200, `upload ${uploadRes.statusCode}: ${uploadRes.body}`);
    const processRes = await facade.request(
        auth(HttpRequest.POST(`/api/apps/${APP_ID}/builds/${validRes.json.id}/process`), validToken).json({ screens: manifest })
    );
    assert(processRes.statusCode === 200, `process ${processRes.statusCode}: ${processRes.body}`);
    const wrong = await f_get(facade, `/api/apps/${APP_ID}/builds/${validRes.json.id}/status`, await mintToken());
    assert(wrong.statusCode === 401, `another job's token should be 401, got ${wrong.statusCode}`);
    console.log('  PASS');

    // Audiences
    await expectStatus(facade, 'aud with a trailing slash', await mintToken({ aud: `${AUDIENCE}/` }), 200);
    await expectStatus(facade, 'extra configured audience', await mintToken({ aud: 'https://alt.pixelci.test' }), 200);
    await expectStatus(facade, 'wrong audience', await mintToken({ aud: 'https://other.test' }), 401);

    // Bad tokens
    await expectStatus(facade, 'wrong issuer', await mintToken({ iss: 'https://evil.example' }), 401);
    await expectStatus(facade, 'expired token', await mintToken({ exp: Math.floor(Date.now() / 1000) - 3600 }), 401);
    await expectStatus(facade, 'token signed with a different key', await mintToken({ key: otherPrivateKey }), 401);
    await expectStatus(facade, 'project_id mismatch', await mintToken({ claims: { project_id: '999' } }), 401);
    await expectStatus(facade, 'app with null vcsProjectId (fail closed)', await mintToken(), 401, {}, UNBOUND_APP_ID);
    await expectStatus(facade, 'missing project_id', await mintToken({ claims: { project_id: undefined } }), 401);
    await expectStatus(facade, 'non-numeric job_id', await mintToken({ claims: { job_id: 'abc' } }), 401);
    await expectStatus(facade, 'missing ref', await mintToken({ claims: { ref: '' } }), 401);
    await expectStatus(facade, 'bad sha', await mintToken({ claims: { sha: 'XYZ' } }), 401);
    await expectStatus(facade, 'GitLab token sent to a GitHub app', await mintToken(), 401, {}, GH_APP_ID);
    await expectStatus(facade, 'malformed commit hints', await mintToken(), 400, { commit: { subject: 5 } });
    await expectStatus(facade, 'oversized commit author', await mintToken(), 400, { commit: { author: 'x'.repeat(513) } });

    // Job tokens still work by default
    await expectStatus(facade, 'job token (switch on by default)', JOB_TOKEN, 200);
    assert(jobHitCount === 1, `Expected one job-endpoint hit so far, got ${jobHitCount}`);
    await expectStatus(facade, 'job token that GitLab rejects', 'glcbt-wrong', 401);
    jobHitCount = 0;

    await facade.stop();

    // GITLAB_JOB_TOKEN_AUTH_ENABLED=false
    process.env.GITLAB_JOB_TOKEN_AUTH_ENABLED = 'false';
    const off = await seed('pixelci_glidoff');
    jobHitCount = 0;
    console.log('\nTest: job-token auth disabled → job token 401 with a message, GitLab never called');
    const offRes = await create(off, JOB_TOKEN);
    assert(offRes.statusCode === 401, `Expected 401 but got ${offRes.statusCode}: ${offRes.body}`);
    assert(/id_tokens: PIXELCI_ID_TOKEN/.test(String(offRes.body)), `Expected the guidance message, got ${offRes.body}`);
    console.log('  PASS');
    await expectStatus(off, 'job-token auth disabled → ID token still works', await mintToken(), 200);
    assert(jobHitCount === 0, `GitLab /api/v4/job was hit ${jobHitCount} time(s) with job-token auth off`);
    await off.stop();

    mockServer.close();
}

function f_get(f: Facade, path: string, token: string) {
    return f.request(auth(HttpRequest.GET(path), token));
}
