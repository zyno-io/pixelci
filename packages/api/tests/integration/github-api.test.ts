import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, ScopedLogger, TestingHelpers, WorkerService } from '@zyno-io/ts-server-foundation';
import { generateKeyPairSync } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { exportJWK, generateKeyPair, importSPKI, jwtVerify, SignJWT } from 'jose';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { BuildEntity } from '../../src/entities/Build.entity';
import { IUserVcsSession, UserEntity } from '../../src/entities/User.entity';
import { IGitHubConfig, VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { RerunCiJobJob, RERUN_RETRY_DELAY_MS } from '../../src/jobs/RerunCiJob.job';
import { AppAccessService } from '../../src/services/AppAccess.service';
import { SEALED_PREFIX } from '../../src/services/secrets/SecretBox';
import { openVcsSession } from '../../src/services/secrets/VcsSecrets';
import { VcsGitHubService } from '../../src/services/VcsGitHub.service';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
const SETUP_TOKEN = 'gh-api-setup-token-0123456789';
process.env.SETUP_TOKEN = SETUP_TOKEN;
process.env.REDIS_PREFIX = 'pixelci_test';

configureTestDatabase();

// ---------------------------------------------------------------- constants

const GH_VCS_ID = 'e3234567-aaaa-bbbb-cccc-000000000001';
const NOAPP_VCS_ID = 'e3234567-aaaa-bbbb-cccc-000000000002';
const GITLAB_VCS_ID = 'e3234567-aaaa-bbbb-cccc-000000000003';

const USER_B_ID = 'e3234567-aaaa-bbbb-cccc-0000000000b1';
const USER_C_ID = 'e3234567-aaaa-bbbb-cccc-0000000000c1';
const USER_D_ID = 'e3234567-aaaa-bbbb-cccc-0000000000d1';

const AUDIENCE = 'https://pixelci.test';
const APP_ID = '4321';
const KID = 'gh-test-key';
const API = '/api/v3';

// Above INT max (2^31-1) to prove the BIGINT column
const REPO_ID = 3000000001;
const REPO2_ID = 3000000002;
const REPO3_ID = 3000000003;
const MOVED_ID = 3000000004;
const CREATED_ID = 3000000005;
const NOPUSH_ID = 3000000006;
const GONE_ID = 3000000007;
const HIDDEN_ID = 3000000099;
const ACCESSIBLE_IDS = new Set([REPO_ID, REPO2_ID, REPO3_ID, MOVED_ID, NOPUSH_ID]);

const PUSH_SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);
const BASE_SHA = 'c'.repeat(40);
const HEAD_SHA = 'd'.repeat(40);
const FAIL_SHA = 'e'.repeat(40);
const MERGE_404_SHA = '1'.repeat(40);
const MERGE_1PARENT_SHA = '2'.repeat(40);

const INSTALL_TOKEN_PREFIX = 'ghs_install_';

// ------------------------------------------------------------------ mock state

interface ILogEntry {
    method: string;
    path: string;
    query: URLSearchParams;
    auth: string;
}

const log: ILogEntry[] = [];
const violations: string[] = [];
let base: string;
let mockServer: Server;
let appPublicKey: CryptoKey;
let oidcPrivateKey: CryptoKey;

let refreshCalls = 0;
/** Every refresh_token grant request, including rejected duplicates (proves coalescing). */
let refreshRequests = 0;
let refreshCounter = 0;
let validRefreshToken = 'ghr_initial';
/** When a refresh request carries this token, run the hook (which rotates the token in the DB) and answer bad_refresh_token. */
let adoptHook: { token: string; run: () => Promise<void> } | null = null;
let accessTokensCalls = 0;

const count = (method: string, re: RegExp) => log.filter(e => e.method === method && re.test(e.path)).length;

// ------------------------------------------------------------------ mock helpers

function bulkRepos() {
    return Array.from({ length: 101 }, (_, i) => ({
        id: 2000000000 + i,
        name: `bulk-${i}`,
        full_name: `acme/bulk-${i}`,
        html_url: `${base}/acme/bulk-${i}`,
        description: null,
        default_branch: 'main',
        pushed_at: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString()
    }));
}

function otherRepos() {
    return [
        {
            id: REPO_ID,
            name: 'app',
            full_name: 'acme/app',
            html_url: `${base}/acme/app`,
            description: 'The app',
            default_branch: 'main',
            pushed_at: '2027-01-01T00:00:00Z'
        },
        {
            id: 2100000000,
            name: 'zeta',
            full_name: 'acme/zeta',
            html_url: `${base}/acme/zeta`,
            description: '',
            default_branch: 'dev',
            pushed_at: '2025-01-01T00:00:00Z'
        }
    ];
}

/** Per-token push permission on REPO_ID (`permissions.push` on /repositories/:id); tokens not listed get push:true. */
const REPO_PUSH_BY_AUTH: Record<string, boolean> = { 'Bearer ghu_B_new': false };

function repoJson(id: number, fullName: string, push = true) {
    const [, name] = fullName.split('/');
    return {
        id,
        name,
        full_name: fullName,
        html_url: `${base}/${fullName}`,
        description: 'd',
        default_branch: 'main',
        permissions: { push }
    };
}

function commitJson(sha: string, message: string, author: string, parents: string[] = []) {
    return { sha, parents: parents.map(p => ({ sha: p })), commit: { message, author: { name: author } } };
}

const COMMITS: Record<string, unknown> = {
    [PUSH_SHA]: commitJson(PUSH_SHA, 'Add widget\n\nLong body', 'Alice Author', ['0'.repeat(40)]),
    [MERGE_SHA]: commitJson(MERGE_SHA, 'Merge dddd into cccc', 'GitHub', [BASE_SHA, HEAD_SHA]),
    [HEAD_SHA]: commitJson(HEAD_SHA, 'PR head subject\n\nbody', 'Pat PR', [BASE_SHA]),
    [MERGE_1PARENT_SHA]: commitJson(MERGE_1PARENT_SHA, 'Odd merge', 'GitHub', [BASE_SHA])
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
}

async function verifyAppJwt(auth: string): Promise<boolean> {
    if (!auth.startsWith('Bearer ')) return false;
    try {
        const { payload } = await jwtVerify(auth.slice(7), appPublicKey, { issuer: APP_ID, algorithms: ['RS256'] });
        if (!payload.exp || !payload.iat || payload.exp - payload.iat > 600)
            violations.push(`App JWT lifetime too long: exp=${payload.exp} iat=${payload.iat}`);
        if (payload.iat! > Math.floor(Date.now() / 1000)) violations.push('App JWT iat is in the future');
        return true;
    } catch (err) {
        violations.push(`App JWT failed verification: ${err}`);
        return false;
    }
}

const isUserAuth = (auth: string) => /^Bearer (ghu_|ghp_valid$)/.test(auth);
const isInstallAuth = (auth: string) => auth.startsWith(`Bearer ${INSTALL_TOKEN_PREFIX}`);

async function handleOAuth(req: IncomingMessage, res: ServerResponse) {
    const raw = await readBody(req);
    const form = new URLSearchParams(raw);
    if (req.headers.accept !== 'application/json') violations.push('oauth token request missing Accept: application/json');
    if (form.get('client_id') !== 'gh-client' || form.get('client_secret') !== 'gh-secret')
        violations.push(`oauth token request bad client creds: ${raw}`);

    if (form.get('grant_type') === 'refresh_token') {
        refreshRequests++;
        const token = form.get('refresh_token');
        if (adoptHook && token === adoptHook.token) {
            const hook = adoptHook;
            adoptHook = null;
            await hook.run();
            return json(res, 200, { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
        }
        await new Promise(r => setTimeout(r, 100));
        if (token !== validRefreshToken) {
            return json(res, 200, { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
        }
        refreshCalls++;
        refreshCounter++;
        validRefreshToken = `ghr_rot${refreshCounter}`;
        return json(res, 200, {
            access_token: `ghu_rot${refreshCounter}`,
            expires_in: 28800,
            refresh_token: validRefreshToken,
            token_type: 'bearer'
        });
    }

    if (form.get('redirect_uri') !== 'https://pixelci.test/login') violations.push(`oauth code exchange bad redirect_uri: ${raw}`);
    switch (form.get('code')) {
        case 'good':
            return json(res, 200, { access_token: 'ghu_login', expires_in: 28800, refresh_token: 'ghr_initial', token_type: 'bearer' });
        case 'noinst':
            return json(res, 200, { access_token: 'ghu_noinst', expires_in: 28800, refresh_token: 'ghr_noinst', token_type: 'bearer' });
        case 'forever':
            return json(res, 200, { access_token: 'ghu_forever', token_type: 'bearer' });
        default:
            // GitHub reports OAuth errors as HTTP 200
            return json(res, 200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
    }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    const auth = String(req.headers.authorization ?? '');
    if (req.headers.accept !== 'application/vnd.github+json') violations.push(`${req.method} ${path}: bad Accept ${req.headers.accept}`);
    if (req.headers['x-github-api-version'] !== '2022-11-28') violations.push(`${req.method} ${path}: bad X-GitHub-Api-Version`);
    if (req.headers['user-agent'] !== 'PixelCI') violations.push(`${req.method} ${path}: bad User-Agent ${req.headers['user-agent']}`);
    const method = req.method!;
    const rest = path.slice(API.length);
    let m: RegExpExecArray | null;

    if (rest === '/user' && method === 'GET') {
        if (!isUserAuth(auth)) return json(res, 401, { message: 'Bad credentials' });
        return json(res, 200, { id: 4242, login: 'octo', name: null });
    }

    if (rest === '/user/installations' && method === 'GET') {
        if (!isUserAuth(auth)) return json(res, 401, { message: 'Bad credentials' });
        if (auth === 'Bearer ghu_noinst') return json(res, 200, { total_count: 0, installations: [] });
        const all = [{ id: 77 }, { id: 88 }];
        return json(res, 200, { total_count: all.length, installations: all.slice(0, Number(query.get('per_page') ?? 30)) });
    }

    if ((m = /^\/user\/installations\/(\d+)\/repositories$/.exec(rest)) && method === 'GET') {
        if (!isUserAuth(auth)) return json(res, 401, { message: 'Bad credentials' });
        const repos = m[1] === '77' ? bulkRepos() : otherRepos();
        const perPage = Number(query.get('per_page') ?? 30);
        const page = Number(query.get('page') ?? 1);
        return json(res, 200, { total_count: repos.length, repositories: repos.slice((page - 1) * perPage, page * perPage) });
    }

    if ((m = /^\/repositories\/(\d+)$/.exec(rest)) && method === 'GET') {
        if (!isUserAuth(auth)) return json(res, 401, { message: 'Bad credentials' });
        const id = Number(m[1]);
        if (id === MOVED_ID) return json(res, 200, repoJson(id, 'acme/renamed'));
        if (id === NOPUSH_ID) return json(res, 200, repoJson(id, 'acme/readonly', false));
        if (id === REPO_ID) return json(res, 200, repoJson(id, 'acme/app', REPO_PUSH_BY_AUTH[auth] ?? true));
        if (ACCESSIBLE_IDS.has(id)) return json(res, 200, repoJson(id, `acme/r${id}`));
        return json(res, 404, { message: 'Not Found' });
    }

    if (rest === '/repos/acme/app' && method === 'GET') return isUserAuth(auth) ? json(res, 200, repoJson(REPO_ID, 'acme/app')) : json(res, 401, {});
    if (rest === '/repos/acme/notinstalled' && method === 'GET') return json(res, 200, repoJson(HIDDEN_ID, 'acme/notinstalled'));

    if ((m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(rest)) && method === 'GET') {
        if (!(await verifyAppJwt(auth))) return json(res, 401, { message: 'A JSON web token could not be decoded' });
        if (m[1] === 'acme/app') return json(res, 200, { id: 77 });
        return json(res, 404, { message: 'Not Found' });
    }

    if (rest === '/app/installations/77/access_tokens' && method === 'POST') {
        if (!(await verifyAppJwt(auth))) return json(res, 401, { message: 'A JSON web token could not be decoded' });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (JSON.stringify(body.repository_ids) !== JSON.stringify([REPO_ID]))
            violations.push(`access_tokens bad repository_ids: ${JSON.stringify(body)}`);
        // Only least-privilege scopes: contents:read (commits) or pull_requests:read (PR head fallback), never both/write.
        const perms = JSON.stringify(body.permissions);
        if (perms !== JSON.stringify({ contents: 'read' }) && perms !== JSON.stringify({ pull_requests: 'read' }))
            violations.push(`access_tokens bad permissions: ${JSON.stringify(body)}`);
        accessTokensCalls++;
        return json(res, 201, { token: `${INSTALL_TOKEN_PREFIX}${accessTokensCalls}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }

    if ((m = /^\/repos\/acme\/app\/commits\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
        if (!isInstallAuth(auth)) return json(res, 401, { message: 'Bad credentials' });
        if (m[1] === FAIL_SHA) return json(res, 500, { message: 'boom' });
        const commit = COMMITS[m[1]];
        return commit ? json(res, 200, commit) : json(res, 404, { message: 'No commit found for SHA' });
    }

    if ((m = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(rest)) && method === 'GET') {
        if (!isInstallAuth(auth)) return json(res, 401, { message: 'Bad credentials' });
        return json(res, 200, { number: Number(m[1]), head: { sha: HEAD_SHA } });
    }

    if ((m = /^\/repos\/(acme\/[^/]+)\/actions\/jobs\/(\d+)\/rerun$/.exec(rest)) && method === 'POST') {
        if (!isUserAuth(auth)) return json(res, 401, { message: 'Bad credentials' });
        if (m[2].startsWith('86')) return json(res, 403, { message: 'Resource not accessible by integration' });
        // jobs starting 88/89 belong to a run that GitHub reports as already running
        if (/^8[89]/.test(m[2])) return json(res, 403, { message: 'This workflow is already running' });
        // jobs ending in 3 are forbidden
        if (m[2].endsWith('3')) return json(res, 403, { message: 'Resource not accessible by integration' });
        return json(res, 201, {});
    }

    if ((m = /^\/repos\/(acme\/[^/]+)\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(rest)) && method === 'POST') {
        if (!isUserAuth(auth)) return json(res, 401, { message: 'Bad credentials' });
        if (m[2].startsWith('86')) return json(res, 403, { message: 'Resource not accessible by integration' });
        if (/^8[89]/.test(m[2])) return json(res, 403, { message: 'This workflow is already running' });
        if (m[2].startsWith('9')) return json(res, 403, { message: 'Workflow run cannot be rerun: it was created more than a month ago.' });
        return json(res, 201, {});
    }

    if ((m = /^\/repos\/(acme\/[^/]+)\/actions\/runs\/(\d+)$/.exec(rest)) && method === 'GET') {
        if (!isUserAuth(auth)) return json(res, 401, { message: 'Bad credentials' });
        const failures = runGetFailures.get(m[2]) ?? 0;
        if (failures > 0) {
            runGetFailures.set(m[2], failures - 1);
            return json(res, 500, { message: 'boom' });
        }
        // runs starting 88 or 86 are still in progress; everything else has completed
        return json(res, 200, {
            id: Number(m[2]),
            status: /^8[68]/.test(m[2]) ? 'in_progress' : 'completed',
            run_attempt: runAttempts.get(m[2]) ?? 1
        });
    }

    return json(res, 404, { message: `Not Found (mock): ${method} ${path}` });
}

/** Test controls for GET /actions/runs/{id}: advance run_attempt, or fail the next N lookups with a 500. */
const runAttempts = new Map<string, number>();
const runGetFailures = new Map<string, number>();

function startMock(): Promise<void> {
    return new Promise(resolve => {
        mockServer = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://x');
            log.push({ method: req.method!, path: url.pathname, query: url.searchParams, auth: String(req.headers.authorization ?? '') });
            const done = (err: unknown) => {
                violations.push(`mock handler error: ${err}`);
                if (!res.headersSent) json(res, 500, { message: String(err) });
            };

            if (url.pathname === '/_services/token/.well-known/jwks') {
                exportJWK(oidcPublicKey).then(jwk => json(res, 200, { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }), done);
                return;
            }
            if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
                handleOAuth(req, res).catch(done);
                return;
            }
            if (url.pathname.startsWith(`${API}/`)) {
                handleApi(req, res, url.pathname, url.searchParams).catch(done);
                return;
            }
            json(res, 404, { message: 'Not found' });
        });
        mockServer.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${(mockServer.address() as { port: number }).port}`;
            resolve();
        });
    });
}

let oidcPublicKey: CryptoKey;

// ------------------------------------------------------------------ test helpers

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;
type Res = { statusCode: number; body: Buffer | string; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

function status(res: Res, expected: number, what: string) {
    if (res.statusCode !== expected) throw new Error(`${what}: expected ${expected} but got ${res.statusCode}: ${res.body}`);
}

function test(name: string) {
    console.log(`\nTest: ${name}`);
}

async function get(facade: Facade, path: string, jwt?: string): Promise<Res> {
    const req = HttpRequest.GET(path);
    if (jwt) req.header('authorization', `Bearer ${jwt}`);
    return facade.request(req) as Promise<Res>;
}

async function send(facade: Facade, method: 'POST' | 'PUT', path: string, body: unknown, jwt?: string): Promise<Res> {
    const req = HttpRequest[method](path).json(body as object);
    if (jwt) req.header('authorization', `Bearer ${jwt}`);
    return facade.request(req) as Promise<Res>;
}

async function mintOidc(opts: { claims?: Record<string, unknown> } = {}): Promise<string> {
    const claims = {
        repository: 'acme/app',
        repository_id: String(REPO_ID),
        ref: 'refs/heads/main',
        head_ref: '',
        sha: PUSH_SHA,
        run_id: '5000',
        check_run_id: '9000',
        run_attempt: '1',
        actor: 'octocat',
        event_name: 'push',
        ...opts.claims
    };
    return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`${base}/_services/token`)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(oidcPrivateKey);
}

async function createBuild(facade: Facade, appId: string, claims: Record<string, unknown>): Promise<Res> {
    const token = await mintOidc({ claims });
    return facade.request(HttpRequest.POST(`/api/apps/${appId}/builds`).header('authorization', `Bearer ${token}`)) as Promise<Res>;
}

async function createApp(id: string, name: string, vcsProjectId: number, projectPath: string, vcsId = GH_VCS_ID) {
    await createPersistedEntity(AppEntity, { id, name, defaultBranchId: `${id}-b`.slice(0, 36), projectPath, vcsProjectId, vcsId });
    await createPersistedEntity(BranchEntity, { id: `${id}-b`.slice(0, 36), appId: id, name: 'main' });
}

const appUuid = (n: number) => `e3234567-aaaa-bbbb-cccc-0000000001${String(n).padStart(2, '0')}`;
const APP1 = appUuid(1);
const APP2 = appUuid(2);
const APP3 = appUuid(3);
const APP_HIDDEN = appUuid(4);
const APP_MOVED = appUuid(5);
const APP_NOPUSH = appUuid(6);
const APP_NOAPP = appUuid(7);

async function setSession(userId: string, session: IUserVcsSession) {
    await UserEntity.query().filter({ id: userId }).patchMany({ vcsSession: session });
}

const stubLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as ScopedLogger;

// ------------------------------------------------------------------ run

run()
    .then(() => {
        console.log('\nAll GitHub API tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

async function run() {
    const oidcPair = await generateKeyPair('RS256');
    oidcPrivateKey = oidcPair.privateKey;
    oidcPublicKey = oidcPair.publicKey;

    // GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY") keys
    const appKeys = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    assert(appKeys.privateKey.includes('BEGIN RSA PRIVATE KEY'), 'test key must be PKCS#1');
    appPublicKey = await importSPKI(appKeys.publicKey, 'RS256');

    await startMock();

    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, { enableDatabase: true, databasePrefix: 'pixelci_ghapi' });
    await facade.start();

    // Enterprise-style integration: API at {url}/api/v3, OIDC issuer at {url}/_services/token (derived)
    const ghConfig: IGitHubConfig = {
        url: base,
        clientId: 'gh-client',
        clientSecret: 'gh-secret',
        appId: APP_ID,
        privateKey: appKeys.privateKey,
        oidcAudience: `${AUDIENCE}/` // stored with a trailing slash on purpose: must be normalized
    };
    await createPersistedEntity(VcsIntegrationEntity, { id: GH_VCS_ID, name: 'GH API Test', platform: 'github', config: ghConfig });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: NOAPP_VCS_ID,
        name: 'GH No App',
        platform: 'github',
        config: { url: base, clientId: 'gh-client', clientSecret: 'gh-secret', oidcAudience: AUDIENCE } satisfies IGitHubConfig
    });
    await createPersistedEntity(VcsIntegrationEntity, {
        id: GITLAB_VCS_ID,
        name: 'GL Other',
        platform: 'gitlab',
        config: { url: 'http://127.0.0.1:1', clientId: 'x', clientSecret: 'y' }
    });

    // 1. providers response
    test('providers response has exactly {id, name, platform} and no secrets');
    {
        const res = await get(facade, '/api/session/providers');
        status(res, 200, 'providers');
        const items = res.json as Record<string, unknown>[];
        assert(items.length === 3, `expected 3 providers, got ${res.body}`);
        for (const item of items)
            assert(Object.keys(item).sort().join(',') === 'id,name,platform', `unexpected provider keys: ${JSON.stringify(item)}`);
        assert(!String(res.body).includes('PRIVATE KEY') && !String(res.body).includes('gh-secret'), 'providers leak secrets');
    }

    // 2. login
    test('login URL shape and encoding');
    {
        const redirect = 'https://pixelci.test/login?x=1&y=a b';
        const res = await get(
            facade,
            `/api/session/providers/${GH_VCS_ID}/login-url?redirectUri=${encodeURIComponent(redirect)}&state=${encodeURIComponent('s t&a=te')}`
        );
        status(res, 200, 'login-url');
        const url = new URL(res.json.url);
        assert(`${url.origin}${url.pathname}` === `${base}/login/oauth/authorize`, `bad authorize url ${res.json.url}`);
        assert(url.searchParams.get('client_id') === 'gh-client', 'client_id');
        assert(url.searchParams.get('redirect_uri') === redirect, `redirect_uri round trip: ${url.searchParams.get('redirect_uri')}`);
        assert(url.searchParams.get('state') === 's t&a=te', 'state round trip');
        assert(!url.searchParams.has('scope'), 'no scope expected');
    }

    const login = (code: string, setupToken?: string) =>
        send(facade, 'POST', '/api/session/login', { providerId: GH_VCS_ID, redirectUri: 'https://pixelci.test/login', code, setupToken });

    test('login without the setup token on a fresh install → user created, NOT admin; wrong token likewise');
    {
        for (const token of [undefined, 'wrong-token']) {
            const res = await login('good', token);
            status(res, 200, 'login without token');
            const user = await UserEntity.query().filter({ vcsId: GH_VCS_ID, vcsUserId: '4242' }).findOne();
            assert(user.isAdmin === false, `user must not be admin without the setup token (${token})`);
            await UserEntity.query().filter({ id: user.id }).deleteMany();
        }
    }

    test('login with the token while no admin exists promotes an EXISTING non-admin user; with an admin present it does not');
    {
        const adminless = await UserEntity.query().filter({ vcsId: GH_VCS_ID, vcsUserId: '4242' }).findOneOrUndefined();
        assert(!adminless, 'precondition: no user yet');
        await createPersistedEntity(UserEntity, {
            id: '00000000-0000-0000-0000-0000000000e1',
            name: 'Existing',
            createdAt: new Date(),
            lastLoginAt: new Date(),
            isAdmin: false,
            vcsId: GH_VCS_ID,
            vcsUserId: '4242'
        });
        const st = (await get(facade, '/api/session/onboarding-status')).json;
        assert(st.hasAdmin === false, 'hasAdmin should be false');
        status(await login('good', SETUP_TOKEN), 200, 'existing promoted');
        let u = await UserEntity.query().filter({ vcsId: GH_VCS_ID, vcsUserId: '4242' }).findOne();
        assert(u.isAdmin === true, 'existing non-admin should be promoted while no admin exists');
        const st2 = (await get(facade, '/api/session/onboarding-status')).json;
        assert(st2.hasAdmin === true, 'hasAdmin should be true');
        // now an admin exists: a different non-admin presenting the token stays non-admin
        await UserEntity.query().filter({ id: '00000000-0000-0000-0000-0000000000e1' }).patchMany({ isAdmin: false });
        await createPersistedEntity(UserEntity, {
            id: '00000000-0000-0000-0000-0000000000e2',
            name: 'Admin',
            createdAt: new Date(),
            lastLoginAt: new Date(),
            isAdmin: true,
            vcsId: GH_VCS_ID,
            vcsUserId: 'someone-else'
        });
        status(await login('good', SETUP_TOKEN), 200, 'no promotion');
        u = await UserEntity.query().filter({ vcsId: GH_VCS_ID, vcsUserId: '4242' }).findOne();
        assert(u.isAdmin === false, 'must not be promoted while an admin exists');
        await UserEntity.query().filter({ id: '00000000-0000-0000-0000-0000000000e2' }).deleteMany();
        await UserEntity.query().filter({ id: '00000000-0000-0000-0000-0000000000e1' }).deleteMany();
    }

    test('login with a good code + setup token → JWT, user created as admin, name falls back to login');
    let userId: string;
    let userJwt: string;
    {
        const res = await login('good', SETUP_TOKEN);
        status(res, 200, 'login');
        userJwt = res.json.jwt;
        const user = await UserEntity.query().filter({ vcsId: GH_VCS_ID, vcsUserId: '4242' }).findOne();
        userId = user.id;
        assert(user.name === 'octo', `name should be login, got ${user.name}`);
        assert(user.isAdmin === true, 'first user should be admin');
        const rawSession = JSON.stringify(user.vcsSession);
        assert(
            user.vcsSession?.accessToken.startsWith(SEALED_PREFIX) && !rawSession.includes('ghu_login') && !rawSession.includes('ghr_initial'),
            'session not sealed at rest'
        );
        assert(user.vcsSession, 'session missing');
        const opened = openVcsSession(user.id, user.vcsSession);
        assert(opened.accessToken === 'ghu_login' && opened.refreshToken === 'ghr_initial', 'session not stored');
        assert(user.vcsSession.expiresAt > Date.now() + 7 * 3600_000, 'expiresAt should reflect expires_in');
    }

    test('login with a bad code (HTTP 200 + error body) → 400 with description');
    {
        const res = await login('bogus');
        status(res, 400, 'bad code');
        assert(String(res.body).includes('incorrect or expired'), `expected error_description, got ${res.body}`);
    }

    test('login gate: zero installations → 403');
    {
        const res = await login('noinst');
        status(res, 403, 'gate');
        assert(String(res.body).includes('No access to any installation'), `unexpected body ${res.body}`);
    }

    test('login with a non-expiring token → expiresAt MAX_SAFE_INTEGER, no refresh token');
    {
        status(await login('forever'), 200, 'forever login');
        const user = await UserEntity.query().filter({ id: userId }).findOne();
        assert(
            user.vcsSession?.expiresAt === Number.MAX_SAFE_INTEGER && openVcsSession(user.id, user.vcsSession).refreshToken === '',
            `unexpected session ${JSON.stringify(user.vcsSession)}`
        );
    }

    // Apps for access/refresh tests
    await createApp(APP1, 'App 1', REPO_ID, 'acme/app');
    await createApp(APP2, 'App 2', REPO2_ID, 'acme/r2');
    await createApp(APP3, 'App 3', REPO3_ID, 'acme/r3');
    await createApp(APP_HIDDEN, 'Hidden App', HIDDEN_ID, 'acme/hidden');
    const readApp = await AppEntity.query().filter({ id: APP1 }).findOne();
    assert(readApp.vcsProjectId === REPO_ID, `BIGINT repo id round trip failed: ${readApp.vcsProjectId}`);

    test('sealed session at rest: later GitHub calls still carry the opened access token');
    {
        status(await login('good', SETUP_TOKEN), 200, 'relogin');
        const accessCaches = facade.get(AppAccessService) as unknown as { cache: Map<string, unknown>; roleCache: Map<string, unknown> };
        const clearAccessCaches = () => (accessCaches.cache.clear(), accessCaches.roleCache.clear());
        clearAccessCaches();
        const logStartSealed = log.length;
        status(await get(facade, '/api/apps', userJwt), 200, 'apps index after login');
        clearAccessCaches(); // later tests expect to observe their own VCS calls
        assert(
            log.slice(logStartSealed).some(e => e.auth === 'Bearer ghu_login'),
            'GitHub mock should receive Bearer ghu_login'
        );
    }

    // 3. refresh coalescing
    test('expired session + 4 apps → GET /api/apps triggers exactly 1 refresh');
    {
        await setSession(userId, {
            accessToken: 'ghu_stale',
            expiresAt: Date.now() - 1000,
            refreshToken: validRefreshToken,
            redirectUri: 'https://pixelci.test/login'
        });
        const before = refreshCalls;
        const requestsBefore = refreshRequests;
        const res = await get(facade, '/api/apps', userJwt);
        status(res, 200, 'apps index');
        assert(refreshCalls - before === 1, `expected exactly 1 refresh, got ${refreshCalls - before}`);
        assert(refreshRequests - requestsBefore === 1, `expected exactly 1 refresh request (coalesced), got ${refreshRequests - requestsBefore}`);
        assert(res.json.length === 3, `expected 3 accessible apps, got ${res.body}`);
        const user = await UserEntity.query().filter({ id: userId }).findOne();
        assert(user.vcsSession?.accessToken.startsWith(SEALED_PREFIX), 'rotated session must be stored sealed');
        assert(user.vcsSession, 'session missing');
        const openedRot = openVcsSession(user.id, user.vcsSession);
        assert(openedRot.accessToken === `ghu_rot${refreshCounter}` && openedRot.refreshToken === validRefreshToken, 'rotated session not saved');
    }

    test('refresh adopt path: bad_refresh_token but the DB already has a fresh session → still 200');
    {
        await createPersistedEntity(UserEntity, {
            id: USER_B_ID,
            name: 'User B',
            createdAt: new Date(),
            lastLoginAt: new Date(),
            isAdmin: false,
            vcsId: GH_VCS_ID,
            vcsUserId: '5555'
        });
        await setSession(USER_B_ID, {
            accessToken: 'ghu_B_old',
            expiresAt: Date.now() - 1000,
            refreshToken: 'ghr_B_old',
            redirectUri: 'https://pixelci.test/login'
        });
        adoptHook = {
            token: 'ghr_B_old',
            run: () =>
                setSession(USER_B_ID, {
                    accessToken: 'ghu_B_new',
                    expiresAt: Date.now() + 8 * 3600_000,
                    refreshToken: 'ghr_B_new',
                    redirectUri: 'https://pixelci.test/login'
                })
        };
        const logStart = log.length;
        const res = await get(facade, '/api/apps', await JWT.generate({ subject: USER_B_ID }));
        status(res, 200, 'apps (adopt)');
        assert(res.json.length === 3, `expected 3 accessible apps after adopt, got ${res.body}`);
        assert(
            log.slice(logStart).some(e => e.path === `${API}/repositories/${REPO_ID}` && e.auth === 'Bearer ghu_B_new'),
            'access check should use the adopted token'
        );
    }

    // 4. access
    test('access: index filters the 404 app; show on it → 403');
    {
        const res = await get(facade, '/api/apps', userJwt);
        assert(!(res.json as { id: string }[]).some(a => a.id === APP_HIDDEN), 'hidden app listed');
        status(await get(facade, `/api/apps/${APP_HIDDEN}`, userJwt), 403, 'show hidden');
        status(await get(facade, `/api/apps/${APP1}`, userJwt), 200, 'show accessible');
    }

    // 5. search
    test('search: filter, mapping, sort by pushed_at desc, cap 20, both pages fetched, cached');
    {
        const logStart = log.length;
        const res = await get(facade, `/api/apps/vcs-projects/search?vcsId=${GH_VCS_ID}&search=bulk`, userJwt);
        status(res, 200, 'search bulk');
        const items = res.json as { id: string; projectPath: string; name: string; webUrl: string; description: string; defaultBranch?: string }[];
        assert(items.length === 20, `expected 20 results, got ${items.length}`);
        assert(
            items[0].projectPath === 'acme/bulk-100' && items[1].projectPath === 'acme/bulk-99',
            `sort order: ${items.slice(0, 2).map(i => i.projectPath)}`
        );
        assert(
            items[0].id === '2000000100' &&
                items[0].webUrl === `${base}/acme/bulk-100` &&
                items[0].description === '' &&
                items[0].defaultBranch === 'main',
            `mapping: ${JSON.stringify(items[0])}`
        );
        const pages = log
            .slice(logStart)
            .filter(e => e.path === `${API}/user/installations/77/repositories`)
            .map(e => e.query.get('page'))
            .sort();
        assert(pages.join(',') === '1,2', `expected both pages of installation 77, got ${pages}`);

        const callsBefore = log.length;
        const app = await get(facade, `/api/apps/vcs-projects/search?vcsId=${GH_VCS_ID}&search=APP`, userJwt);
        status(app, 200, 'search app');
        assert(app.json.length === 1 && app.json[0].projectPath === 'acme/app' && app.json[0].id === String(REPO_ID), `app search: ${app.body}`);
        assert(log.length === callsBefore, 'second search should be served from the 60s cache');
    }

    test('search by a user of another integration → 400 and no request reaches GitHub');
    {
        await createPersistedEntity(UserEntity, {
            id: USER_C_ID,
            name: 'User C',
            createdAt: new Date(),
            lastLoginAt: new Date(),
            isAdmin: true,
            vcsId: GITLAB_VCS_ID,
            vcsUserId: '7'
        });
        await setSession(USER_C_ID, { accessToken: 'glpat-C', expiresAt: Date.now() + 3600_000, refreshToken: 'r', redirectUri: 'x' });
        const callsBefore = log.length;
        const res = await get(facade, `/api/apps/vcs-projects/search?vcsId=${GH_VCS_ID}&search=app`, await JWT.generate({ subject: USER_C_ID }));
        status(res, 400, 'cross-provider search');
        assert(log.length === callsBefore, 'mock must not receive any request');
    }

    test('show by a user of another integration → 403 naming the provider to sign in with');
    {
        const callsBefore = log.length;
        const res = await get(facade, `/api/apps/${APP1}`, await JWT.generate({ subject: USER_C_ID }));
        status(res, 403, 'cross-provider show');
        assert(/Sign in with GH API Test/.test(String(res.body)), `expected the provider name in the message, got ${res.body}`);
        assert(log.length === callsBefore, 'mock must not receive any request');
    }

    // 6. resolve
    test('resolve: PR URL → repo; not installed / host mismatch / malformed → 400');
    {
        const resolve = (url: string) => get(facade, `/api/apps/vcs-projects/resolve?vcsId=${GH_VCS_ID}&url=${encodeURIComponent(url)}`, userJwt);
        const ok = await resolve(`${base}/acme/app/pull/3`);
        status(ok, 200, 'resolve PR url');
        assert(ok.json.projectPath === 'acme/app' && ok.json.id === String(REPO_ID), `resolve: ${ok.body}`);
        status(await resolve(`${base}/acme/app.git`), 200, 'resolve .git url');
        const notInstalled = await resolve(`${base}/acme/notinstalled`);
        status(notInstalled, 400, 'not installed');
        assert(String(notInstalled.body).includes('not installed'), `expected not-installed message, got ${notInstalled.body}`);
        status(await resolve('https://evil.example/acme/app'), 400, 'host mismatch');
        status(await resolve('not a url'), 400, 'malformed');
        status(await resolve(`${base}/acme`), 400, 'single path segment');
        status(await resolve(`${base}/acme/secret`), 404, 'repo the user cannot see');
    }

    // 7. app create
    test('app create: GitHub requires vcsProjectId; repo id round-trips exactly');
    {
        status(
            await send(facade, 'POST', '/api/apps', { name: 'No Id', vcsId: GH_VCS_ID, projectPath: 'acme/noid' }, userJwt),
            400,
            'missing vcsProjectId'
        );
        const res = await send(
            facade,
            'POST',
            '/api/apps',
            { name: 'Created', vcsId: GH_VCS_ID, projectPath: 'acme/created', vcsProjectId: CREATED_ID, defaultBranchName: 'main' },
            userJwt
        );
        status(res, 200, 'create');
        assert(res.json.id && res.json.vcsProjectId === undefined, `create response should be the index shape, got ${JSON.stringify(res.json)}`);
        const stored = await AppEntity.query().filter({ id: res.json.id }).findOne();
        assert(stored.vcsProjectId === CREATED_ID, `stored id ${stored.vcsProjectId}`);
    }

    // 8. CI create
    test('CI create (push): subject, author, ciJobId; installation token reused');
    {
        const res = await createBuild(facade, APP1, {});
        status(res, 200, 'push build');
        const build = await BuildEntity.query().filter({ id: res.json.id }).findOne();
        assert(build.commitSubject === 'Add widget', `subject: ${build.commitSubject}`);
        assert(build.commitAuthor === 'Alice Author', `author: ${build.commitAuthor}`);
        assert(build.ciJobId === '5000:9000', `ciJobId: ${build.ciJobId}`);
        assert(accessTokensCalls === 1, `access_tokens calls: ${accessTokensCalls}`);
    }

    test('CI create (pull_request): subject/author of the PR head (parents[1]); token still reused');
    {
        const res = await createBuild(facade, APP1, {
            event_name: 'pull_request',
            ref: 'refs/pull/7/merge',
            head_ref: 'feature/x',
            sha: MERGE_SHA,
            run_id: '5001',
            check_run_id: '9001'
        });
        status(res, 200, 'PR build');
        const build = await BuildEntity.query().filter({ id: res.json.id }).findOne();
        assert(
            build.commitSubject === 'PR head subject' && build.commitAuthor === 'Pat PR',
            `PR meta: ${build.commitSubject} / ${build.commitAuthor}`
        );
        assert(count('GET', new RegExp(`/commits/${HEAD_SHA}$`)) === 1, 'parents[1] commit should be fetched');
        assert(accessTokensCalls === 1, `installation token should be reused, calls=${accessTokensCalls}`);
    }

    test('CI create (pull_request): merge commit 404 or <2 parents → falls back to pulls/{N} head sha');
    {
        for (const [sha, run] of [
            [MERGE_404_SHA, '5002'],
            [MERGE_1PARENT_SHA, '5003']
        ]) {
            const before = count('GET', /\/pulls\/9$/);
            const res = await createBuild(facade, APP1, {
                event_name: 'pull_request',
                ref: 'refs/pull/9/merge',
                head_ref: 'feature/y',
                sha,
                run_id: run,
                check_run_id: '9002'
            });
            status(res, 200, `PR fallback build (${sha[0]})`);
            const build = await BuildEntity.query().filter({ id: res.json.id }).findOne();
            assert(build.commitSubject === 'PR head subject', `fallback subject: ${build.commitSubject}`);
            assert(count('GET', /\/pulls\/9$/) === before + 1, 'pulls/{N} should be called');
        }
    }

    test('CI create: commit fetch returns 500 → still 200, subject empty, author is actor');
    {
        const res = await createBuild(facade, APP1, { sha: FAIL_SHA, run_id: '5004', check_run_id: '9004' });
        status(res, 200, '500 build');
        const build = await BuildEntity.query().filter({ id: res.json.id }).findOne();
        assert(build.commitSubject === '' && build.commitAuthor === 'octocat', `meta on failure: "${build.commitSubject}" / "${build.commitAuthor}"`);
    }

    test('CI create: integration without appId → no installation calls');
    {
        await createApp(APP_NOAPP, 'No App', REPO_ID, 'acme/app', NOAPP_VCS_ID);
        const installCalls = () => count('GET', /\/installation$/) + count('POST', /\/access_tokens$/) + count('GET', /\/commits\//);
        const before = installCalls();
        const res = await createBuild(facade, APP_NOAPP, { sha: '3'.repeat(40), run_id: '5005', check_run_id: '9005' });
        status(res, 200, 'no-app build');
        assert(installCalls() === before, 'no GitHub App calls expected without appId/privateKey');
        const build = await BuildEntity.query().filter({ id: res.json.id }).findOne();
        assert(build.commitSubject === '' && build.commitAuthor === 'octocat', 'metadata should be empty without an App');
    }

    test('CI create: token from another repository → 401 before any GitHub App call');
    {
        const installCalls = () => count('GET', /\/installation$/) + count('POST', /\/access_tokens$/) + count('GET', /\/commits\//);
        const before = installCalls();
        const res = await createBuild(facade, APP1, { repository: 'evil/other', repository_id: '424242', sha: '4'.repeat(40), run_id: '5006' });
        status(res, 401, 'foreign-repo build');
        assert(installCalls() === before, 'no GitHub App calls expected for a token bound to another repository');
    }

    // 9. approve
    const approveFlow = async (appId: string, claims: Record<string, unknown>) => {
        const created = await createBuild(facade, appId, claims);
        status(created, 200, 'create build for approve');
        await BuildEntity.query().filter({ id: created.json.id }).patchMany({ status: 'needs review' });
        const logStart = log.length;
        const res = await send(facade, 'POST', `/api/apps/${appId}/builds/${created.json.id}/approve`, {}, userJwt);
        status(res, 200, 'approve');
        const build = await BuildEntity.query().filter({ id: created.json.id }).findOne();
        return { res, build, calls: log.slice(logStart) };
    };

    test('approve: job-level re-run 201 → vcsUrl is the run URL');
    {
        const { res, build, calls } = await approveFlow(APP1, { sha: '4'.repeat(40), run_id: '5100', check_run_id: '9100' });
        assert(res.json.vcsUrl === `${base}/acme/app/actions/runs/5100`, `vcsUrl: ${JSON.stringify(res.json)}`);
        assert(build.status === 'changes approved', `status: ${build.status}`);
        assert(
            calls.some(c => c.method === 'POST' && c.path === `${API}/repos/acme/app/actions/jobs/9100/rerun`),
            'job-level rerun not called'
        );
        assert(!calls.some(c => c.path.endsWith('/rerun-failed-jobs')), 'run-level rerun should not be needed');
    }

    test('approve: job 403 → run-level fallback 201');
    {
        const { res, calls } = await approveFlow(APP1, { sha: '5'.repeat(40), run_id: '5101', check_run_id: '9103' });
        assert(res.json.vcsUrl === `${base}/acme/app/actions/runs/5101`, `vcsUrl: ${JSON.stringify(res.json)}`);
        assert(calls.filter(c => c.method === 'POST').length === 2, 'expected job-level then run-level POSTs');
    }

    test('approve: both 403 → vcsUrl false + GitHub message + run URL; build stays approved');
    {
        const { res, build } = await approveFlow(APP1, { sha: '6'.repeat(40), run_id: '9102', check_run_id: '9113' });
        assert(res.json.vcsUrl === false && typeof res.json.vcsError === 'string', `expected vcsError, got ${JSON.stringify(res.json)}`);
        assert(res.json.vcsError.includes('more than a month ago') && res.json.vcsError.includes('HTTP 403'), `vcsError: ${res.json.vcsError}`);
        assert(res.json.vcsError.includes(`${base}/acme/app/actions/runs/9102`), 'vcsError should carry the run URL');
        assert(build.status === 'changes approved', `status: ${build.status}`);
    }

    // Deferred re-run: capture queued jobs instead of hitting the real queue (BullMQ/Redis outside APP_ENV=test)
    type Queued = { jobClass: unknown; data: Record<string, unknown>; options?: { delay?: number } };
    const queued: Queued[] = [];
    (
        facade.get(WorkerService) as unknown as { queueJob: (c: unknown, d: Record<string, unknown>, o?: { delay?: number }) => Promise<undefined> }
    ).queueJob = async (jobClass, data, options) => {
        queued.push({ jobClass, data, options });
        return undefined;
    };
    const rerunJob = facade.get<RerunCiJobJob>(RerunCiJobJob);

    test('approve: run in progress (403 already running) → vcsNotice + run URL, no vcsError, RerunCiJobJob queued with 60s delay');
    let deferredBuildId = '';
    {
        const { res, build, calls } = await approveFlow(APP1, { sha: 'a1'.repeat(20), run_id: '8800', check_run_id: '8801' });
        assert(res.json.vcsUrl === `${base}/acme/app/actions/runs/8800`, `vcsUrl: ${JSON.stringify(res.json)}`);
        assert(typeof res.json.vcsNotice === 'string' && /still running/.test(res.json.vcsNotice), `vcsNotice: ${JSON.stringify(res.json)}`);
        assert(res.json.vcsError === undefined, 'no vcsError expected');
        assert(build.status === 'changes approved', `status: ${build.status}`);
        assert(
            calls.some(c => c.method === 'GET' && c.path === `${API}/repos/acme/app/actions/runs/8800`),
            'run status not looked up'
        );
        assert(!calls.some(c => c.path.endsWith('/rerun-failed-jobs')), 'run-level fallback must be skipped when the run is in progress');
        assert(queued.length === 1 && queued[0].jobClass === RerunCiJobJob, `queued: ${queued.length}`);
        const d = queued[0].data;
        assert(
            d.buildId === build.id && d.userId === userId && d.ciJobId === '8800:8801' && d.runAttempt === 1 && d.attempt === 1,
            `job data: ${JSON.stringify(d)}`
        );
        assert(queued[0].options?.delay === RERUN_RETRY_DELAY_MS && RERUN_RETRY_DELAY_MS === 60_000, 'expected 60s delay');
        deferredBuildId = build.id;
    }

    test('RerunCiJobJob: run still in progress → re-queued with attempt+1');
    {
        queued.length = 0;
        const before = log.length;
        await rerunJob.handle({ buildId: deferredBuildId, userId, ciJobId: '8800:8801', attempt: 1 });
        assert(queued.length === 1 && queued[0].data.attempt === 2 && queued[0].options?.delay === 60_000, `queued: ${JSON.stringify(queued)}`);
        assert(!log.slice(before).some(c => c.path.endsWith('/rerun-failed-jobs')), 'no run-level fallback expected while in progress');
        // gives up at the attempt cap
        queued.length = 0;
        await rerunJob.handle({ buildId: deferredBuildId, userId, ciJobId: '8800:8801', attempt: 360 });
        assert(queued.length === 0, 'must not re-queue past MAX_ATTEMPTS');
    }

    test('RerunCiJobJob: run completed → re-run POSTed, nothing re-queued');
    {
        const { build } = await approveFlow(APP1, { sha: 'a2'.repeat(20), run_id: '5800', check_run_id: '9800' });
        queued.length = 0;
        const before = log.length;
        await rerunJob.handle({ buildId: build.id, userId, ciJobId: '5800:9800', attempt: 3 });
        const posts = log
            .slice(before)
            .filter(c => c.method === 'POST')
            .map(c => c.path);
        assert(posts.length === 1 && posts[0] === `${API}/repos/acme/app/actions/jobs/9800/rerun`, `posts: ${posts}`);
        assert(queued.length === 0, 'nothing should be re-queued');
    }

    test('RerunCiJobJob: build no longer approved or ciJobId changed → no GitHub call');
    {
        queued.length = 0;
        let before = log.length;
        await rerunJob.handle({ buildId: deferredBuildId, userId, ciJobId: '8800:9999', attempt: 2 });
        await rerunJob.handle({ buildId: '00000000-0000-0000-0000-00000000dead', userId, ciJobId: '8800:8801', attempt: 2 });
        await BuildEntity.query().filter({ id: deferredBuildId }).patchMany({ status: 'needs review' });
        await rerunJob.handle({ buildId: deferredBuildId, userId, ciJobId: '8800:8801', attempt: 2 });
        assert(log.length === before && queued.length === 0, `unexpected GitHub calls/queue: ${log.length - before}/${queued.length}`);
    }

    test('RerunCiJobJob: run_attempt advanced (re-run by someone else) → no POST, nothing re-queued');
    {
        await BuildEntity.query().filter({ id: deferredBuildId }).patchMany({ status: 'changes approved' });
        runAttempts.set('8800', 2);
        queued.length = 0;
        const before = log.length;
        await rerunJob.handle({ buildId: deferredBuildId, userId, ciJobId: '8800:8801', runAttempt: 1, attempt: 2 });
        assert(!log.slice(before).some(c => c.method === 'POST') && queued.length === 0, 'superseded job must not POST or re-queue');
        runAttempts.delete('8800');
    }

    test('RerunCiJobJob: transient run-status failure (500) → re-queued; non-transient error → stops');
    {
        const { build } = await approveFlow(APP1, { sha: 'a4'.repeat(20), run_id: '5810', check_run_id: '9810' });
        queued.length = 0;
        runGetFailures.set('5810', 1);
        await rerunJob.handle({ buildId: build.id, userId, ciJobId: '5810:9810', runAttempt: 1, attempt: 4 });
        assert(queued.length === 1 && Number(queued[0].data.attempt) === 5, `expected requeue, got ${JSON.stringify(queued)}`);
        // next attempt succeeds (lookup recovered)
        queued.length = 0;
        const before = log.length;
        await rerunJob.handle({ buildId: build.id, userId, ciJobId: '5810:9810', runAttempt: 1, attempt: 5 });
        assert(
            log.slice(before).some(c => c.method === 'POST' && c.path.endsWith('/jobs/9810/rerun')) && queued.length === 0,
            'expected re-run POST'
        );

        // 403 on a completed run (not "already running" in progress) is permanent
        const perm = await approveFlow(APP1, { sha: 'a5'.repeat(20), run_id: '9103', check_run_id: '9113' });
        queued.length = 0;
        await rerunJob.handle({ buildId: perm.build.id, userId, ciJobId: '9103:9113', attempt: 1 });
        assert(queued.length === 0, 'non-transient failure must not re-queue');
    }

    test('approve: in-progress run but refusal is not "already running" → real vcsError, no deferral');
    {
        queued.length = 0;
        const { res } = await approveFlow(APP1, { sha: 'a6'.repeat(20), run_id: '8600', check_run_id: '8601' });
        assert(res.json.vcsUrl === false && /Resource not accessible/.test(res.json.vcsError), `expected vcsError, got ${JSON.stringify(res.json)}`);
        assert(res.json.vcsNotice === undefined && queued.length === 0, 'must not defer');
    }

    test('approve: second approval of an already-approved build → 400, exactly one re-run POST');
    {
        // (The test facade shares one DB connection via savepoints, so true row-lock contention can't be reproduced here.)
        const created = await createBuild(facade, APP1, { sha: 'a7'.repeat(20), run_id: '5820', check_run_id: '9820' });
        status(created, 200, 'create');
        await BuildEntity.query().filter({ id: created.json.id }).patchMany({ status: 'needs review' });
        const before = log.length;
        const url = `/api/apps/${APP1}/builds/${created.json.id}/approve`;
        const first = await send(facade, 'POST', url, {}, userJwt);
        const second = await send(facade, 'POST', url, {}, userJwt);
        assert(first.statusCode === 200 && second.statusCode === 400, `statuses: ${first.statusCode}/${second.statusCode}`);
        assert(log.slice(before).filter(c => c.method === 'POST' && c.path.endsWith('/rerun')).length === 1, 'expected exactly one re-run POST');
    }

    test('approve: 403 but run completed → normal error, no deferral');
    {
        queued.length = 0;
        const { res } = await approveFlow(APP1, { sha: 'a3'.repeat(20), run_id: '8900', check_run_id: '8901' });
        assert(res.json.vcsUrl === false && /HTTP 403/.test(res.json.vcsError), `expected vcsError, got ${JSON.stringify(res.json)}`);
        assert(res.json.vcsNotice === undefined && queued.length === 0, 'must not defer when the run is completed');
    }

    test('approve: ciJobId with run only → only rerun-failed-jobs is called');
    {
        const { res, build, calls } = await approveFlow(APP1, { sha: '7'.repeat(40), run_id: '5200', check_run_id: undefined });
        assert(build.ciJobId === '5200', `ciJobId: ${build.ciJobId}`);
        assert(res.json.vcsUrl === `${base}/acme/app/actions/runs/5200`, `vcsUrl: ${JSON.stringify(res.json)}`);
        const posts = calls.filter(c => c.method === 'POST').map(c => c.path);
        assert(posts.length === 1 && posts[0] === `${API}/repos/acme/app/actions/runs/5200/rerun-failed-jobs`, `posts: ${posts}`);
    }

    test('approve: moved repository → rerun targets the new path and apps.projectPath is updated');
    {
        await createApp(APP_MOVED, 'Moved', MOVED_ID, 'acme/old-name');
        const { res } = await approveFlow(APP_MOVED, {
            repository: 'acme/old-name',
            repository_id: String(MOVED_ID),
            sha: '8'.repeat(40),
            run_id: '5300',
            check_run_id: '9300'
        });
        assert(res.json.vcsUrl === `${base}/acme/renamed/actions/runs/5300`, `vcsUrl: ${JSON.stringify(res.json)}`);
        const app = await AppEntity.query().filter({ id: APP_MOVED }).findOne();
        assert(app.projectPath === 'acme/renamed', `projectPath: ${app.projectPath}`);
    }

    test('approve: no push permission → clear error without calling re-run');
    {
        await createApp(APP_NOPUSH, 'No Push', NOPUSH_ID, 'acme/readonly');
        const { res, calls } = await approveFlow(APP_NOPUSH, {
            repository: 'acme/readonly',
            repository_id: String(NOPUSH_ID),
            sha: '9'.repeat(40),
            run_id: '5400',
            check_run_id: '9400'
        });
        assert(res.json.vcsUrl === false && /write access/i.test(res.json.vcsError), `expected write-access error, got ${JSON.stringify(res.json)}`);
        assert(!calls.some(c => c.method === 'POST'), 'no re-run POST expected');
    }

    test('approve by a non-admin: push:false → 403 without touching the build; push:true → 200');
    {
        const approveAs = async (jwt: string, claims: Record<string, unknown>) => {
            const created = await createBuild(facade, APP1, claims);
            status(created, 200, 'create build for non-admin approve');
            await BuildEntity.query().filter({ id: created.json.id }).patchMany({ status: 'needs review' });
            const logStart = log.length;
            const res = await send(facade, 'POST', `/api/apps/${APP1}/builds/${created.json.id}/approve`, {}, jwt);
            const build = await BuildEntity.query().filter({ id: created.json.id }).findOne();
            return { res, build, calls: log.slice(logStart) };
        };

        // USER_B (non-admin, token ghu_B_new) can read acme/app but has push:false
        const denied = await approveAs(await JWT.generate({ subject: USER_B_ID }), { sha: 'b1'.repeat(20), run_id: '5900', check_run_id: '9900' });
        status(denied.res, 403, 'non-admin without push');
        assert(/write access/.test(String(denied.res.body)), `expected a write-access message, got ${denied.res.body}`);
        assert(denied.build.status === 'needs review', `denied approve changed the build: ${denied.build.status}`);
        assert(!denied.calls.some(c => c.method === 'POST'), 'no re-run POST expected');

        await createPersistedEntity(UserEntity, {
            id: USER_D_ID,
            name: 'User D',
            createdAt: new Date(),
            lastLoginAt: new Date(),
            isAdmin: false,
            vcsId: GH_VCS_ID,
            vcsUserId: '6666'
        });
        await setSession(USER_D_ID, { accessToken: 'ghu_D', expiresAt: Date.now() + 8 * 3600_000, refreshToken: 'ghr_D', redirectUri: 'x' });
        const allowed = await approveAs(await JWT.generate({ subject: USER_D_ID }), { sha: 'd1'.repeat(20), run_id: '5910', check_run_id: '9910' });
        status(allowed.res, 200, 'non-admin with push');
        assert(allowed.build.status === 'changes approved' && allowed.build.approvedById === USER_D_ID, `status: ${allowed.build.status}`);
        assert(allowed.res.json.vcsUrl === `${base}/acme/app/actions/runs/5910`, `vcsUrl: ${JSON.stringify(allowed.res.json)}`);

        const show = await get(facade, `/api/apps/${APP1}`, await JWT.generate({ subject: USER_B_ID }));
        status(show, 200, 'show as USER_B');
        assert(show.json.canReview === false && show.json.approvalMinRole === 'write', `show as USER_B: ${show.body}`);
    }

    test('dedupe: same sha with a new check_run_id while needs review → ciJobId updated');
    {
        const first = await createBuild(facade, APP1, { sha: 'f'.repeat(40), run_id: '5500', check_run_id: '9500' });
        status(first, 200, 'first');
        await BuildEntity.query().filter({ id: first.json.id }).patchMany({ status: 'needs review' });
        const second = await createBuild(facade, APP1, { sha: 'f'.repeat(40), run_id: '5500', check_run_id: '9501' });
        status(second, 200, 'second');
        assert(second.json.id === first.json.id, 'expected the same build');
        const build = await BuildEntity.query().filter({ id: first.json.id }).findOne();
        assert(build.ciJobId === '5500:9501', `ciJobId after dedupe: ${build.ciJobId}`);
    }

    test('dedupe: same job with a new OIDC token on a fresh draft → uploader; bare run id (no check_run_id) → reader');
    {
        const job = { sha: '3c'.repeat(20), run_id: '5600', check_run_id: '9600' };
        const first = await createBuild(facade, APP1, { ...job, jti: 'job-1' });
        status(first, 200, 'first');
        assert(first.json.status === 'draft', `first: ${first.json.status}`);
        const again = await createBuild(facade, APP1, { ...job, jti: 'job-2' });
        status(again, 200, 'same job, new token');
        assert(again.json.id === first.json.id && again.json.status === 'draft', `same job re-create: ${again.json.status}`);

        // Some GHES versions omit check_run_id: every job in the run shares the bare run id, so it must not identify the uploader
        const run = { sha: '4d'.repeat(20), run_id: '5700', check_run_id: undefined };
        const ghes1 = await createBuild(facade, APP1, { ...run, jti: 'run-1' });
        status(ghes1, 200, 'ghes first');
        assert(ghes1.json.status === 'draft', `ghes first: ${ghes1.json.status}`);
        const ghes2 = await createBuild(facade, APP1, { ...run, jti: 'run-2' });
        status(ghes2, 200, 'ghes second job');
        assert(ghes2.json.id === ghes1.json.id && ghes2.json.status === 'processing', `bare run id must be a reader, got ${ghes2.json.status}`);
    }

    // service-level rerun edge cases
    test('rerunCiJob: unparsable job id, repo gone (404)');
    {
        const svc = new VcsGitHubService(ghConfig, stubLogger);
        const user = await UserEntity.query().filter({ id: userId }).findOne();
        const bad = await svc.rerunCiJob(user, { projectPath: 'acme/app', vcsProjectId: REPO_ID }, 'not-a-job');
        assert(!bad.ok && bad.error === 'No CI run recorded for this build', `unexpected: ${JSON.stringify(bad)}`);
        const none = await svc.rerunCiJob(user, { projectPath: 'acme/app', vcsProjectId: null }, '5000:9000');
        assert(!none.ok && none.error === 'No CI run recorded for this build', `unexpected: ${JSON.stringify(none)}`);
        const gone = await svc.rerunCiJob(user, { projectPath: 'acme/gone', vcsProjectId: GONE_ID }, '5000:9000');
        assert(!gone.ok && gone.error.includes('Repository not accessible') && !gone.retryable, `unexpected: ${JSON.stringify(gone)}`);
    }

    // 10. PAT
    test('PAT: ghp_valid with no header resolves the GitHub integration; /api/ext/apps filters by /repositories');
    {
        const ambiguous = await facade.request(HttpRequest.GET('/api/ext/apps').header('authorization', 'Bearer ghp_valid'));
        status(ambiguous as Res, 401, 'two GitHub integrations and no header');
        await VcsIntegrationEntity.query().filter({ id: NOAPP_VCS_ID }).deleteMany();
        const res = await facade.request(HttpRequest.GET('/api/ext/apps').header('authorization', 'Bearer ghp_valid'));
        status(res as Res, 200, 'ext apps');
        const names = ((res as Res).json as { name: string }[]).map(a => a.name);
        assert(names.includes('App 1') && names.includes('App 2') && !names.includes('Hidden App'), `ext apps: ${names}`);
        const unknown = await facade.request(HttpRequest.GET('/api/ext/apps').header('authorization', 'Bearer ghp_unknown'));
        status(unknown as Res, 401, 'unknown PAT');
    }

    assert(violations.length === 0, `mock server violations:\n  ${violations.join('\n  ')}`);

    mockServer.close();
}
