/**
 * OAuth 2.1 for the MCP endpoint: PixelCI as its own authorization server. Covers discovery, dynamic registration, the authorize and
 * consent flow, code and refresh grants (PKCE, burn-on-failure, replay, rotation and reuse), revocation, connected apps, the MCP
 * resource checks (audience, expiry, foreign credentials never forwarded to a VCS) and the prune job.
 *
 * A mock GitLab serves identity (PATs), project access, and the refresh-token endpoint (switchable), and records every credential it
 * receives so the tests can assert that no PixelCI-issued or UI session token ever reaches it.
 */
import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, createRedis, JWT, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { createHash, randomBytes } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { CoreAppOptions } from '../../src/app';
import { AppEntity } from '../../src/entities/App.entity';
import { BranchEntity } from '../../src/entities/Branch.entity';
import { OAuthAuthorizationEntity } from '../../src/entities/OAuthAuthorization.entity';
import { OAuthClientEntity } from '../../src/entities/OAuthClient.entity';
import { OAuthGrantEntity } from '../../src/entities/OAuthGrant.entity';
import { OAuthTokenEntity } from '../../src/entities/OAuthToken.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { PruneOAuthJob } from '../../src/jobs/PruneOAuth.job';
import { pkceS256 } from '../../src/services/oauth/OAuthCrypto';
import { sealIntegrationConfig, sealVcsSession } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase, ensureTestBucket, useIsolatedRedisPrefix } from './db-defaults';

process.env.CI = 'true';
useIsolatedRedisPrefix('mcp-oauth');
process.env.PUBLIC_URL = 'https://pixelci.test';
process.env.OAUTH_DCR_MAX_PER_IP_PER_HOUR = '1000';
process.env.OAUTH_DCR_MAX_PER_HOUR = '5000';

configureTestDatabase();

const ISSUER = 'https://pixelci.test';
const RESOURCE = `${ISSUER}/api/mcp`;
const CHALLENGE_BASE = `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp", scope="mcp:read"`;

const VCS_ID = '00000000-0000-0000-0000-000000000000';
const USER_ID = 'a5555555-aaaa-bbbb-cccc-000000000001';
const USER_EXPIRED_ID = 'a5555555-aaaa-bbbb-cccc-000000000002';
const USER_OTHER_ID = 'a5555555-aaaa-bbbb-cccc-000000000003';
const APP_ID = 'a5555555-aaaa-bbbb-cccc-000000000010';
const APP_NO_ACCESS_ID = 'a5555555-aaaa-bbbb-cccc-000000000011';
const BRANCH_ID = 'a5555555-aaaa-bbbb-cccc-000000000020';
const BRANCH_NO_ACCESS_ID = 'a5555555-aaaa-bbbb-cccc-000000000021';

const VALID_PAT = 'glpat-oauth-test-token';
const FRESH_VCS_ACCESS = 'vcs-access-fresh';
const EXPIRED_VCS_ACCESS = 'vcs-access-expired';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

type GitLabMode = 'ok' | 'invalid_grant' | 'server_error';
let gitlabMode: GitLabMode = 'ok';
/** Every credential the mock GitLab received. */
const gitlabSeen: string[] = [];
let mockGitLabServer: Server;
let mockGitLabPort: number;

run()
    .then(() => {
        console.log('\nAll MCP OAuth tests passed!');
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
            gitlabSeen.push(String(req.headers['private-token'] ?? ''), String(req.headers['authorization'] ?? ''));
            const json = (status: number, body: unknown) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };

            if (url === '/api/v4/user') {
                if (req.headers['private-token'] === VALID_PAT) return json(200, { id: 4242, username: 'rita', name: 'Reviewer Rita' });
                return json(401, { message: 'Unauthorized' });
            }
            if (url.startsWith('/api/v4/projects/')) {
                const projectId = Number(url.slice('/api/v4/projects/'.length));
                if (projectId === 100) return json(200, { id: 100, path_with_namespace: 'group/accessible' });
                return json(404, { message: 'Not found' });
            }
            if (req.method === 'POST' && url === '/oauth/token') {
                // drain the body first
                req.resume();
                if (gitlabMode === 'invalid_grant') return json(400, { error: 'invalid_grant' });
                if (gitlabMode === 'server_error') return json(500, { error: 'server_error' });
                return json(200, { access_token: 'vcs-access-renewed', refresh_token: 'vcs-refresh-renewed', expires_in: 7200 });
            }
            json(404, { message: 'Not found' });
        });
        mockGitLabServer.listen(0, () => {
            mockGitLabPort = (mockGitLabServer.address() as { port: number }).port;
            resolve();
        });
    });
}

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;
type Response = Awaited<ReturnType<Facade['request']>>;

function check(cond: unknown, message: string): asserts cond {
    if (!cond) throw new Error(message);
}

function eq<T>(actual: T, expected: T, label: string) {
    if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
}

function status(response: Response, expected: number, label: string) {
    if (response.statusCode !== expected) throw new Error(`${label}: expected ${expected} but got ${response.statusCode}: ${response.bodyString}`);
}

const header = (response: Response, name: string): string | undefined => {
    const v = response.getHeader(name);
    return Array.isArray(v) ? v.join(', ') : v;
};

async function run() {
    await createMockGitLab();

    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, { enableDatabase: true, databasePrefix: 'pixelci_oauthtest' });
    await ensureTestBucket();
    await facade.start();
    await seedBase();
    await resetRateLimits();

    const ctx: Ctx = { f: facade, jwt: {} };
    ctx.jwt[USER_ID] = await JWT.generate({ subject: USER_ID });
    ctx.jwt[USER_EXPIRED_ID] = await JWT.generate({ subject: USER_EXPIRED_ID });
    ctx.jwt[USER_OTHER_ID] = await JWT.generate({ subject: USER_OTHER_ID });

    await testDiscovery(ctx);
    await testDisabled(ctx);
    await testRegistration(ctx);
    await testAuthorize(ctx);
    await testConsent(ctx);
    await testTokenExchange(ctx);
    await testClientAuthentication(ctx);
    await testMcpResource(ctx);
    await testRefresh(ctx);
    await testRevocationAndConnectedApps(ctx);
    await testSuperseded(ctx);
    await testConcurrentRedemption(ctx);
    await testPrune(ctx);

    mockGitLabServer.close();
}

interface Ctx {
    f: Facade;
    jwt: Record<string, string>;
}

// ------------------------------------------------------------------------------------------------ seeding / helpers

async function seedBase() {
    await createPersistedEntity(VcsIntegrationEntity, {
        id: VCS_ID,
        name: 'OAuth Test VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({ url: `http://127.0.0.1:${mockGitLabPort}`, clientId: 'client-id', clientSecret: 'client-secret' })
    });
    const session = (accessToken: string, expiresAt: number) =>
        sealVcsSession({ accessToken, refreshToken: `${accessToken}-refresh`, expiresAt, redirectUri: 'https://pixelci.test/login' });
    const user = (id: string, vcsUserId: string, name: string, vcsSession: ReturnType<typeof session>) =>
        createPersistedEntity(UserEntity, {
            id,
            name,
            createdAt: new Date(),
            lastLoginAt: new Date(),
            isAdmin: false,
            vcsId: VCS_ID,
            vcsUserId,
            vcsSession
        });
    await user(USER_ID, '4242', 'Reviewer Rita', session(FRESH_VCS_ACCESS, Date.now() + 3_600_000));
    await user(USER_EXPIRED_ID, '4343', 'Expired Eve', session(EXPIRED_VCS_ACCESS, Date.now() - 60_000));
    await user(USER_OTHER_ID, '4444', 'Other Olga', session(FRESH_VCS_ACCESS, Date.now() + 3_600_000));

    await createPersistedEntity(AppEntity, {
        id: APP_ID,
        name: 'Accessible App',
        defaultBranchId: BRANCH_ID,
        projectPath: 'group/accessible',
        vcsProjectId: 100,
        vcsId: VCS_ID
    });
    await createPersistedEntity(AppEntity, {
        id: APP_NO_ACCESS_ID,
        name: 'Secret App',
        defaultBranchId: BRANCH_NO_ACCESS_ID,
        projectPath: 'group/secret',
        vcsProjectId: 200,
        vcsId: VCS_ID
    });
    await createPersistedEntity(BranchEntity, { id: BRANCH_ID, appId: APP_ID, name: 'main' });
    await createPersistedEntity(BranchEntity, { id: BRANCH_NO_ACCESS_ID, appId: APP_NO_ACCESS_ID, name: 'main' });
}

/** The limiter counts per IP across runs (the window outlives the process), so clear its keys before and after. */
async function resetRateLimits() {
    const { client, prefix } = createRedis();
    const keys = await client.keys(`${prefix}:ratelimit:*`);
    if (keys.length) await client.del(...keys);
}

const verifierFor = () => randomBytes(32).toString('base64url');

function formReq(path: string, params: Record<string, string> | string, headers: Record<string, string> = {}) {
    const body = typeof params === 'string' ? params : new URLSearchParams(params).toString();
    return HttpRequest.POST(path, body, { 'content-type': 'application/x-www-form-urlencoded', ...headers });
}

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

interface IClient {
    id: string;
    secret?: string;
    redirectUris: string[];
}

async function register(f: Facade, body: Record<string, unknown>): Promise<Response> {
    return f.request(HttpRequest.POST('/api/oauth/register').json(body));
}

async function registerClient(f: Facade, overrides: Record<string, unknown> = {}): Promise<IClient> {
    const redirectUris = (overrides.redirect_uris as string[]) ?? ['https://claude.ai/api/mcp/auth_callback'];
    const response = await register(f, { client_name: 'Test Client', redirect_uris: redirectUris, token_endpoint_auth_method: 'none', ...overrides });
    status(response, 201, 'register');
    const body = response.json as { client_id: string; client_secret?: string };
    return { id: body.client_id, secret: body.client_secret, redirectUris };
}

interface IAuthorizeOpts {
    redirectUri?: string;
    state?: string;
    verifier?: string;
    extra?: Record<string, string>;
}

function authorizeQuery(client: IClient, opts: IAuthorizeOpts = {}): Record<string, string> {
    const verifier = opts.verifier ?? verifierFor();
    return {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: opts.redirectUri ?? client.redirectUris[0],
        code_challenge: pkceS256(verifier),
        code_challenge_method: 'S256',
        state: opts.state ?? 'st-' + randomBytes(4).toString('hex'),
        ...opts.extra
    };
}

const authorizeGet = (f: Facade, query: Record<string, string>) =>
    f.request(HttpRequest.GET(`/api/oauth/authorize?${new URLSearchParams(query).toString()}`));

/** Runs authorize and returns the pending request id, asserting the consent redirect. */
async function startConsent(f: Facade, client: IClient, opts: IAuthorizeOpts = {}): Promise<string> {
    const response = await authorizeGet(f, authorizeQuery(client, opts));
    status(response, 302, 'authorize');
    const location = new URL(header(response, 'location')!);
    eq(`${location.origin}${location.pathname}`, `${ISSUER}/oauth/consent`, 'authorize redirects to consent');
    const id = location.searchParams.get('request');
    check(id, 'consent redirect carries a request id');
    return id;
}

const userReq = (ctx: Ctx, userId: string, req: HttpRequest) => req.header('authorization', `Bearer ${ctx.jwt[userId]}`);

async function approve(ctx: Ctx, requestId: string, userId = USER_ID): Promise<Response> {
    return ctx.f.request(userReq(ctx, userId, HttpRequest.POST('/api/connected-apps/requests/approve').json({ request: requestId })));
}

function codeFrom(response: Response): { code: string; url: URL } {
    status(response, 200, 'approve');
    const url = new URL((response.json as { redirectUrl: string }).redirectUrl);
    const code = url.searchParams.get('code');
    check(code, 'approve redirect carries a code');
    return { code, url };
}

interface ITokens {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
}

/** authorize → approve → returns the code and the verifier, ready for the token endpoint. */
async function getCode(ctx: Ctx, client: IClient, opts: IAuthorizeOpts & { userId?: string } = {}) {
    const verifier = opts.verifier ?? verifierFor();
    const id = await startConsent(ctx.f, client, { ...opts, verifier });
    const { code } = codeFrom(await approve(ctx, id, opts.userId ?? USER_ID));
    return { code, verifier, requestId: id, redirectUri: opts.redirectUri ?? client.redirectUris[0] };
}

function clientAuth(client: IClient): { body: Record<string, string>; headers: Record<string, string> } {
    if (client.secret) return { body: {}, headers: { authorization: basic(client.id, client.secret) } };
    return { body: { client_id: client.id }, headers: {} };
}

function tokenReq(client: IClient, params: Record<string, string>, extraHeaders: Record<string, string> = {}) {
    const auth = clientAuth(client);
    return formReq('/api/oauth/token', { ...auth.body, ...params }, { ...auth.headers, ...extraHeaders });
}

async function exchange(ctx: Ctx, client: IClient, code: string, verifier: string, redirectUri: string): Promise<Response> {
    return ctx.f.request(tokenReq(client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }));
}

async function fullFlow(ctx: Ctx, client: IClient, opts: IAuthorizeOpts & { userId?: string } = {}): Promise<ITokens> {
    const { code, verifier, redirectUri } = await getCode(ctx, client, opts);
    const response = await exchange(ctx, client, code, verifier, redirectUri);
    status(response, 200, 'token exchange');
    return response.json as ITokens;
}

async function refresh(ctx: Ctx, client: IClient, refreshToken: string, extra: Record<string, string> = {}): Promise<Response> {
    return ctx.f.request(tokenReq(client, { grant_type: 'refresh_token', refresh_token: refreshToken, ...extra }));
}

function mcpPost(
    ctx: Ctx,
    token: string | null,
    body: object = { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    headers: Record<string, string> = {}
) {
    let req = HttpRequest.POST('/api/mcp')
        .header('accept', 'application/json, text/event-stream')
        .header('content-type', 'application/json')
        .header('mcp-protocol-version', '2025-06-18');
    if (token) req = req.header('authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) req = req.header(k, v);
    return ctx.f.request(req.json(body));
}

async function listApps(ctx: Ctx, token: string): Promise<string[]> {
    const response = await mcpPost(ctx, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_apps', arguments: {} } });
    status(response, 200, 'list_apps');
    const result = (response.json as { result: { isError?: boolean; content: { text: string }[] } }).result;
    check(!result.isError, `list_apps errored: ${JSON.stringify(result)}`);
    return (JSON.parse(result.content[0].text) as { id: string }[]).map(a => a.id);
}

/** Seeds a live grant (and tokens) directly, for cases the full flow can't produce. Returns the plaintext tokens. */
async function seedGrant(
    client: IClient,
    userId: string,
    opts: { resource?: string; scope?: string; accessExpiresAt?: Date; grantExpiresAt?: Date } = {}
) {
    const grantId = crypto.randomUUID();
    const now = new Date();
    const access = `pixelci_at_${randomBytes(32).toString('base64url')}`;
    const refreshTok = `pixelci_rt_${randomBytes(32).toString('base64url')}`;
    await createPersistedEntity(OAuthGrantEntity, {
        id: grantId,
        clientId: client.id,
        userId,
        scope: opts.scope ?? 'mcp:read',
        resource: opts.resource ?? RESOURCE,
        redirectUri: client.redirectUris[0],
        createdAt: now,
        expiresAt: opts.grantExpiresAt ?? new Date(Date.now() + 86_400_000),
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null
    });
    const token = (kind: 'access' | 'refresh', value: string, expiresAt: Date) =>
        createPersistedEntity(OAuthTokenEntity, {
            id: crypto.randomUUID(),
            grantId,
            kind,
            tokenHash: sha256(value),
            createdAt: now,
            expiresAt,
            rotatedAt: null
        });
    await token('access', access, opts.accessExpiresAt ?? new Date(Date.now() + 3_600_000));
    await token('refresh', refreshTok, new Date(Date.now() + 86_400_000));
    return { grantId, access, refresh: refreshTok };
}

const grantOf = (id: string) => OAuthGrantEntity.query().filter({ id }).findOne();

async function grantIdOfRefresh(refreshToken: string): Promise<string> {
    const row = await OAuthTokenEntity.query()
        .filter({ tokenHash: sha256(refreshToken) })
        .findOne();
    return row.grantId;
}

// ------------------------------------------------------------------------------------------------------- discovery

async function testDiscovery(ctx: Ctx) {
    const f = ctx.f;
    console.log('\nTest: discovery - unauthenticated MCP request is challenged with the protected-resource metadata');
    const unauth = await mcpPost(ctx, null);
    status(unauth, 401, 'mcp unauthenticated');
    eq(header(unauth, 'www-authenticate'), `Bearer ${CHALLENGE_BASE}`, 'challenge');
    check(!header(unauth, 'www-authenticate')!.includes('error='), 'no error attribute without credentials');
    eq(header(unauth, 'cache-control'), 'no-store', 'no-store on 401');
    check(typeof (unauth.json as { error?: string }).error === 'string', '401 body is an OAuth-shaped error');
    for (const method of ['GET', 'DELETE'] as const) {
        const r = await f.request(method === 'GET' ? HttpRequest.GET('/api/mcp') : HttpRequest.DELETE('/api/mcp'));
        status(r, 401, `${method} /api/mcp unauthenticated`);
    }
    console.log('  PASS');

    console.log('\nTest: discovery - protected resource and authorization server metadata');
    for (const path of ['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource']) {
        const r = await f.request(HttpRequest.GET(path));
        status(r, 200, path);
        const doc = r.json as { resource: string; authorization_servers: string[]; scopes_supported: string[]; bearer_methods_supported: string[] };
        eq(doc.resource, RESOURCE, `${path} resource`);
        eq(JSON.stringify(doc.authorization_servers), JSON.stringify([ISSUER]), `${path} authorization_servers`);
        eq(JSON.stringify(doc.scopes_supported), JSON.stringify(['mcp:read']), `${path} scopes`);
        eq(JSON.stringify(doc.bearer_methods_supported), JSON.stringify(['header']), `${path} bearer methods`);
        eq(header(r, 'cache-control'), 'max-age=300', `${path} cache-control`);
    }
    const as = await f.request(HttpRequest.GET('/.well-known/oauth-authorization-server'));
    status(as, 200, 'AS metadata');
    const meta = as.json as Record<string, unknown>;
    eq(meta.issuer, ISSUER, 'issuer');
    eq(meta.authorization_endpoint, `${ISSUER}/api/oauth/authorize`, 'authorization_endpoint');
    eq(meta.token_endpoint, `${ISSUER}/api/oauth/token`, 'token_endpoint');
    eq(meta.registration_endpoint, `${ISSUER}/api/oauth/register`, 'registration_endpoint');
    eq(meta.revocation_endpoint, `${ISSUER}/api/oauth/revoke`, 'revocation_endpoint');
    eq(JSON.stringify(meta.code_challenge_methods_supported), JSON.stringify(['S256']), 'PKCE methods');
    eq(meta.authorization_response_iss_parameter_supported, true, 'iss parameter supported');
    eq(meta.client_id_metadata_document_supported, true, 'client id metadata documents are advertised (covered in oauth-cimd.test.ts)');
    console.log('  PASS');

    console.log('\nTest: discovery - probes for other documents get 404 JSON, not the SPA');
    for (const path of ['/.well-known/openid-configuration', '/.well-known/nothing', '/.well-known/a/b', '/.well-known/a/b/c']) {
        const r = await f.request(HttpRequest.GET(path));
        status(r, 404, path);
        check(String(header(r, 'content-type')).includes('application/json'), `${path} is JSON`);
        eq((r.json as { error: string }).error, 'not_found', `${path} body`);
    }
    console.log('  PASS');

    console.log('\nTest: CORS - any origin for the OAuth/MCP endpoints, no credentials; authorize and connected-apps excluded');
    const origin = 'https://inspector.example';
    const metaCors = await f.request(HttpRequest.GET('/.well-known/oauth-authorization-server').header('origin', origin));
    eq(header(metaCors, 'access-control-allow-origin'), origin, 'metadata CORS origin echoed');
    check(!header(metaCors, 'access-control-allow-credentials'), 'no credentials on CORS');
    const preflight = await f.request(
        HttpRequest.OPTIONS('/api/oauth/token')
            .header('origin', origin)
            .header('access-control-request-method', 'POST')
            .header('access-control-request-headers', 'content-type')
    );
    status(preflight, 204, 'token preflight');
    eq(header(preflight, 'access-control-allow-origin'), origin, 'preflight origin');
    check(!header(preflight, 'access-control-allow-credentials'), 'no credentials on preflight');
    const mcpCors = await f.request(HttpRequest.POST('/api/mcp').header('origin', origin).json({}));
    status(mcpCors, 401, 'mcp cors 401');
    eq(header(mcpCors, 'access-control-allow-origin'), origin, 'mcp CORS origin');
    check(String(header(mcpCors, 'access-control-expose-headers')).includes('WWW-Authenticate'), 'WWW-Authenticate exposed');
    const authorizeCors = await f.request(HttpRequest.GET('/api/oauth/authorize').header('origin', origin));
    check(!header(authorizeCors, 'access-control-allow-origin'), 'authorize has no CORS');
    const connectedCors = await f.request(HttpRequest.GET('/api/connected-apps').header('origin', origin));
    check(!header(connectedCors, 'access-control-allow-origin'), 'connected-apps has no CORS');
    console.log('  PASS');
}

async function testDisabled(ctx: Ctx) {
    const f = ctx.f;
    console.log('\nTest: with OAuth unavailable every OAuth route is 404, MCP challenges bare, and pixelci_* tokens are rejected');
    const config = f.app.config as unknown as { MCP_OAUTH_ENABLED: boolean };
    const client = await registerClient(f);
    const grant = await seedGrant(client, USER_ID);
    config.MCP_OAUTH_ENABLED = false;
    try {
        for (const path of [
            '/.well-known/oauth-authorization-server',
            '/.well-known/oauth-protected-resource',
            '/.well-known/oauth-protected-resource/api/mcp'
        ]) {
            status(await f.request(HttpRequest.GET(path)), 404, `${path} disabled`);
        }
        status(await register(f, { redirect_uris: ['https://claude.ai/cb'] }), 404, 'register disabled');
        status(await authorizeGet(f, authorizeQuery(client)), 404, 'authorize disabled');
        status(await f.request(formReq('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: 'x' })), 404, 'token disabled');
        status(await f.request(formReq('/api/oauth/revoke', { token: 'x' })), 404, 'revoke disabled');
        status(await f.request(userReq(ctx, USER_ID, HttpRequest.GET('/api/connected-apps'))), 404, 'connected apps disabled');

        const noAuth = await mcpPost(ctx, null);
        status(noAuth, 401, 'mcp disabled unauthenticated');
        eq(header(noAuth, 'www-authenticate'), 'Bearer realm="PixelCI"', 'bare challenge');
        const rejected = await mcpPost(ctx, grant.access);
        status(rejected, 401, 'mcp disabled with an access token');
        check(!header(rejected, 'www-authenticate')!.includes('resource_metadata'), 'no metadata pointer when disabled');
    } finally {
        config.MCP_OAUTH_ENABLED = true;
    }
    status(await mcpPost(ctx, grant.access), 200, 'access token works again once enabled');
    console.log('  PASS');
}

// ------------------------------------------------------------------------------------------------------ registration

async function testRegistration(ctx: Ctx) {
    const f = ctx.f;
    console.log('\nTest: registration - public, client_secret_post and default (basic) clients');
    const pub = await register(f, {
        client_name: 'Public',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none'
    });
    status(pub, 201, 'public');
    const pubBody = pub.json as Record<string, unknown>;
    check(!('client_secret' in pubBody), 'public client gets no secret');
    eq(pubBody.token_endpoint_auth_method, 'none', 'public method');
    eq(header(pub, 'cache-control'), 'no-store', 'registration no-store');
    eq(pubBody.scope, 'mcp:read', 'scope');
    check(/^[0-9a-f-]{36}$/.test(String(pubBody.client_id)), 'client_id is a uuid');

    const post = await register(f, {
        client_name: 'Post',
        redirect_uris: ['https://claude.ai/cb'],
        token_endpoint_auth_method: 'client_secret_post'
    });
    status(post, 201, 'post');
    const postBody = post.json as { client_secret: string; client_secret_expires_at: number; client_id: string };
    check(postBody.client_secret.startsWith('pixelci_cs_'), 'secret is prefixed');
    eq(postBody.client_secret_expires_at, 0, 'secret never expires');
    const stored = await OAuthClientEntity.query().filter({ id: postBody.client_id }).findOne();
    eq(stored.secretHash, sha256(postBody.client_secret), 'only the secret hash is stored');
    check(!JSON.stringify(stored).includes(postBody.client_secret), 'plaintext secret is not stored');

    const def = await register(f, {
        redirect_uris: ['https://claude.ai/cb'],
        logo_uri: 'https://evil.example/logo.png',
        client_uri: 'https://evil.example'
    });
    status(def, 201, 'default method');
    const defBody = def.json as Record<string, unknown>;
    eq(defBody.token_endpoint_auth_method, 'client_secret_basic', 'omitted method defaults to basic');
    eq(defBody.client_name, 'Unnamed MCP client', 'default name');
    check(typeof defBody.client_secret === 'string', 'basic client gets a secret');
    check(!('logo_uri' in defBody) && !('client_uri' in defBody), 'logo and client uri are not echoed');

    const sanitised = await register(f, {
        client_name: '  Evil‮\u0000 Name  ',
        redirect_uris: ['https://claude.ai/cb'],
        token_endpoint_auth_method: 'none'
    });
    eq((sanitised.json as { client_name: string }).client_name, 'Evil Name', 'client name is sanitised');
    console.log('  PASS');

    console.log('\nTest: registration - rejected metadata');
    const bad = async (body: unknown, code: string, label: string) => {
        const r = await f.request(HttpRequest.POST('/api/oauth/register').json(body as object));
        status(r, 400, label);
        eq((r.json as { error: string }).error, code, `${label} error`);
    };
    await bad({ redirect_uris: ['http://example.com/cb'] }, 'invalid_redirect_uri', 'http non-loopback');
    await bad({ redirect_uris: ['https://claude.ai/cb#frag'] }, 'invalid_redirect_uri', 'fragment');
    await bad({ redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri', 'javascript scheme');
    await bad({ redirect_uris: ['cursor://app/cb'] }, 'invalid_redirect_uri', 'private-use scheme');
    await bad({ redirect_uris: [] }, 'invalid_redirect_uri', 'no redirect uris');
    await bad({}, 'invalid_redirect_uri', 'missing redirect uris');
    await bad({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://claude.ai/cb${i}`) }, 'invalid_redirect_uri', '11 redirect uris');
    await bad({ redirect_uris: ['https://claude.ai/cb'], grant_types: ['client_credentials'] }, 'invalid_client_metadata', 'client_credentials');
    await bad({ redirect_uris: ['https://claude.ai/cb'], response_types: ['token'] }, 'invalid_client_metadata', 'implicit');
    await bad(
        { redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'private_key_jwt' },
        'invalid_client_metadata',
        'private_key_jwt'
    );
    const notObject = await f.request(HttpRequest.POST('/api/oauth/register', '[1,2]', { 'content-type': 'application/json' }));
    status(notObject, 400, 'array body');
    const badJson = await f.request(HttpRequest.POST('/api/oauth/register', '{nope', { 'content-type': 'application/json' }));
    status(badJson, 400, 'bad json');
    eq((badJson.json as { error: string }).error, 'invalid_client_metadata', 'bad json error');
    const wrongType = await f.request(HttpRequest.POST('/api/oauth/register', '{}', { 'content-type': 'text/plain' }));
    status(wrongType, 400, 'wrong content type');
    const tooBig = await f.request(
        HttpRequest.POST('/api/oauth/register', JSON.stringify({ redirect_uris: ['https://claude.ai/cb'], client_name: 'x'.repeat(20_000) }), {
            'content-type': 'application/json'
        })
    );
    check(tooBig.statusCode === 400 || tooBig.statusCode === 413, `oversized registration rejected (got ${tooBig.statusCode})`);
    console.log('  PASS');

    console.log('\nTest: registration - rejected requests do not use up the global cap');
    const globalConfig = f.app.config as unknown as { OAUTH_DCR_MAX_PER_HOUR: number };
    const originalGlobal = globalConfig.OAUTH_DCR_MAX_PER_HOUR;
    await resetRateLimits();
    globalConfig.OAUTH_DCR_MAX_PER_HOUR = 2;
    try {
        for (let i = 0; i < 5; i++) {
            status(
                await f.request(HttpRequest.POST('/api/oauth/register', 'not json', { 'content-type': 'application/json' })),
                400,
                'junk registration'
            );
        }
        const ok = { redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' };
        status(await register(f, ok), 201, 'first valid after junk');
        status(await register(f, ok), 201, 'second valid');
        status(await register(f, ok), 429, 'global cap reached by successful registrations only');
    } finally {
        globalConfig.OAUTH_DCR_MAX_PER_HOUR = originalGlobal;
        await resetRateLimits();
    }
    console.log('  PASS');

    console.log('\nTest: registration - per-IP rate limit returns 429 with Retry-After');
    const config = f.app.config as unknown as { OAUTH_DCR_MAX_PER_IP_PER_HOUR: number };
    const original = config.OAUTH_DCR_MAX_PER_IP_PER_HOUR;
    await resetRateLimits();
    config.OAUTH_DCR_MAX_PER_IP_PER_HOUR = 2;
    try {
        const ok = { redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' };
        status(await register(f, ok), 201, 'first');
        status(await register(f, ok), 201, 'second');
        const limited = await register(f, ok);
        status(limited, 429, 'third is limited');
        check(Number(header(limited, 'retry-after')) > 0, 'Retry-After is set');
    } finally {
        config.OAUTH_DCR_MAX_PER_IP_PER_HOUR = original;
        await resetRateLimits();
    }
    console.log('  PASS');
}

// -------------------------------------------------------------------------------------------------------- authorize

async function testAuthorize(ctx: Ctx) {
    const f = ctx.f;
    const client = await registerClient(f, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:1234/callback'] });

    console.log('\nTest: authorize - untrusted client or redirect goes to our own error page, never to the client');
    const errorReason = async (query: Record<string, string>, reason: string, label: string) => {
        const r = await authorizeGet(f, query);
        status(r, 302, label);
        const loc = new URL(header(r, 'location')!);
        eq(`${loc.origin}${loc.pathname}`, `${ISSUER}/oauth/error`, `${label} destination`);
        eq(loc.searchParams.get('reason'), reason, `${label} reason`);
        eq(header(r, 'referrer-policy'), 'no-referrer', `${label} referrer policy`);
    };
    await errorReason(authorizeQuery(client, { extra: { client_id: crypto.randomUUID() } }), 'invalid_client', 'unknown client');
    await errorReason(authorizeQuery(client, { extra: { client_id: 'not-a-uuid' } }), 'invalid_client', 'malformed client');
    await errorReason({ ...authorizeQuery(client), client_id: '' }, 'invalid_client', 'empty client');
    await errorReason(authorizeQuery(client, { redirectUri: 'https://evil.example/cb' }), 'invalid_redirect_uri', 'foreign redirect');
    await errorReason(
        authorizeQuery(client, { redirectUri: 'https://claude.ai/api/mcp/auth_callback/' }),
        'invalid_redirect_uri',
        'redirect differing by a slash'
    );
    await errorReason(
        authorizeQuery(client, { redirectUri: 'https://claude.ai:444/api/mcp/auth_callback' }),
        'invalid_redirect_uri',
        'redirect differing by port'
    );
    const noRedirect = authorizeQuery(client);
    delete (noRedirect as Record<string, string | undefined>).redirect_uri;
    await errorReason(noRedirect, 'invalid_redirect_uri', 'missing redirect');
    const dup = await f.request(
        HttpRequest.GET(`/api/oauth/authorize?${new URLSearchParams(authorizeQuery(client)).toString()}&client_id=${crypto.randomUUID()}`)
    );
    status(dup, 302, 'duplicate client_id');
    eq(new URL(header(dup, 'location')!).searchParams.get('reason'), 'invalid_request', 'duplicate client_id goes to the error page');
    console.log('  PASS');

    console.log('\nTest: authorize - request problems after the redirect is trusted go to the client with state and iss');
    const clientError = async (query: Record<string, string>, code: string, label: string, expectState = true) => {
        const r = await authorizeGet(f, query);
        status(r, 302, label);
        const loc = new URL(header(r, 'location')!);
        eq(loc.origin + loc.pathname, 'https://claude.ai/api/mcp/auth_callback', `${label} goes to the registered redirect`);
        eq(loc.searchParams.get('error'), code, `${label} error`);
        eq(loc.searchParams.get('iss'), ISSUER, `${label} iss`);
        if (expectState) eq(loc.searchParams.get('state'), query.state, `${label} state`);
        else check(!loc.searchParams.has('state'), `${label} omits state`);
        check(!loc.searchParams.has('code'), `${label} carries no code`);
    };
    const base = authorizeQuery(client, { state: 'abc' });
    const noChallenge = { ...base } as Record<string, string | undefined>;
    delete noChallenge.code_challenge;
    await clientError(noChallenge as Record<string, string>, 'invalid_request', 'missing PKCE');
    await clientError({ ...base, code_challenge_method: 'plain' }, 'invalid_request', 'plain PKCE');
    const noMethod = { ...base } as Record<string, string | undefined>;
    delete noMethod.code_challenge_method;
    await clientError(noMethod as Record<string, string>, 'invalid_request', 'absent method (plain by default)');
    await clientError({ ...base, code_challenge: 'short' }, 'invalid_request', 'malformed challenge');
    await clientError({ ...base, response_type: 'token' }, 'unsupported_response_type', 'implicit flow');
    await clientError({ ...base, resource: 'https://evil.example/api/mcp' }, 'invalid_target', 'foreign resource');
    await clientError({ ...base, resource: 'https://pixelci.test/api/ext' }, 'invalid_target', 'other resource path');
    await clientError({ ...base, state: 's'.repeat(5000) }, 'invalid_request', 'oversized state', false);
    const twoResources = await f.request(
        HttpRequest.GET(
            `/api/oauth/authorize?${new URLSearchParams(base).toString()}&resource=${encodeURIComponent(RESOURCE)}&resource=${encodeURIComponent(RESOURCE)}`
        )
    );
    status(twoResources, 302, 'two resources');
    eq(new URL(header(twoResources, 'location')!).searchParams.get('error'), 'invalid_target', 'two resources rejected');
    console.log('  PASS');

    console.log('\nTest: authorize - accepted forms');
    await startConsent(f, client);
    await startConsent(f, client, { extra: { resource: RESOURCE } });
    await startConsent(f, client, { extra: { resource: `${ISSUER}/` } });
    await startConsent(f, client, { extra: { scope: 'whatever mcp:read admin' } });
    // loopback: any port, same path
    await startConsent(f, client, { redirectUri: 'http://127.0.0.1:55555/callback' });
    const wrongLoopback = await authorizeGet(f, authorizeQuery(client, { redirectUri: 'http://127.0.0.1:55555/other' }));
    eq(new URL(header(wrongLoopback, 'location')!).pathname, '/oauth/error', 'loopback with a different path is not accepted');
    const stored = await OAuthAuthorizationEntity.query().filter({ clientId: client.id }).find();
    check(
        stored.every(a => a.scope === 'mcp:read' && a.resource === RESOURCE),
        'scope and resource are canonical whatever was requested'
    );
    console.log('  PASS');

    console.log('\nTest: authorize - rate limit sends the user to the error page');
    await resetRateLimits();
    const first = await authorizeGet(f, authorizeQuery(client));
    status(first, 302, 'warm up');
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) {
        const r = await authorizeGet(f, authorizeQuery(client));
        const loc = new URL(header(r, 'location')!);
        if (loc.pathname === '/oauth/error') {
            eq(loc.searchParams.get('reason'), 'rate_limited', 'rate limited reason');
            limited = true;
        }
    }
    check(limited, 'authorize is rate limited');
    await resetRateLimits();
    console.log('  PASS');
}

// --------------------------------------------------------------------------------------------------------- consent

async function testConsent(ctx: Ctx) {
    const f = ctx.f;
    const client = await registerClient(f, { client_name: 'Consent Client', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });

    console.log('\nTest: consent - requires a session; view shows who is asking and where the user goes back to');
    const id = await startConsent(f, client, { state: 'consent-state' });
    status(await f.request(HttpRequest.GET(`/api/connected-apps/requests?request=${id}`)), 401, 'no session');
    // The session cookie authenticates, but approving needs the browser to say the request comes from PixelCI's own page.
    const cookie = `__Host-pixelci_session=${ctx.jwt[USER_ID]}`;
    const approveWithCookie = (headers: Record<string, string>) => {
        const req = HttpRequest.POST('/api/connected-apps/requests/approve').json({ request: id }).header('cookie', cookie);
        for (const [name, value] of Object.entries(headers)) req.header(name, value);
        return f.request(req);
    };
    status(
        await f.request(HttpRequest.POST('/api/connected-apps/requests/approve').json({ request: id }).header('cookie', `jwt=${ctx.jwt[USER_ID]}`)),
        401,
        'approve with only the TSF jwt cookie'
    );
    status(await approveWithCookie({}), 403, 'approve with the cookie and no Origin');
    status(await approveWithCookie({ origin: 'https://evil.example' }), 403, 'approve with the cookie and a foreign Origin');
    status(await approveWithCookie({ 'sec-fetch-site': 'cross-site' }), 403, 'approve with the cookie, cross-site');
    const view = await f.request(userReq(ctx, USER_ID, HttpRequest.GET(`/api/connected-apps/requests?request=${id}`)));
    status(view, 200, 'view');
    const viewBody = view.json as Record<string, unknown> & { scopes: { name: string }[] };
    eq(viewBody.clientName, 'Consent Client', 'client name');
    eq(viewBody.redirectDisplay, 'claude.ai', 'redirect display');
    eq(viewBody.redirectKind, 'web', 'redirect kind');
    eq(viewBody.scopes[0].name, 'mcp:read', 'scope');
    check(typeof viewBody.expiresAt === 'string', 'expiry is returned');
    // viewing does not bind the request to anyone: another user can open it (switch account)
    status(await f.request(userReq(ctx, USER_OTHER_ID, HttpRequest.GET(`/api/connected-apps/requests?request=${id}`))), 200, 'view as another user');
    status(
        await f.request(userReq(ctx, USER_ID, HttpRequest.GET(`/api/connected-apps/requests?request=${crypto.randomUUID()}`))),
        404,
        'unknown request'
    );
    status(await f.request(userReq(ctx, USER_ID, HttpRequest.GET('/api/connected-apps/requests?request=not-a-uuid'))), 404, 'malformed request id');
    const loopbackClient = await registerClient(f, { redirect_uris: ['http://127.0.0.1:1234/callback'] });
    const loopId = await startConsent(f, loopbackClient, { redirectUri: 'http://127.0.0.1:4321/callback' });
    const loopView = await f.request(userReq(ctx, USER_ID, HttpRequest.GET(`/api/connected-apps/requests?request=${loopId}`)));
    eq((loopView.json as { redirectKind: string }).redirectKind, 'loopback', 'loopback kind');
    eq((loopView.json as { redirectDisplay: string }).redirectDisplay, 'an app on this computer (127.0.0.1:4321)', 'loopback display');
    // a first-party browser request (the cookie plus the issuer as Origin) is accepted; this consumes the loopback request
    status(
        await f.request(
            HttpRequest.POST('/api/connected-apps/requests/approve').json({ request: loopId }).header('cookie', cookie).header('origin', ISSUER)
        ),
        200,
        'approve with the cookie and the issuer Origin'
    );
    console.log('  PASS');

    console.log('\nTest: consent - approve is single-use and returns the code with state and iss');
    const approved = await approve(ctx, id);
    const { code, url } = codeFrom(approved);
    eq(url.origin + url.pathname, 'https://claude.ai/api/mcp/auth_callback', 'redirects to the registered URI');
    eq(url.searchParams.get('state'), 'consent-state', 'state is returned');
    eq(url.searchParams.get('iss'), ISSUER, 'iss is returned');
    check(code.startsWith('pixelci_ac_'), 'code is prefixed');
    const row = await OAuthAuthorizationEntity.query().filter({ id }).findOne();
    eq(row.codeHash, sha256(code), 'code is stored only as its hash');
    eq(row.status, 'approved', 'status approved');
    eq(row.userId, USER_ID, 'bound to the approving user');
    check(row.expiresAt.getTime() - Date.now() <= 2 * 60_000 + 1000, 'code lives about 2 minutes');
    status(await approve(ctx, id), 410, 'second approve');
    status(await f.request(userReq(ctx, USER_ID, HttpRequest.GET(`/api/connected-apps/requests?request=${id}`))), 410, 'view after approve');
    console.log('  PASS');

    console.log('\nTest: consent - deny returns access_denied with state and iss');
    const denyId = await startConsent(f, client, { state: 'deny-state' });
    const denied = await f.request(userReq(ctx, USER_ID, HttpRequest.POST('/api/connected-apps/requests/deny').json({ request: denyId })));
    status(denied, 200, 'deny');
    const denyUrl = new URL((denied.json as { redirectUrl: string }).redirectUrl);
    eq(denyUrl.searchParams.get('error'), 'access_denied', 'deny error');
    eq(denyUrl.searchParams.get('state'), 'deny-state', 'deny state');
    eq(denyUrl.searchParams.get('iss'), ISSUER, 'deny iss');
    check(!denyUrl.searchParams.has('code'), 'deny carries no code');
    status(await approve(ctx, denyId), 410, 'approve after deny');
    status(
        await f.request(userReq(ctx, USER_ID, HttpRequest.POST('/api/connected-apps/requests/deny').json({ request: denyId }))),
        410,
        'deny twice'
    );
    console.log('  PASS');

    console.log('\nTest: consent - expired request is gone');
    const expiredId = await startConsent(f, client);
    await OAuthAuthorizationEntity.query()
        .filter({ id: expiredId })
        .patchOne({ expiresAt: new Date(Date.now() - 1000) });
    status(await f.request(userReq(ctx, USER_ID, HttpRequest.GET(`/api/connected-apps/requests?request=${expiredId}`))), 410, 'view expired');
    status(await approve(ctx, expiredId), 410, 'approve expired');
    console.log('  PASS');

    console.log('\nTest: consent - a dead VCS sign-in (invalid_grant) is a 401 so the SPA signs in again; an unreachable provider is not');
    const eveReq = await startConsent(f, client);
    gitlabMode = 'invalid_grant';
    try {
        status(
            await f.request(userReq(ctx, USER_EXPIRED_ID, HttpRequest.GET(`/api/connected-apps/requests?request=${eveReq}`))),
            401,
            'view with expired provider session'
        );
        status(await approve(ctx, eveReq, USER_EXPIRED_ID), 401, 'approve with expired provider session');
    } finally {
        gitlabMode = 'ok';
    }
    gitlabMode = 'server_error';
    try {
        status(
            await f.request(userReq(ctx, USER_EXPIRED_ID, HttpRequest.GET(`/api/connected-apps/requests?request=${eveReq}`))),
            200,
            'view while provider is down'
        );
    } finally {
        gitlabMode = 'ok';
    }
    console.log('  PASS');
}

// ---------------------------------------------------------------------------------------------------- token exchange

async function testTokenExchange(ctx: Ctx) {
    const f = ctx.f;
    const client = await registerClient(f, { client_name: 'Exchange Client' });

    console.log('\nTest: token - happy path, no-store, tokens stored only as hashes');
    const { code, verifier, redirectUri } = await getCode(ctx, client);
    const ok = await exchange(ctx, client, code, verifier, redirectUri);
    status(ok, 200, 'exchange');
    eq(header(ok, 'cache-control'), 'no-store', 'token no-store');
    eq(header(ok, 'pragma'), 'no-cache', 'token pragma');
    const tokens = ok.json as ITokens;
    eq(tokens.token_type, 'Bearer', 'token type');
    eq(tokens.expires_in, 3600, 'expires_in');
    eq(tokens.scope, 'mcp:read', 'scope');
    check(tokens.access_token.startsWith('pixelci_at_') && tokens.refresh_token.startsWith('pixelci_rt_'), 'tokens are prefixed');
    const rows = await OAuthTokenEntity.query().find();
    const dump =
        JSON.stringify(rows) + JSON.stringify(await OAuthAuthorizationEntity.query().find()) + JSON.stringify(await OAuthGrantEntity.query().find());
    check(
        !dump.includes(tokens.access_token) && !dump.includes(tokens.refresh_token) && !dump.includes(code),
        'no plaintext token or code is stored'
    );
    check(
        rows.some(r => r.tokenHash === sha256(tokens.access_token) && r.kind === 'access'),
        'access token hash stored'
    );
    check(
        rows.some(r => r.tokenHash === sha256(tokens.refresh_token) && r.kind === 'refresh'),
        'refresh token hash stored'
    );
    const grant = await grantOf(await grantIdOfRefresh(tokens.refresh_token));
    eq(grant.userId, USER_ID, 'grant belongs to the approving user');
    eq(grant.resource, RESOURCE, 'grant bound to the canonical resource');
    check(grant.expiresAt.getTime() - Date.now() > 89 * 86_400_000, 'grant has a 90 day cap');
    const clientRow = await OAuthClientEntity.query().filter({ id: client.id }).findOne();
    check(clientRow.lastUsedAt, 'client lastUsedAt is set');
    status(await mcpPost(ctx, tokens.access_token), 200, 'the access token works at MCP');
    console.log('  PASS');

    console.log('\nTest: token - replay of a redeemed code revokes the grant it produced');
    const replay = await exchange(ctx, client, code, verifier, redirectUri);
    status(replay, 400, 'replay');
    eq((replay.json as { error: string }).error, 'invalid_grant', 'replay error');
    status(await mcpPost(ctx, tokens.access_token), 401, 'access token after code replay');
    eq((await grantOf(grant.id)).revokedReason, 'code_reuse', 'revocation reason');
    status(await refresh(ctx, client, tokens.refresh_token), 400, 'refresh token after code replay');
    console.log('  PASS');

    console.log('\nTest: token - a wrong verifier burns the code (single attempt)');
    const attempt = await getCode(ctx, client);
    const wrong = await exchange(ctx, client, attempt.code, verifierFor(), attempt.redirectUri);
    status(wrong, 400, 'wrong verifier');
    eq((wrong.json as { error: string }).error, 'invalid_grant', 'wrong verifier error');
    const retry = await exchange(ctx, client, attempt.code, attempt.verifier, attempt.redirectUri);
    status(retry, 400, 'correct verifier after the burn');
    eq((retry.json as { error: string }).error, 'invalid_grant', 'burned code error');
    console.log('  PASS');

    console.log('\nTest: token - wrong redirect_uri, wrong client, expired code and malformed input are rejected');
    const redirectClient = await registerClient(f, { redirect_uris: ['https://claude.ai/cb', 'https://claude.ai/cb2'] });
    const a = await getCode(ctx, redirectClient, { redirectUri: 'https://claude.ai/cb' });
    const wrongRedirect = await exchange(ctx, redirectClient, a.code, a.verifier, 'https://claude.ai/cb2');
    eq((wrongRedirect.json as { error: string }).error, 'invalid_grant', 'wrong redirect_uri');
    status(await exchange(ctx, redirectClient, a.code, a.verifier, 'https://claude.ai/cb'), 400, 'code is burned after a redirect mismatch');

    const other = await registerClient(f);
    const b = await getCode(ctx, client);
    const wrongClient = await exchange(ctx, other, b.code, b.verifier, b.redirectUri);
    status(wrongClient, 400, 'code presented by another client');
    eq((wrongClient.json as { error: string }).error, 'invalid_grant', 'wrong client');

    const c = await getCode(ctx, client);
    await OAuthAuthorizationEntity.query()
        .filter({ id: c.requestId })
        .patchOne({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await exchange(ctx, client, c.code, c.verifier, c.redirectUri);
    eq((expired.json as { error: string }).error, 'invalid_grant', 'expired code');

    const d = await getCode(ctx, client);
    const badVerifier = await exchange(ctx, client, d.code, 'too-short', d.redirectUri);
    eq((badVerifier.json as { error: string }).error, 'invalid_request', 'malformed verifier');
    const unknownCode = await exchange(ctx, client, 'pixelci_ac_unknown', d.verifier, d.redirectUri);
    eq((unknownCode.json as { error: string }).error, 'invalid_grant', 'unknown code');
    const foreignCode = await exchange(ctx, client, 'some-other-code', d.verifier, d.redirectUri);
    eq((foreignCode.json as { error: string }).error, 'invalid_grant', 'code without the prefix');
    // the valid code was not burned by the malformed attempts above
    status(await exchange(ctx, client, d.code, d.verifier, d.redirectUri), 200, 'code still valid after malformed attempts');
    console.log('  PASS');

    console.log('\nTest: token - resource must match the authorization request');
    const e = await getCode(ctx, client, { extra: { resource: RESOURCE } });
    const badResource = await ctx.f.request(
        tokenReq(client, {
            grant_type: 'authorization_code',
            code: e.code,
            code_verifier: e.verifier,
            redirect_uri: e.redirectUri,
            resource: 'https://pixelci.test/api/ext'
        })
    );
    eq((badResource.json as { error: string }).error, 'invalid_target', 'resource mismatch');
    const g = await getCode(ctx, client);
    const goodResource = await ctx.f.request(
        tokenReq(client, {
            grant_type: 'authorization_code',
            code: g.code,
            code_verifier: g.verifier,
            redirect_uri: g.redirectUri,
            resource: RESOURCE
        })
    );
    status(goodResource, 200, 'matching resource');
    console.log('  PASS');

    console.log('\nTest: token - request validation');
    const form = (params: Record<string, string> | string, headers: Record<string, string> = {}) =>
        ctx.f.request(formReq('/api/oauth/token', params, headers));
    const jsonBody = await ctx.f.request(HttpRequest.POST('/api/oauth/token').json({ grant_type: 'refresh_token' }));
    status(jsonBody, 400, 'json body');
    eq((jsonBody.json as { error: string }).error, 'invalid_request', 'json body error');
    const dup = await form(`client_id=${client.id}&grant_type=refresh_token&refresh_token=a&refresh_token=b`);
    status(dup, 400, 'duplicate parameter');
    eq((dup.json as { error: string }).error, 'invalid_request', 'duplicate parameter error');
    const unsupported = await form({ client_id: client.id, grant_type: 'client_credentials' });
    status(unsupported, 400, 'client_credentials');
    eq((unsupported.json as { error: string }).error, 'unsupported_grant_type', 'unsupported grant type');
    const missing = await form({ client_id: client.id });
    eq((missing.json as { error: string }).error, 'invalid_request', 'missing grant_type');
    const missingCode = await form({ client_id: client.id, grant_type: 'authorization_code', redirect_uri: 'https://claude.ai/cb' });
    eq((missingCode.json as { error: string }).error, 'invalid_request', 'missing code');
    const unknownClient = await form({ client_id: crypto.randomUUID(), grant_type: 'refresh_token', refresh_token: 'x' });
    status(unknownClient, 401, 'unknown client');
    eq((unknownClient.json as { error: string }).error, 'invalid_client', 'unknown client error');
    const tooBig = await form('grant_type=refresh_token&x=' + 'a'.repeat(20_000));
    check(tooBig.statusCode === 400 || tooBig.statusCode === 413, `oversized token request rejected (got ${tooBig.statusCode})`);
    console.log('  PASS');
}

async function testClientAuthentication(ctx: Ctx) {
    const f = ctx.f;
    console.log('\nTest: client authentication - post, basic, wrong and missing secrets; public clients with a secret');
    const post = await registerClient(f, { token_endpoint_auth_method: 'client_secret_post' });
    const bas = await registerClient(f, { token_endpoint_auth_method: 'client_secret_basic' });
    check(post.secret && bas.secret, 'secrets issued');
    const refreshParams = { grant_type: 'refresh_token', refresh_token: 'pixelci_rt_unknown' };
    const code = async (r: Response) => (r.json as { error: string }).error;

    // post: secret in the body
    const postOk = await f.request(formReq('/api/oauth/token', { ...refreshParams, client_id: post.id, client_secret: post.secret! }));
    eq(await code(postOk), 'invalid_grant', 'client_secret_post authenticates (then fails on the grant)');
    const postMissing = await f.request(formReq('/api/oauth/token', { ...refreshParams, client_id: post.id }));
    status(postMissing, 401, 'secret client without a secret');
    eq(await code(postMissing), 'invalid_client', 'missing secret');
    check(!header(postMissing, 'www-authenticate'), 'no Basic challenge when Basic was not attempted');
    const postWrong = await f.request(formReq('/api/oauth/token', { ...refreshParams, client_id: post.id, client_secret: 'pixelci_cs_wrong' }));
    status(postWrong, 401, 'wrong secret');

    // basic
    const basicOk = await f.request(formReq('/api/oauth/token', refreshParams, { authorization: basic(bas.id, bas.secret!) }));
    eq(await code(basicOk), 'invalid_grant', 'Basic authenticates');
    const basicWrong = await f.request(formReq('/api/oauth/token', refreshParams, { authorization: basic(bas.id, 'pixelci_cs_wrong') }));
    status(basicWrong, 401, 'wrong Basic secret');
    eq(header(basicWrong, 'www-authenticate'), 'Basic realm="PixelCI"', 'Basic challenge');
    const basicMalformed = await f.request(formReq('/api/oauth/token', refreshParams, { authorization: 'Basic !!!' }));
    status(basicMalformed, 401, 'malformed Basic');
    const both = await f.request(
        formReq('/api/oauth/token', { ...refreshParams, client_secret: bas.secret! }, { authorization: basic(bas.id, bas.secret!) })
    );
    status(both, 400, 'Basic and body secret together');
    eq(await code(both), 'invalid_request', 'both methods');
    const mismatch = await f.request(
        formReq('/api/oauth/token', { ...refreshParams, client_id: post.id }, { authorization: basic(bas.id, bas.secret!) })
    );
    status(mismatch, 401, 'client_id differing from the Basic id');
    // a secret of one client never authenticates another
    const crossed = await f.request(formReq('/api/oauth/token', { ...refreshParams, client_id: post.id, client_secret: bas.secret! }));
    status(crossed, 401, "another client's secret");

    // public client sending a secret is refused
    const pub = await registerClient(f);
    const pubSecret = await f.request(formReq('/api/oauth/token', { ...refreshParams, client_id: pub.id, client_secret: 'anything' }));
    status(pubSecret, 401, 'public client presenting a secret');
    const pubEmpty = await f.request(formReq('/api/oauth/token', { ...refreshParams, client_id: pub.id, client_secret: '' }));
    eq(await code(pubEmpty), 'invalid_grant', 'public client with an empty secret authenticates');

    // a confidential client completes the whole flow with Basic
    const tokens = await fullFlow(ctx, bas);
    check(tokens.access_token, 'confidential client got tokens');
    console.log('  PASS');
}

// ---------------------------------------------------------------------------------------------------------- MCP

async function testMcpResource(ctx: Ctx) {
    const f = ctx.f;
    const client = await registerClient(f, { client_name: 'MCP Client' });

    console.log("\nTest: mcp - an OAuth token acts as its user: only accessible apps, and only the user's VCS token reaches the provider");
    const tokens = await fullFlow(ctx, client);
    gitlabSeen.length = 0;
    const apps = await listApps(ctx, tokens.access_token);
    eq(JSON.stringify(apps), JSON.stringify([APP_ID]), 'list_apps shows only the accessible app');
    check(
        gitlabSeen.some(s => s === `Bearer ${FRESH_VCS_ACCESS}`),
        "the user's VCS token was used for the access check"
    );
    check(!gitlabSeen.some(s => s.includes('pixelci_')), 'no pixelci_* credential reached the provider');
    const init = await mcpPost(ctx, tokens.access_token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } }
    });
    status(init, 200, 'initialize with an OAuth token');
    // X-PixelCI-Vcs-Id is ignored for OAuth tokens
    status(await mcpPost(ctx, tokens.access_token, undefined, { 'x-pixelci-vcs-id': crypto.randomUUID() }), 200, 'vcs id header ignored');
    const grant = await grantOf(await grantIdOfRefresh(tokens.refresh_token));
    check(grant.lastUsedAt, 'use bumps the grant lastUsedAt');
    console.log('  PASS');

    console.log('\nTest: mcp - tokens that are not valid access tokens are refused with an invalid_token challenge and never forwarded');
    const expectInvalid = async (token: string, label: string) => {
        gitlabSeen.length = 0;
        const r = await mcpPost(ctx, token);
        status(r, 401, label);
        const challenge = header(r, 'www-authenticate')!;
        check(challenge.startsWith(`Bearer ${CHALLENGE_BASE}, error="invalid_token"`), `${label}: challenge carries invalid_token (${challenge})`);
        eq((r.json as { error: string }).error, 'invalid_token', `${label} body`);
        check(!gitlabSeen.some(s => s.includes(token)), `${label}: token never reached the provider`);
    };
    await expectInvalid('pixelci_at_doesnotexist', 'unknown access token');
    await expectInvalid(tokens.refresh_token, 'refresh token as a bearer');
    await expectInvalid('pixelci_ac_something', 'authorization code as a bearer');
    await expectInvalid('pixelci_cs_something', 'client secret as a bearer');
    const foreignResource = await seedGrant(client, USER_ID, { resource: 'https://other.example/api/mcp' });
    await expectInvalid(foreignResource.access, 'token bound to another resource');
    const expiredAccess = await seedGrant(client, USER_ID, { accessExpiresAt: new Date(Date.now() - 1000) });
    await expectInvalid(expiredAccess.access, 'expired access token');
    const expiredGrant = await seedGrant(client, USER_ID, { grantExpiresAt: new Date(Date.now() - 1000) });
    await expectInvalid(expiredGrant.access, 'token of an expired grant');
    await expectInvalid(await JWT.generate({ subject: USER_ID }), 'UI session JWT on MCP');
    const noScope = await seedGrant(client, USER_ID, { scope: 'other:scope' });
    const forbidden = await mcpPost(ctx, noScope.access);
    status(forbidden, 403, 'missing scope');
    check(header(forbidden, 'www-authenticate')!.includes('error="insufficient_scope"'), 'insufficient_scope challenge');
    console.log('  PASS');

    console.log('\nTest: mcp - PATs still work on /api/mcp; OAuth tokens and JWTs are not accepted by /api/ext and never forwarded');
    const pat = await mcpPost(ctx, VALID_PAT, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_apps', arguments: {} } });
    status(pat, 200, 'PAT on mcp');
    status(await f.request(HttpRequest.GET('/api/ext/apps').header('authorization', `Bearer ${VALID_PAT}`)), 200, 'PAT on ext');
    for (const bad of [tokens.access_token, tokens.refresh_token, await JWT.generate({ subject: USER_ID })]) {
        gitlabSeen.length = 0;
        status(await f.request(HttpRequest.GET('/api/ext/apps').header('authorization', `Bearer ${bad}`)), 401, '/api/ext with a non-PAT token');
        check(!gitlabSeen.some(s => s.includes(bad)), '/api/ext never forwards a non-PAT token');
    }
    console.log('  PASS');

    console.log('\nTest: mcp - the grant lives only as long as the VCS sign-in');
    const eve = await seedGrant(client, USER_EXPIRED_ID);
    gitlabMode = 'invalid_grant';
    try {
        const dead = await mcpPost(ctx, eve.access);
        status(dead, 401, 'dead provider session');
        check(header(dead, 'www-authenticate')!.includes('error="invalid_token"'), 'dead session is an invalid_token challenge');
    } finally {
        gitlabMode = 'ok';
    }
    gitlabMode = 'server_error';
    try {
        const down = await mcpPost(ctx, eve.access);
        status(down, 200, 'provider unreachable is not fatal');
    } finally {
        gitlabMode = 'ok';
    }
    console.log('  PASS');
}

// -------------------------------------------------------------------------------------------------------- refresh

async function testRefresh(ctx: Ctx) {
    const f = ctx.f;
    const client = await registerClient(f, { client_name: 'Refresh Client' });

    console.log('\nTest: refresh - rotation, and a retry within the leeway gets a fresh pair');
    const first = await fullFlow(ctx, client);
    const second = await refresh(ctx, client, first.refresh_token);
    status(second, 200, 'rotate');
    eq(header(second, 'cache-control'), 'no-store', 'refresh no-store');
    const rotated = second.json as ITokens;
    check(rotated.access_token !== first.access_token && rotated.refresh_token !== first.refresh_token, 'new pair issued');
    status(await mcpPost(ctx, rotated.access_token), 200, 'rotated access token works');
    const grantId = await grantIdOfRefresh(first.refresh_token);
    const retry = await refresh(ctx, client, first.refresh_token);
    status(retry, 200, 'retry within the leeway');
    status(await mcpPost(ctx, (retry.json as ITokens).access_token), 200, 'retry pair works');
    eq((await grantOf(grantId)).revokedAt, null, 'grace path does not revoke');
    console.log('  PASS');

    console.log('\nTest: refresh - a token replayed within the leeway cannot fork the grant');
    // A separate client: a new grant for the same client and user would supersede the grant the next test checks.
    const forkClient = await registerClient(f, { client_name: 'Refresh Fork Client' });
    const forkStart = await fullFlow(ctx, forkClient);
    const branchA = await refresh(ctx, forkClient, forkStart.refresh_token);
    status(branchA, 200, 'legitimate rotation');
    const branchB = await refresh(ctx, forkClient, forkStart.refresh_token);
    status(branchB, 200, 'replay within the leeway');
    const forkGrantId = await grantIdOfRefresh((branchB.json as ITokens).refresh_token);
    const loser = await refresh(ctx, forkClient, (branchA.json as ITokens).refresh_token);
    status(loser, 400, 'the superseded branch cannot refresh');
    eq((await grantOf(forkGrantId)).revokedReason, 'refresh_reuse', 'presenting the superseded branch revokes the grant');
    console.log('  PASS');

    console.log('\nTest: refresh - reuse after the leeway revokes the whole grant');
    await OAuthTokenEntity.query()
        .filter({ tokenHash: sha256(first.refresh_token) })
        .patchMany({ rotatedAt: new Date(Date.now() - 60_000) });
    const reuse = await refresh(ctx, client, first.refresh_token);
    status(reuse, 400, 'reuse');
    eq((reuse.json as { error: string }).error, 'invalid_grant', 'reuse error');
    eq((await grantOf(grantId)).revokedReason, 'refresh_reuse', 'revocation reason');
    status(await mcpPost(ctx, rotated.access_token), 401, 'access token after reuse');
    status(await refresh(ctx, client, rotated.refresh_token), 400, 'the legitimate refresh token is dead too');
    check((await OAuthTokenEntity.query().filter({ grantId }).count()) === 0, 'the grant tokens are deleted');
    console.log('  PASS');

    console.log('\nTest: refresh - client binding, scope, resource and expiry');
    const t = await fullFlow(ctx, client);
    const otherClient = await registerClient(f);
    const stolen = await refresh(ctx, otherClient, t.refresh_token);
    status(stolen, 400, "another client's refresh token");
    eq((stolen.json as { error: string }).error, 'invalid_grant', 'another client');
    eq((await grantOf(await grantIdOfRefresh(t.refresh_token))).revokedAt, null, 'a foreign attempt does not revoke the grant');
    eq(((await refresh(ctx, client, t.refresh_token, { scope: 'mcp:read admin' })).json as { error: string }).error, 'invalid_scope', 'wider scope');
    eq(
        ((await refresh(ctx, client, t.refresh_token, { resource: 'https://pixelci.test/api/ext' })).json as { error: string }).error,
        'invalid_target',
        'other resource'
    );
    status(await refresh(ctx, client, t.refresh_token, { scope: 'mcp:read', resource: RESOURCE }), 200, 'same scope and resource');
    const idle = await seedGrant(client, USER_ID);
    await OAuthTokenEntity.query()
        .filter({ tokenHash: sha256(idle.refresh) })
        .patchMany({ expiresAt: new Date(Date.now() - 1000) });
    status(await refresh(ctx, client, idle.refresh), 400, 'idle-expired refresh token');
    const capped = await seedGrant(client, USER_ID, { grantExpiresAt: new Date(Date.now() - 1000) });
    status(await refresh(ctx, client, capped.refresh), 400, 'refresh past the grant cap');
    status(await refresh(ctx, client, 'pixelci_rt_unknown'), 400, 'unknown refresh token');
    status(await refresh(ctx, client, t.access_token), 400, 'an access token is not a refresh token');
    console.log('  PASS');

    console.log('\nTest: refresh - the VCS sign-in: invalid_grant revokes the grant, an unreachable provider does not');
    const dead = await seedGrant(client, USER_EXPIRED_ID);
    gitlabMode = 'invalid_grant';
    try {
        const r = await refresh(ctx, client, dead.refresh);
        status(r, 400, 'dead provider session');
        eq((r.json as { error: string }).error, 'invalid_grant', 'dead session error');
        check(/sign-in has expired/i.test((r.json as { error_description: string }).error_description), 'description tells the user to reconnect');
        eq((await grantOf(dead.grantId)).revokedReason, 'vcs_session', 'revocation reason');
    } finally {
        gitlabMode = 'ok';
    }
    const flaky = await seedGrant(client, USER_EXPIRED_ID);
    gitlabMode = 'server_error';
    try {
        status(await refresh(ctx, client, flaky.refresh), 200, 'provider 500 still issues tokens');
    } finally {
        gitlabMode = 'ok';
    }
    const renewed = await seedGrant(client, USER_EXPIRED_ID);
    status(await refresh(ctx, client, renewed.refresh), 200, 'an expired session that renews is fine');
    console.log('  PASS');
}

// -------------------------------------------------------------------------------------- revoke and connected apps

async function testRevocationAndConnectedApps(ctx: Ctx) {
    const f = ctx.f;
    const client = await registerClient(f, { client_name: 'Revoke Client' });
    const other = await registerClient(f, { client_name: 'Someone Else' });

    console.log('\nTest: revoke - a refresh token revokes the grant; unknown and foreign tokens are ignored');
    const t = await fullFlow(ctx, client);
    const revokeReq = (c: IClient, params: Record<string, string>) => {
        const auth = clientAuth(c);
        return formReq('/api/oauth/revoke', { ...auth.body, ...params }, auth.headers);
    };
    const byOther = await f.request(revokeReq(other, { token: t.refresh_token }));
    status(byOther, 200, "revoking another client's token");
    status(await mcpPost(ctx, t.access_token), 200, 'another client cannot revoke this grant');
    status(await f.request(revokeReq(client, { token: 'pixelci_rt_unknown' })), 200, 'unknown token');
    status(await f.request(revokeReq(client, { token: 'garbage', token_type_hint: 'banana' })), 200, 'garbage token with an unknown hint');
    const missing = await f.request(revokeReq(client, {}));
    status(missing, 400, 'missing token');
    const unauth = await f.request(formReq('/api/oauth/revoke', { token: t.refresh_token, client_id: crypto.randomUUID() }));
    status(unauth, 401, 'unknown client');

    const accessOnly = await fullFlow(ctx, client);
    const rev1 = await f.request(revokeReq(client, { token: accessOnly.access_token, token_type_hint: 'access_token' }));
    status(rev1, 200, 'revoke access token');
    eq(rev1.bodyString, '', 'empty body');
    status(await mcpPost(ctx, accessOnly.access_token), 401, 'revoked access token');
    status(await refresh(ctx, client, accessOnly.refresh_token), 200, 'revoking an access token leaves the refresh token');

    const wholeGrant = await fullFlow(ctx, client);
    const wholeGrantId = await grantIdOfRefresh(wholeGrant.refresh_token);
    status(await f.request(revokeReq(client, { token: wholeGrant.refresh_token })), 200, 'revoke refresh token');
    status(await mcpPost(ctx, wholeGrant.access_token), 401, 'access token after the refresh token was revoked');
    status(await refresh(ctx, client, wholeGrant.refresh_token), 400, 'refresh after revoke');
    eq((await grantOf(wholeGrantId)).revokedReason, 'client_revoke', 'reason client_revoke');
    console.log('  PASS');

    console.log('\nTest: connected apps - listing, ownership and deletion');
    const mine = await fullFlow(ctx, other, { userId: USER_ID });
    const olgas = await fullFlow(ctx, client, { userId: USER_OTHER_ID });
    status(await f.request(HttpRequest.GET('/api/connected-apps')), 401, 'list without a session');
    const list = await f.request(userReq(ctx, USER_ID, HttpRequest.GET('/api/connected-apps')));
    status(list, 200, 'list');
    const apps = list.json as { id: string; clientName: string; redirectDisplay: string; createdAt: string }[];
    check(apps.length >= 1 && apps.every(a => a.clientName && a.redirectDisplay && a.createdAt), 'rows carry name, redirect and dates');
    check(
        apps.some(a => a.clientName === 'Someone Else'),
        'own grant is listed'
    );
    const myGrantId = await grantIdOfRefresh(mine.refresh_token);
    const olgaGrantId = await grantIdOfRefresh(olgas.refresh_token);
    check(
        apps.some(a => a.id === myGrantId),
        'own grant id listed'
    );
    check(!apps.some(a => a.id === olgaGrantId), "another user's grant is not listed");
    status(await f.request(userReq(ctx, USER_ID, HttpRequest.DELETE(`/api/connected-apps/${olgaGrantId}`))), 404, "another user's grant");
    status(await f.request(userReq(ctx, USER_ID, HttpRequest.DELETE('/api/connected-apps/not-a-uuid'))), 404, 'malformed grant id');
    status(await mcpPost(ctx, olgas.access_token), 200, "the other user's grant is untouched");
    const del = await f.request(userReq(ctx, USER_ID, HttpRequest.DELETE(`/api/connected-apps/${myGrantId}`)));
    status(del, 204, 'delete');
    status(await mcpPost(ctx, mine.access_token), 401, 'access token after deleting the connected app');
    status(await refresh(ctx, other, mine.refresh_token), 400, 'refresh token after deleting the connected app');
    eq((await grantOf(myGrantId)).revokedReason, 'user', 'revocation reason user');
    status(await f.request(userReq(ctx, USER_ID, HttpRequest.DELETE(`/api/connected-apps/${myGrantId}`))), 404, 'deleting twice');
    const after = await f.request(userReq(ctx, USER_ID, HttpRequest.GET('/api/connected-apps')));
    check(!(after.json as { id: string }[]).some(a => a.id === myGrantId), 'revoked grant disappears from the list');
    console.log('  PASS');
}

async function testSuperseded(ctx: Ctx) {
    console.log("\nTest: a new authorization replaces the same user's earlier grant for the same client");
    const client = await registerClient(ctx.f, { client_name: 'Superseding Client' });
    const first = await fullFlow(ctx, client);
    const second = await fullFlow(ctx, client);
    status(await mcpPost(ctx, first.access_token), 401, 'first access token after reauthorizing');
    status(await refresh(ctx, client, first.refresh_token), 400, 'first refresh token after reauthorizing');
    status(await mcpPost(ctx, second.access_token), 200, 'second access token');
    eq((await grantOf(await grantIdOfRefresh(second.refresh_token))).revokedAt, null, 'the new grant is live');
    const olga = await fullFlow(ctx, client, { userId: USER_OTHER_ID });
    status(await mcpPost(ctx, second.access_token), 200, "another user's authorization does not supersede");
    status(await mcpPost(ctx, olga.access_token), 200, "the other user's grant");
    console.log('  PASS');
}

async function testConcurrentRedemption(ctx: Ctx) {
    console.log('\nTest: two concurrent redemptions of one code: at most one succeeds and the grant does not survive a replay');
    const client = await registerClient(ctx.f, { client_name: 'Race Client' });
    const { code, verifier, redirectUri } = await getCode(ctx, client);
    const results = await Promise.all([exchange(ctx, client, code, verifier, redirectUri), exchange(ctx, client, code, verifier, redirectUri)]);
    const wins = results.filter(r => r.statusCode === 200);
    check(wins.length <= 1, `at most one redemption succeeds (got ${wins.length})`);
    check(
        results.some(r => r.statusCode === 400),
        'the loser is rejected'
    );
    // whichever raced, the code can never be redeemed again, and any grant it produced is revoked by the loser's replay handling
    status(await exchange(ctx, client, code, verifier, redirectUri), 400, 'a later redemption');
    if (wins.length === 1) status(await mcpPost(ctx, (wins[0].json as ITokens).access_token), 401, 'the winner is revoked once a replay is seen');
    console.log('  PASS');
}

// ---------------------------------------------------------------------------------------------------------- prune

async function testPrune(ctx: Ctx) {
    console.log('\nTest: prune job removes expired state and unused clients, and keeps live data');
    const f = ctx.f;
    const day = 86_400_000;
    const mkClient = (name: string, createdAt: Date, lastUsedAt: Date | null) =>
        createPersistedEntity(OAuthClientEntity, {
            id: crypto.randomUUID(),
            name,
            redirectUris: ['https://claude.ai/cb'],
            tokenEndpointAuthMethod: 'none',
            secretHash: null,
            createdAt,
            lastUsedAt,
            metadataUrl: null,
            metadataFetchedAt: null,
            metadataExpiresAt: null
        });
    const oldUnused = await mkClient('old unused', new Date(Date.now() - 8 * day), null);
    const freshUnused = await mkClient('fresh unused', new Date(Date.now() - 1 * day), null);
    const staleUsed = await mkClient('stale used', new Date(Date.now() - 200 * day), new Date(Date.now() - 100 * day));
    const recentlyUsed = await mkClient('recently used, no grants', new Date(Date.now() - 30 * day), new Date(Date.now() - 2 * day));
    const withGrant = await mkClient('has a grant', new Date(Date.now() - 30 * day), new Date(Date.now() - 100 * day));
    const withPending = await mkClient('has a live request', new Date(Date.now() - 30 * day), null);
    const asIClient = (c: OAuthClientEntity): IClient => ({ id: c.id, redirectUris: c.redirectUris });

    const liveGrant = await seedGrant(asIClient(withGrant), USER_ID);
    const oldRevoked = await seedGrant(asIClient(withGrant), USER_OTHER_ID);
    await OAuthGrantEntity.query()
        .filter({ id: oldRevoked.grantId })
        .patchOne({ revokedAt: new Date(Date.now() - 40 * day), revokedReason: 'user' });
    const expiredGrant = await seedGrant(asIClient(withGrant), USER_OTHER_ID, { grantExpiresAt: new Date(Date.now() - 2 * day) });
    const expiredAccess = await seedGrant(asIClient(withGrant), USER_EXPIRED_ID, { accessExpiresAt: new Date(Date.now() - 1000) });

    const mkAuth = (clientId: string, expiresAt: Date) =>
        createPersistedEntity(OAuthAuthorizationEntity, {
            id: crypto.randomUUID(),
            clientId,
            userId: null,
            redirectUri: 'https://claude.ai/cb',
            state: null,
            codeChallenge: 'a'.repeat(43),
            scope: 'mcp:read',
            resource: RESOURCE,
            status: 'pending',
            codeHash: null,
            grantId: null,
            createdAt: new Date(),
            expiresAt,
            approvedAt: null,
            redeemedAt: null
        });
    const oldAuth = await mkAuth(withGrant.id, new Date(Date.now() - 2 * day));
    const recentAuth = await mkAuth(withGrant.id, new Date(Date.now() - 1000));
    await mkAuth(withPending.id, new Date(Date.now() + 60_000));

    await f.get<PruneOAuthJob>(PruneOAuthJob).handle();

    const clientExists = async (c: OAuthClientEntity) => (await OAuthClientEntity.query().filter({ id: c.id }).count()) === 1;
    eq(await clientExists(oldUnused), false, 'old unused client is pruned');
    eq(await clientExists(staleUsed), false, 'client unused for 90 days is pruned');
    eq(await clientExists(freshUnused), true, 'recent unused client stays');
    eq(await clientExists(recentlyUsed), true, 'recently used client stays');
    eq(await clientExists(withGrant), true, 'client with grants stays');
    eq(await clientExists(withPending), true, 'client with a live request stays');
    eq(await OAuthGrantEntity.query().filter({ id: liveGrant.grantId }).count(), 1, 'live grant stays');
    eq(await OAuthGrantEntity.query().filter({ id: oldRevoked.grantId }).count(), 0, 'long-revoked grant is pruned');
    eq(await OAuthGrantEntity.query().filter({ id: expiredGrant.grantId }).count(), 0, 'expired grant is pruned');
    eq(await OAuthAuthorizationEntity.query().filter({ id: oldAuth.id }).count(), 0, 'old authorization is pruned');
    eq(await OAuthAuthorizationEntity.query().filter({ id: recentAuth.id }).count(), 1, 'recent authorization is kept for replay detection');
    eq(
        await OAuthTokenEntity.query()
            .filter({ tokenHash: sha256(expiredAccess.access) })
            .count(),
        0,
        'expired token is pruned'
    );
    eq(
        await OAuthTokenEntity.query()
            .filter({ tokenHash: sha256(liveGrant.access) })
            .count(),
        1,
        'live token stays'
    );
    eq(await OAuthTokenEntity.query().filter({ grantId: oldRevoked.grantId }).count(), 0, 'tokens of revoked grants are pruned');
    console.log('  PASS');
}
