/**
 * OAuth Client ID Metadata Documents (CIMD): a client identified by an https URL whose published document PixelCI fetches. The
 * outbound fetch is replaced by a fake (the ClientMetadataFetcher seam), so no network is involved; the SSRF-hardened fetcher itself is
 * covered by tests/services/SafeHttpsFetch.spec.ts.
 *
 * ENFORCE_VCS_PROJECT_ACCESS is off: no VCS provider is involved, only identity rows for the signed-in users.
 */
import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, createRedis, JWT, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { randomBytes } from 'crypto';

import { CoreAppOptions } from '../../src/app';
import { OAuthAuthorizationEntity } from '../../src/entities/OAuthAuthorization.entity';
import { OAuthClientEntity } from '../../src/entities/OAuthClient.entity';
import { OAuthGrantEntity } from '../../src/entities/OAuthGrant.entity';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { PruneOAuthJob } from '../../src/jobs/PruneOAuth.job';
import { ClientMetadataFetcher } from '../../src/services/oauth/ClientMetadataFetcher';
import { ClientMetadataResolver } from '../../src/services/oauth/ClientMetadataResolver.service';
import { pkceS256 } from '../../src/services/oauth/OAuthCrypto';
import { ClientMetadataFetchError, ISafeFetchResult } from '../../src/services/oauth/SafeHttpsFetch';
import { sealIntegrationConfig } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase } from './db-defaults';

process.env.CI = 'true';
process.env.REDIS_PREFIX = 'pixelci_test';
process.env.PUBLIC_URL = 'https://pixelci.test';
process.env.ENFORCE_VCS_PROJECT_ACCESS = 'false';

configureTestDatabase();

const ISSUER = 'https://pixelci.test';
const VCS_ID = '00000000-0000-0000-0000-000000000000';
const USER_ID = 'c1111111-aaaa-bbbb-cccc-000000000001';

type Canned = ISafeFetchResult | ClientMetadataFetchError;

/** Serves canned documents and counts every fetch. */
class FakeFetcher extends ClientMetadataFetcher {
    docs = new Map<string, Canned>();
    calls: string[] = [];
    delayMs = 0;
    /** Never answers (a misbehaving fetcher implementation). */
    hang = false;

    async fetch(url: URL): Promise<ISafeFetchResult> {
        this.calls.push(url.href);
        if (this.hang) return new Promise(() => undefined);
        if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
        const canned = this.docs.get(url.href);
        if (!canned) throw new ClientMetadataFetchError('http_status');
        if (canned instanceof ClientMetadataFetchError) throw canned;
        return canned;
    }

    count(url: string) {
        return this.calls.filter(c => c === url).length;
    }
}

const fetcher = new FakeFetcher();

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

run()
    .then(() => {
        console.log('\nAll OAuth CIMD tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

interface Ctx {
    f: Facade;
    jwt: string;
}

async function run() {
    const providers = CoreAppOptions.providers!.filter(p => !(typeof p === 'object' && 'provide' in p && p.provide === ClientMetadataFetcher));
    const facade = TestingHelpers.createTestingFacade(
        { ...CoreAppOptions, providers: [...providers, { provide: ClientMetadataFetcher, useValue: fetcher }] },
        { enableDatabase: true, databasePrefix: 'pixelci_cimdtest' }
    );
    await facade.start();
    await createPersistedEntity(VcsIntegrationEntity, {
        id: VCS_ID,
        name: 'CIMD Test VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({ url: 'http://127.0.0.1:1', clientId: 'client-id', clientSecret: 'client-secret' })
    });
    await createPersistedEntity(UserEntity, {
        id: USER_ID,
        name: 'Reviewer Rita',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: false,
        vcsId: VCS_ID,
        vcsUserId: '4242',
        vcsSession: null
    });
    await resetRateLimits();

    // The cases below fetch far more often than production limits allow; testRateLimits lowers them again.
    const limits = facade.app.config as unknown as Record<string, number>;
    limits.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN = 1000;
    limits.OAUTH_CIMD_MAX_FETCHES_PER_HOST_PER_10_MIN = 1000;
    limits.OAUTH_CIMD_MAX_FETCHES_PER_HOUR = 100000;
    limits.OAUTH_CIMD_MAX_FETCHES_PER_IP_PER_10_MIN = 100000;

    const ctx: Ctx = { f: facade, jwt: await JWT.generate({ subject: USER_ID }) };
    // The authorize endpoint's per-IP limit counts across cases, so each starts from a clean slate.
    const cases = [
        testDiscoveryAndDisabled,
        testHappyPath,
        testDocumentRejections,
        testRedirects,
        testCache,
        testRefetchDropsRedirect,
        testTokenEndpoint,
        testNoSupersede,
        testVerification,
        testSingleFlight,
        testRateLimits,
        testBudgetIsolation,
        testWithdrawnNotResurrected,
        testHungFetcher,
        testSelfThrottle,
        testPrune
    ];
    for (const testCase of cases) {
        await resetRateLimits();
        await testCase(ctx);
    }
    await resetRateLimits();
}

// ---------------------------------------------------------------------------------------------------------------- helpers

async function resetRateLimits() {
    const { client, prefix } = createRedis();
    const keys = await client.keys(`${prefix}:ratelimit:*`);
    if (keys.length) await client.del(...keys);
}

let seq = 0;
/** A fresh client_id URL (each test case gets its own so cache and rate-limit state never bleeds across cases). */
const newUrl = (host = 'app.example.com') => `https://${host}/clients/c${++seq}.json`;

const documentFor = (url: string, extra: Record<string, unknown> = {}) => ({
    client_id: url,
    client_name: 'CIMD App',
    redirect_uris: ['https://app.example.com/cb'],
    token_endpoint_auth_method: 'none',
    ...extra
});

const serve = (url: string, extra: Record<string, unknown> = {}, cacheControl?: string) =>
    fetcher.docs.set(url, { json: documentFor(url, extra), cacheControl });

interface IClient {
    id: string;
    redirectUris: string[];
}
const cimdClient = (url: string, redirectUris = ['https://app.example.com/cb']): IClient => ({ id: url, redirectUris });

const verifierFor = () => randomBytes(32).toString('base64url');

function authorizeQuery(client: IClient, opts: { redirectUri?: string; verifier?: string } = {}): Record<string, string> {
    return {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: opts.redirectUri ?? client.redirectUris[0],
        code_challenge: pkceS256(opts.verifier ?? verifierFor()),
        code_challenge_method: 'S256',
        state: 'st-' + randomBytes(4).toString('hex')
    };
}

const authorizeGet = (f: Facade, query: Record<string, string>) =>
    f.request(HttpRequest.GET(`/api/oauth/authorize?${new URLSearchParams(query).toString()}`));

/** The /oauth/error reason of an authorize response (asserting that it is our own error page, not a redirect to the client). */
function errorReason(response: Response): string {
    status(response, 302, 'authorize');
    const location = new URL(header(response, 'location')!);
    eq(`${location.origin}${location.pathname}`, `${ISSUER}/oauth/error`, 'error page');
    return location.searchParams.get('reason') ?? '';
}

async function startConsent(f: Facade, client: IClient, opts: { redirectUri?: string; verifier?: string } = {}): Promise<string> {
    const response = await authorizeGet(f, authorizeQuery(client, opts));
    status(response, 302, 'authorize');
    const location = new URL(header(response, 'location')!);
    eq(`${location.origin}${location.pathname}`, `${ISSUER}/oauth/consent`, `authorize redirects to consent (${header(response, 'location')})`);
    const id = location.searchParams.get('request');
    check(id, 'consent redirect carries a request id');
    return id;
}

const userReq = (ctx: Ctx, req: HttpRequest) => req.header('authorization', `Bearer ${ctx.jwt}`);

const approve = (ctx: Ctx, requestId: string) =>
    ctx.f.request(userReq(ctx, HttpRequest.POST('/api/connected-apps/requests/approve').json({ request: requestId })));

const viewRequest = async (ctx: Ctx, requestId: string) => {
    const r = await ctx.f.request(userReq(ctx, HttpRequest.GET(`/api/connected-apps/requests?request=${requestId}`)));
    status(r, 200, 'view request');
    return r.json as {
        clientName: string;
        clientIdHost: string | null;
        verification: string;
        redirectOffDomain: boolean;
        redirectKind: string;
    };
};

function formReq(path: string, params: Record<string, string>) {
    return HttpRequest.POST(path, new URLSearchParams(params).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
}

async function getCode(ctx: Ctx, client: IClient) {
    const verifier = verifierFor();
    const id = await startConsent(ctx.f, client, { verifier });
    const approved = await approve(ctx, id);
    status(approved, 200, 'approve');
    const url = new URL((approved.json as { redirectUrl: string }).redirectUrl);
    const code = url.searchParams.get('code');
    check(code, 'approve carries a code');
    return { code, verifier, redirectUri: client.redirectUris[0] };
}

const exchange = (ctx: Ctx, client: IClient, c: { code: string; verifier: string; redirectUri: string }) =>
    ctx.f.request(
        formReq('/api/oauth/token', {
            grant_type: 'authorization_code',
            client_id: client.id,
            code: c.code,
            code_verifier: c.verifier,
            redirect_uri: c.redirectUri
        })
    );

interface ITokens {
    access_token: string;
    refresh_token: string;
}

async function fullFlow(ctx: Ctx, client: IClient): Promise<ITokens> {
    const response = await exchange(ctx, client, await getCode(ctx, client));
    status(response, 200, 'token exchange');
    return response.json as ITokens;
}

const refresh = (ctx: Ctx, client: IClient, refreshToken: string) =>
    ctx.f.request(formReq('/api/oauth/token', { grant_type: 'refresh_token', client_id: client.id, refresh_token: refreshToken }));

const mcpToolsList = (ctx: Ctx, token: string) =>
    ctx.f.request(
        HttpRequest.POST('/api/mcp')
            .header('accept', 'application/json, text/event-stream')
            .header('content-type', 'application/json')
            .header('mcp-protocol-version', '2025-06-18')
            .header('authorization', `Bearer ${token}`)
            .json({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    );

const rowOf = (url: string) => OAuthClientEntity.query().filter({ metadataUrl: url }).findOne();

const expireRow = (url: string, ago = 1000) =>
    OAuthClientEntity.query()
        .filter({ metadataUrl: url })
        .patchMany({ metadataExpiresAt: new Date(Date.now() - ago) });

// ------------------------------------------------------------------------------------------------------------------ tests

async function testDiscoveryAndDisabled(ctx: Ctx) {
    const f = ctx.f;
    console.log('\nTest: discovery advertises CIMD; with it disabled a URL client_id is invalid_client');
    const meta = await f.request(HttpRequest.GET('/.well-known/oauth-authorization-server'));
    status(meta, 200, 'AS metadata');
    eq((meta.json as Record<string, unknown>).client_id_metadata_document_supported, true, 'flag advertised');

    const url = newUrl();
    serve(url);
    const config = f.app.config as unknown as { OAUTH_CIMD_ENABLED: boolean };
    config.OAUTH_CIMD_ENABLED = false;
    try {
        const off = await f.request(HttpRequest.GET('/.well-known/oauth-authorization-server'));
        check(!('client_id_metadata_document_supported' in (off.json as object)), 'flag omitted when disabled');
        eq(errorReason(await authorizeGet(f, authorizeQuery(cimdClient(url)))), 'invalid_client', 'authorize when disabled');
        eq(fetcher.count(url), 0, 'no fetch when disabled');
        status(
            await f.request(formReq('/api/oauth/token', { grant_type: 'refresh_token', client_id: url, refresh_token: 'x' })),
            401,
            'token when disabled'
        );
    } finally {
        config.OAUTH_CIMD_ENABLED = true;
    }
    console.log('  PASS');
}

async function testHappyPath(ctx: Ctx) {
    console.log('\nTest: happy path - authorize, consent view, approve, token, MCP call, refresh, revoke');
    const url = newUrl();
    serve(url, {}, 'max-age=3600');
    const client = cimdClient(url);

    const id = await startConsent(ctx.f, client);
    eq(fetcher.count(url), 1, 'one fetch at authorize');
    const view = await viewRequest(ctx, id);
    eq(view.clientName, 'CIMD App', 'client name');
    eq(view.clientIdHost, 'app.example.com', 'client_id host');
    eq(view.verification, 'verified_domain', 'verification');
    eq(view.redirectOffDomain, false, 'redirect on domain');

    const row = await rowOf(url);
    check(row.id !== url && /^[0-9a-f-]{36}$/.test(row.id), 'row has an internal uuid');
    eq(row.tokenEndpointAuthMethod, 'none', 'public client');
    eq(row.secretHash, null, 'no secret');
    check(row.metadataExpiresAt && row.metadataExpiresAt.getTime() - Date.now() > 3_000_000, 'cache-control max-age honoured');

    const approved = await approve(ctx, id);
    status(approved, 200, 'approve');
    const redirect = new URL((approved.json as { redirectUrl: string }).redirectUrl);
    eq(redirect.origin + redirect.pathname, 'https://app.example.com/cb', 'redirects to the document URI');

    // Re-run the whole flow for tokens (the code above was consumed by approve only, so get a fresh one).
    const tokens = await fullFlow(ctx, client);
    eq(fetcher.count(url), 1, 'token endpoint did not fetch (document still fresh)');
    status(await mcpToolsList(ctx, tokens.access_token), 200, 'MCP with the access token');
    const refreshed = await refresh(ctx, client, tokens.refresh_token);
    status(refreshed, 200, 'refresh');
    const next = refreshed.json as ITokens;
    status(await ctx.f.request(formReq('/api/oauth/revoke', { client_id: url, token: next.refresh_token })), 200, 'revoke');
    status(await refresh(ctx, client, next.refresh_token), 400, 'refresh after revoke');
    eq(fetcher.count(url), 1, 'still a single fetch');
    console.log('  PASS');
}

async function testDocumentRejections(ctx: Ctx) {
    console.log('\nTest: invalid documents show our error page, and are never cached');
    const cases: [string, (url: string) => Canned][] = [
        ['client_id mismatch', url => ({ json: documentFor(url, { client_id: url + '/' }) })],
        ['client_secret present', url => ({ json: documentFor(url, { client_secret: 'x' }) })],
        ['private_key_jwt', url => ({ json: documentFor(url, { token_endpoint_auth_method: 'private_key_jwt' }) })],
        ['client_secret_basic', url => ({ json: documentFor(url, { token_endpoint_auth_method: 'client_secret_basic' }) })],
        ['no usable redirect uris', url => ({ json: documentFor(url, { redirect_uris: ['myapp://cb'] }) })],
        ['missing client_name', url => ({ json: documentFor(url, { client_name: undefined }) })],
        ['missing redirect_uris', url => ({ json: documentFor(url, { redirect_uris: undefined }) })],
        ['grant_types without authorization_code', url => ({ json: documentFor(url, { grant_types: ['refresh_token'] }) })],
        ['not an object', () => ({ json: ['x'] })],
        ['404', () => new ClientMetadataFetchError('http_status')],
        ['blocked address', () => new ClientMetadataFetchError('blocked_address')],
        ['timeout', () => new ClientMetadataFetchError('timeout')]
    ];
    for (const [label, make] of cases) {
        const url = newUrl();
        fetcher.docs.set(url, make(url));
        const client = cimdClient(url);
        eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'client_metadata_unavailable', label);
        eq(fetcher.count(url), 1, `${label}: fetched once`);
        eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'client_metadata_unavailable', `${label} (retry)`);
        eq(fetcher.count(url), 2, `${label}: failures are not cached, the retry fetches again`);
        eq(await OAuthClientEntity.query().filter({ metadataUrl: url }).count(), 0, `${label}: nothing stored`);
    }

    // A fixed document is picked up on the very next request.
    const url = newUrl();
    fetcher.docs.set(url, new ClientMetadataFetchError('http_status'));
    eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(cimdClient(url)))), 'client_metadata_unavailable', 'broken');
    serve(url);
    await startConsent(ctx.f, cimdClient(url));

    // URLs that fail the syntactic rules never reach the fetcher.
    const before = fetcher.calls.length;
    for (const bad of [
        'https://app.example.com/',
        'https://app.example.com:8443/c',
        'https://127.0.0.1/c',
        'https://localhost/c',
        'https://app.example.com/c?x=1',
        'https://App.example.com/c',
        'http://app.example.com/c'
    ]) {
        const r = await authorizeGet(ctx.f, authorizeQuery({ id: bad, redirectUris: ['https://app.example.com/cb'] }));
        // 'http://' is not a URL client_id at all: it is looked up as a registered id.
        eq(errorReason(r), 'invalid_client', bad);
    }
    eq(fetcher.calls.length, before, 'malformed client_ids cause no fetch');
    console.log('  PASS');
}

async function testRedirects(ctx: Ctx) {
    console.log('\nTest: redirect URI must be one the document lists; junk redirect URIs never cause a fetch');
    const url = newUrl();
    serve(url);
    eq(
        errorReason(await authorizeGet(ctx.f, authorizeQuery(cimdClient(url), { redirectUri: 'https://app.example.com/other' }))),
        'invalid_redirect_uri',
        'unlisted'
    );
    eq(fetcher.count(url), 1, 'valid-looking request fetched');

    const junk = newUrl();
    serve(junk);
    for (const redirectUri of ['not a uri', 'myapp://cb', 'https://x.example/cb#frag', '']) {
        const q = authorizeQuery(cimdClient(junk), { redirectUri });
        if (!redirectUri) delete (q as Record<string, string | undefined>).redirect_uri;
        eq(errorReason(await authorizeGet(ctx.f, q)), 'invalid_redirect_uri', `junk ${JSON.stringify(redirectUri)}`);
    }
    eq(fetcher.count(junk), 0, 'no fetch for junk redirect URIs');
    console.log('  PASS');
}

async function testCache(ctx: Ctx) {
    console.log('\nTest: cache - fresh rows are reused, expired rows refetched, transient errors use a recent row, definitive ones do not');
    const url = newUrl();
    serve(url, {}, 'max-age=600');
    const client = cimdClient(url);
    await startConsent(ctx.f, client);
    await startConsent(ctx.f, client);
    eq(fetcher.count(url), 1, 'second authorize within max-age makes no fetch');

    const rowBefore = await rowOf(url);
    await expireRow(url);
    serve(url, { client_name: 'Renamed App' }, 'max-age=600');
    await startConsent(ctx.f, client);
    eq(fetcher.count(url), 2, 'refetched after expiry');
    const rowAfter = await rowOf(url);
    eq(rowAfter.id, rowBefore.id, 'internal id is stable across refetches');
    eq(rowAfter.name, 'Renamed App', 'refetch updates the row');

    await expireRow(url);
    fetcher.docs.set(url, new ClientMetadataFetchError('timeout'));
    await startConsent(ctx.f, client);
    eq(fetcher.count(url), 3, 'transient failure attempted a refetch');
    eq((await rowOf(url)).name, 'Renamed App', 'stale row served on a transient failure');

    fetcher.docs.set(url, new ClientMetadataFetchError('http_5xx'));
    await startConsent(ctx.f, client);

    fetcher.docs.set(url, new ClientMetadataFetchError('http_status'));
    eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'client_metadata_unavailable', 'withdrawn document (404) with a recent row');
    serve(url, { client_secret: 'oops' });
    eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'client_metadata_unavailable', 'now-invalid document with a recent row');

    // A row last fetched over 24 hours ago is not used even for a transient failure.
    await OAuthClientEntity.query()
        .filter({ metadataUrl: url })
        .patchMany({ metadataFetchedAt: new Date(Date.now() - 25 * 3600_000) });
    fetcher.docs.set(url, new ClientMetadataFetchError('timeout'));
    eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'client_metadata_unavailable', 'too-old row');

    // Cache-Control bounds: no-store means the 5 minute floor, huge values the 24 hour ceiling.
    const noStore = newUrl();
    serve(noStore, {}, 'no-store');
    await startConsent(ctx.f, cimdClient(noStore));
    const nsTtl = (await rowOf(noStore)).metadataExpiresAt!.getTime() - Date.now();
    check(nsTtl > 280_000 && nsTtl <= 300_000, `no-store clamps to 5 minutes (${nsTtl})`);
    const huge = newUrl();
    serve(huge, {}, 'max-age=99999999');
    await startConsent(ctx.f, cimdClient(huge));
    const hugeTtl = (await rowOf(huge)).metadataExpiresAt!.getTime() - Date.now();
    check(hugeTtl > 86_300_000 && hugeTtl <= 86_400_000, `huge max-age clamps to 24 hours (${hugeTtl})`);
    console.log('  PASS');
}

async function testRefetchDropsRedirect(ctx: Ctx) {
    console.log('\nTest: a refetch that drops a redirect URI blocks new and pending requests, but not existing grants');
    const url = newUrl();
    serve(url, { redirect_uris: ['https://app.example.com/cb', 'https://app.example.com/cb2'] });
    const client = cimdClient(url);
    const tokens = await fullFlow(ctx, client);
    const pending = await startConsent(ctx.f, client);

    await expireRow(url);
    serve(url, { redirect_uris: ['https://app.example.com/cb2'] });
    eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'invalid_redirect_uri', 'dropped URI rejected at authorize');
    status(await approve(ctx, pending), 410, 'pending request for a dropped URI cannot be approved');
    status(await refresh(ctx, client, tokens.refresh_token), 200, 'existing grant still refreshes');
    console.log('  PASS');
}

async function testTokenEndpoint(ctx: Ctx) {
    console.log('\nTest: token endpoint - no fetch for unknown ids, internal uuid refused, 503 on transient failure, invalid_client on definitive');
    const unknown = newUrl();
    serve(unknown);
    const before = fetcher.calls.length;
    const r = await ctx.f.request(formReq('/api/oauth/token', { grant_type: 'refresh_token', client_id: unknown, refresh_token: 'x' }));
    status(r, 401, 'unknown URL client_id');
    eq((r.json as { error: string }).error, 'invalid_client', 'invalid_client');
    eq(fetcher.calls.length, before, 'zero fetches for a never-authorized URL');

    const url = newUrl();
    serve(url);
    const client = cimdClient(url);
    const tokens = await fullFlow(ctx, client);
    const row = await rowOf(url);

    // The internal uuid is not a client_id, at authorize or token.
    const asUuid: IClient = { id: row.id, redirectUris: client.redirectUris };
    eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(asUuid))), 'invalid_client', 'uuid at authorize');
    const viaUuid = await ctx.f.request(
        formReq('/api/oauth/token', { grant_type: 'refresh_token', client_id: row.id, refresh_token: tokens.refresh_token })
    );
    status(viaUuid, 401, 'uuid at token');
    eq((viaUuid.json as { error: string }).error, 'invalid_client', 'uuid is invalid_client');

    // Expired row: the token endpoint refetches. A transient failure is covered by the stored document (within 24 hours).
    await expireRow(url);
    fetcher.docs.set(url, new ClientMetadataFetchError('timeout'));
    const calls = fetcher.count(url);
    const stale = await refresh(ctx, client, tokens.refresh_token);
    status(stale, 200, 'transient failure at token with a recent stored document');
    eq(fetcher.count(url), calls + 1, 'token endpoint refetched the expired document');
    const current = stale.json as ITokens;
    const grantId = (await OAuthGrantEntity.query().filter({ clientId: row.id }).find())[0].id;

    // Without a usable stored document (too old) it is a 503, and still revokes nothing.
    await OAuthClientEntity.query()
        .filter({ metadataUrl: url })
        .patchMany({ metadataFetchedAt: new Date(Date.now() - 25 * 3600_000) });
    const unavailable = await refresh(ctx, client, current.refresh_token);
    status(unavailable, 503, 'transient failure at token with an old stored document');
    eq((unavailable.json as { error: string }).error, 'temporarily_unavailable', 'temporarily_unavailable');
    eq((await OAuthGrantEntity.query().filter({ id: grantId }).findOne()).revokedAt, null, 'grant untouched by a transient failure');

    // A definitive failure is invalid_client, and still does not revoke the grant.
    fetcher.docs.set(url, new ClientMetadataFetchError('http_status'));
    const gone = await refresh(ctx, client, current.refresh_token);
    status(gone, 401, 'definitive failure at token');
    eq((gone.json as { error: string }).error, 'invalid_client', 'invalid_client');
    eq((await OAuthGrantEntity.query().filter({ id: grantId }).findOne()).revokedAt, null, 'grant untouched by a definitive failure');

    // Revocation never fetches: it works from the stored row even when the document is expired and gone.
    const revokeCalls = fetcher.count(url);
    status(await ctx.f.request(formReq('/api/oauth/revoke', { client_id: url, token: current.refresh_token })), 200, 'revoke');
    eq(fetcher.count(url), revokeCalls, 'revoke did not fetch');
    check((await OAuthGrantEntity.query().filter({ id: grantId }).findOne()).revokedAt !== null, 'revoked');

    // Recovery: the document is back.
    serve(url);
    const again = await fullFlow(ctx, client);
    status(await refresh(ctx, client, again.refresh_token), 200, 'refresh with a recovered document');
    console.log('  PASS');
}

async function testNoSupersede(ctx: Ctx) {
    console.log('\nTest: a second approval for the same user and CIMD client does not supersede the first');
    const url = newUrl();
    serve(url);
    const client = cimdClient(url);
    const a = await fullFlow(ctx, client);
    const b = await fullFlow(ctx, client);
    status(await refresh(ctx, client, a.refresh_token), 200, 'first connection still works');
    status(await refresh(ctx, client, b.refresh_token), 200, 'second connection works');

    const list = await ctx.f.request(userReq(ctx, HttpRequest.GET('/api/connected-apps')));
    status(list, 200, 'connected apps');
    const mine = (list.json as { clientName: string; publisher: string | null }[]).filter(x => x.publisher === 'app.example.com');
    check(mine.length >= 2, `both grants are listed with their publisher (${mine.length})`);
    eq(mine[0].clientName, 'CIMD App', 'client name listed');
    console.log('  PASS');
}

async function testVerification(ctx: Ctx) {
    console.log('\nTest: verification levels on the consent view');
    const loopback = newUrl();
    serve(loopback, { redirect_uris: ['http://127.0.0.1:1234/callback'] });
    const loopId = await startConsent(ctx.f, cimdClient(loopback, ['http://127.0.0.1:1234/callback']), {
        redirectUri: 'http://127.0.0.1:5555/callback'
    });
    const loopView = await viewRequest(ctx, loopId);
    eq(loopView.verification, 'claimed_domain', 'loopback is only claimed');
    eq(loopView.redirectKind, 'loopback', 'loopback kind');
    eq(loopView.clientIdHost, 'app.example.com', 'host still shown');

    const off = newUrl();
    serve(off, { redirect_uris: ['https://elsewhere.example.org/cb'] });
    const offView = await viewRequest(ctx, await startConsent(ctx.f, cimdClient(off, ['https://elsewhere.example.org/cb'])));
    eq(offView.verification, 'verified_domain', 'web redirect');
    eq(offView.redirectOffDomain, true, 'off-domain redirect flagged');

    const shared = newUrl('someone.github.io');
    serve(shared, { redirect_uris: ['https://someone.github.io/cb'] });
    const sharedView = await viewRequest(ctx, await startConsent(ctx.f, cimdClient(shared, ['https://someone.github.io/cb'])));
    eq(sharedView.verification, 'claimed_domain', 'shared hosting is only claimed');

    // Registered (DCR) clients are unchanged.
    const dcr = await ctx.f.request(
        HttpRequest.POST('/api/oauth/register').json({
            client_name: 'DCR',
            redirect_uris: ['https://claude.ai/cb'],
            token_endpoint_auth_method: 'none'
        })
    );
    status(dcr, 201, 'register');
    const dcrClient: IClient = { id: (dcr.json as { client_id: string }).client_id, redirectUris: ['https://claude.ai/cb'] };
    const dcrView = await viewRequest(ctx, await startConsent(ctx.f, dcrClient));
    eq(dcrView.verification, 'unverified', 'DCR is unverified');
    eq(dcrView.clientIdHost, null, 'DCR has no host');
    console.log('  PASS');
}

async function testSingleFlight(ctx: Ctx) {
    console.log('\nTest: concurrent authorizes for a new URL make one fetch and one row');
    const url = newUrl();
    serve(url);
    fetcher.delayMs = 150;
    try {
        const results = await Promise.all(Array.from({ length: 6 }, () => authorizeGet(ctx.f, authorizeQuery(cimdClient(url)))));
        for (const r of results) status(r, 302, 'authorize');
        for (const r of results) check(header(r, 'location')!.startsWith(`${ISSUER}/oauth/consent`), 'all reach consent');
    } finally {
        fetcher.delayMs = 0;
    }
    eq(fetcher.count(url), 1, 'single fetch');
    eq(await OAuthClientEntity.query().filter({ metadataUrl: url }).count(), 1, 'single row');
    console.log('  PASS');
}

async function testRateLimits(ctx: Ctx) {
    console.log('\nTest: fetch rate limits (per host, per URL, overall)');
    const config = ctx.f.app.config as unknown as {
        OAUTH_CIMD_MAX_FETCHES_PER_HOST_PER_10_MIN: number;
        OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN: number;
        OAUTH_CIMD_MAX_FETCHES_PER_HOUR: number;
        OAUTH_CIMD_MAX_FETCHES_PER_IP_PER_10_MIN: number;
    };
    const original = { ...config };
    await resetRateLimits();
    try {
        config.OAUTH_CIMD_MAX_FETCHES_PER_HOST_PER_10_MIN = 2;
        const urls = [newUrl('limited.example.com'), newUrl('limited.example.com'), newUrl('limited.example.com')];
        for (const u of urls) serve(u, { redirect_uris: ['https://limited.example.com/cb'] });
        await startConsent(ctx.f, cimdClient(urls[0], ['https://limited.example.com/cb']));
        await startConsent(ctx.f, cimdClient(urls[1], ['https://limited.example.com/cb']));
        eq(
            errorReason(await authorizeGet(ctx.f, authorizeQuery(cimdClient(urls[2], ['https://limited.example.com/cb'])))),
            'client_metadata_unavailable',
            'per-host limit'
        );
        eq(fetcher.count(urls[2]), 0, 'no fetch once over the limit');
        // A different host is unaffected.
        const other = newUrl('unlimited.example.org');
        serve(other, { redirect_uris: ['https://unlimited.example.org/cb'] });
        await startConsent(ctx.f, cimdClient(other, ['https://unlimited.example.org/cb']));

        // The host budget is keyed on the registrable domain: wildcard subdomains share it.
        await resetRateLimits();
        const wild = ['a', 'b', 'c'].map(sub => newUrl(`${sub}.wild.example.com`));
        for (const u of wild) serve(u, { redirect_uris: [`https://${new URL(u).hostname}/cb`] });
        await startConsent(ctx.f, cimdClient(wild[0], [`https://${new URL(wild[0]).hostname}/cb`]));
        await startConsent(ctx.f, cimdClient(wild[1], [`https://${new URL(wild[1]).hostname}/cb`]));
        eq(
            errorReason(await authorizeGet(ctx.f, authorizeQuery(cimdClient(wild[2], [`https://${new URL(wild[2]).hostname}/cb`])))),
            'client_metadata_unavailable',
            'wildcard subdomains share the budget'
        );
        eq(fetcher.count(wild[2]), 0, 'no fetch for the third subdomain');

        // Each tenant of a shared host is its own registrable domain.
        const t1 = newUrl('t1.github.io');
        const t2 = newUrl('t2.github.io');
        const t3 = newUrl('t3.github.io');
        for (const u of [t1, t2, t3]) serve(u, { redirect_uris: [`https://${new URL(u).hostname}/cb`] });
        for (const u of [t1, t2, t3]) await startConsent(ctx.f, cimdClient(u, [`https://${new URL(u).hostname}/cb`]));

        // The per-IP budget is charged first, whatever the URL.
        await resetRateLimits();
        config.OAUTH_CIMD_MAX_FETCHES_PER_HOST_PER_10_MIN = original.OAUTH_CIMD_MAX_FETCHES_PER_HOST_PER_10_MIN;
        config.OAUTH_CIMD_MAX_FETCHES_PER_IP_PER_10_MIN = 2;
        const ipUrls = ['i1.example.org', 'i2.example.net', 'i3.example.io'].map(h => newUrl(h));
        for (const u of ipUrls) serve(u, { redirect_uris: [`https://${new URL(u).hostname}/cb`] });
        await startConsent(ctx.f, cimdClient(ipUrls[0], [`https://${new URL(ipUrls[0]).hostname}/cb`]));
        await startConsent(ctx.f, cimdClient(ipUrls[1], [`https://${new URL(ipUrls[1]).hostname}/cb`]));
        eq(
            errorReason(await authorizeGet(ctx.f, authorizeQuery(cimdClient(ipUrls[2], [`https://${new URL(ipUrls[2]).hostname}/cb`])))),
            'client_metadata_unavailable',
            'per-IP limit'
        );
        eq(fetcher.count(ipUrls[2]), 0, 'no fetch once the IP is over its limit');

        await resetRateLimits();
        config.OAUTH_CIMD_MAX_FETCHES_PER_IP_PER_10_MIN = original.OAUTH_CIMD_MAX_FETCHES_PER_IP_PER_10_MIN;
        config.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN = 2;
        const one = newUrl();
        fetcher.docs.set(one, new ClientMetadataFetchError('http_status'));
        for (let i = 0; i < 3; i++) errorReason(await authorizeGet(ctx.f, authorizeQuery(cimdClient(one))));
        eq(fetcher.count(one), 2, 'per-URL limit stops refetching a failing document');

        await resetRateLimits();
        config.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN = original.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN;
        config.OAUTH_CIMD_MAX_FETCHES_PER_HOUR = 1;
        const a = newUrl('a.example.com');
        const b = newUrl('b.example.com');
        serve(a, { redirect_uris: ['https://a.example.com/cb'] });
        serve(b, { redirect_uris: ['https://b.example.com/cb'] });
        await startConsent(ctx.f, cimdClient(a, ['https://a.example.com/cb']));
        eq(
            errorReason(await authorizeGet(ctx.f, authorizeQuery(cimdClient(b, ['https://b.example.com/cb'])))),
            'client_metadata_unavailable',
            'overall limit'
        );
    } finally {
        Object.assign(config, original);
        await resetRateLimits();
    }
    console.log('  PASS');
}

async function testBudgetIsolation(ctx: Ctx) {
    console.log('\nTest: draining the fetch budgets with made-up URLs does not lock stored clients out of refreshing');
    const config = ctx.f.app.config as unknown as Record<string, number>;
    const original = { ...config };
    try {
        const url = newUrl();
        serve(url);
        const client = cimdClient(url);
        const tokens = await fullFlow(ctx, client);

        // Burn the (unknown-URL) overall budget entirely.
        await resetRateLimits();
        config.OAUTH_CIMD_MAX_FETCHES_PER_HOUR = 2;
        for (let i = 0; i < 4; i++) {
            const junk = newUrl(`junk${i}.example.org`);
            serve(junk, { redirect_uris: [`https://junk${i}.example.org/cb`] });
            await authorizeGet(ctx.f, authorizeQuery(cimdClient(junk, [`https://junk${i}.example.org/cb`])));
        }
        eq(
            errorReason(await authorizeGet(ctx.f, authorizeQuery(cimdClient(newUrl('late.example.org'), ['https://late.example.org/cb'])))),
            'client_metadata_unavailable',
            'unknown URLs are throttled'
        );

        // The stored client still refetches on expiry, from its own budget.
        await expireRow(url);
        const before = fetcher.count(url);
        const refreshed = await refresh(ctx, client, tokens.refresh_token);
        status(refreshed, 200, 'refresh while unknown URLs are throttled');
        eq(fetcher.count(url), before + 1, 'refetched from the stored-URL budget');

        // And when even that is throttled, the stored document covers a transient failure instead of failing the client.
        await resetRateLimits();
        config.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN = 1;
        await expireRow(url);
        const next = (refreshed.json as ITokens).refresh_token;
        const first = await refresh(ctx, client, next);
        status(first, 200, 'refetch within budget');
        await expireRow(url);
        const calls = fetcher.count(url);
        const throttled = await refresh(ctx, client, (first.json as ITokens).refresh_token);
        status(throttled, 200, 'throttled refetch is covered by the stored document');
        eq(fetcher.count(url), calls, 'no fetch while throttled');
        eq((await mcpToolsList(ctx, (throttled.json as ITokens).access_token)).statusCode, 200, 'tokens work');
    } finally {
        Object.assign(config, original);
        await resetRateLimits();
    }
    console.log('  PASS');
}

async function testWithdrawnNotResurrected(ctx: Ctx) {
    console.log('\nTest: a withdrawn or invalid document is not resurrected by stale-if-error');
    const url = newUrl();
    serve(url);
    const client = cimdClient(url);
    await startConsent(ctx.f, client);
    check((await rowOf(url)).metadataFetchedAt, 'fetched');

    await expireRow(url);
    fetcher.docs.set(url, new ClientMetadataFetchError('http_status'));
    eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'client_metadata_unavailable', 'withdrawn');
    eq((await rowOf(url)).metadataFetchedAt, null, 'row marked unusable');

    // A later transient failure (or a tripped rate limit) must not bring it back.
    fetcher.docs.set(url, new ClientMetadataFetchError('timeout'));
    eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'client_metadata_unavailable', 'transient failure after withdrawal');
    const config = ctx.f.app.config as unknown as Record<string, number>;
    const original = config.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN;
    config.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN = 0;
    try {
        eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'client_metadata_unavailable', 'throttled after withdrawal');
    } finally {
        config.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN = original;
    }
    const tokenStatus = await ctx.f.request(formReq('/api/oauth/token', { grant_type: 'refresh_token', client_id: url, refresh_token: 'x' }));
    eq(tokenStatus.statusCode, 503, 'token endpoint: an unusable row is not served as stale (503, not a token)');

    // A successful fetch restores it.
    serve(url);
    await startConsent(ctx.f, client);
    check((await rowOf(url)).metadataFetchedAt, 'restored by a successful fetch');

    // An invalid (rather than missing) document marks it too.
    await expireRow(url);
    serve(url, { client_secret: 'oops' });
    errorReason(await authorizeGet(ctx.f, authorizeQuery(client)));
    eq((await rowOf(url)).metadataFetchedAt, null, 'invalid document marks the row unusable');
    console.log('  PASS');
}

async function testHungFetcher(ctx: Ctx) {
    console.log('\nTest: a fetcher that never answers neither hangs the request nor poisons later fetches');
    const resolver = ctx.f.get<ClientMetadataResolver>(ClientMetadataResolver);
    const originalGuard = resolver.fetchGuardMs;
    resolver.fetchGuardMs = 300;
    const url = newUrl();
    serve(url);
    try {
        fetcher.hang = true;
        const started = Date.now();
        eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(cimdClient(url)))), 'client_metadata_unavailable', 'hung fetch');
        check(Date.now() - started < 3000, 'gave up at our own deadline');
    } finally {
        fetcher.hang = false;
        resolver.fetchGuardMs = originalGuard;
    }
    await startConsent(ctx.f, cimdClient(url));
    console.log('  PASS');
}

async function testSelfThrottle(ctx: Ctx) {
    console.log('\nTest: a caller cannot throttle itself to keep a changed or withdrawn document alive');
    const config = ctx.f.app.config as unknown as Record<string, number>;
    const original = { ...config };
    try {
        for (const variant of ['changed', 'withdrawn'] as const) {
            await resetRateLimits();
            config.OAUTH_CIMD_MAX_FETCHES_PER_IP_PER_10_MIN = 3;
            const url = newUrl();
            const old = 'https://app.example.com/old-cb';
            serve(url, { redirect_uris: ['https://app.example.com/cb', old] });
            const client = cimdClient(url, [old]);
            await startConsent(ctx.f, client);

            // Drain this IP's own fetch budget with made-up URLs.
            for (let i = 0; i < 6; i++) {
                const junk = newUrl(`drain${i}.example.org`);
                serve(junk, { redirect_uris: [`https://drain${i}.example.org/cb`] });
                await authorizeGet(ctx.f, authorizeQuery(cimdClient(junk, [`https://drain${i}.example.org/cb`])));
            }

            // The vendor changes the document. The expired stored document is refetched regardless (not charged to the IP).
            await expireRow(url);
            if (variant === 'changed') serve(url, { redirect_uris: ['https://app.example.com/cb'] });
            else fetcher.docs.set(url, new ClientMetadataFetchError('http_status'));
            const before = fetcher.count(url);
            eq(
                errorReason(await authorizeGet(ctx.f, authorizeQuery(client))),
                variant === 'changed' ? 'invalid_redirect_uri' : 'client_metadata_unavailable',
                `${variant}: fails closed`
            );
            eq(fetcher.count(url), before + 1, `${variant}: the document was refetched`);
        }

        // A throttled refetch of a stored document is not stale-eligible at authorize, but still covers the token endpoint.
        await resetRateLimits();
        Object.assign(config, original);
        const url = newUrl();
        serve(url);
        const client = cimdClient(url);
        const tokens = await fullFlow(ctx, client);
        config.OAUTH_CIMD_MAX_FETCHES_PER_URL_PER_10_MIN = 0;
        await expireRow(url);
        const calls = fetcher.count(url);
        eq(errorReason(await authorizeGet(ctx.f, authorizeQuery(client))), 'client_metadata_unavailable', 'throttled refetch at authorize');
        eq(fetcher.count(url), calls, 'no fetch while throttled');
        status(await refresh(ctx, client, tokens.refresh_token), 200, 'throttled refetch still serves the token endpoint');

        // A real network failure at authorize may still use the stored document; 429 from the host is transient, never "withdrawn".
        Object.assign(config, original);
        await expireRow(url);
        fetcher.docs.set(url, new ClientMetadataFetchError('http_429'));
        await startConsent(ctx.f, client);
        check((await rowOf(url)).metadataFetchedAt, '429 does not mark the row unusable');
    } finally {
        Object.assign(config, original);
        await resetRateLimits();
    }
    console.log('  PASS');
}

async function testPrune(ctx: Ctx) {
    console.log('\nTest: prune removes unused CIMD rows after a day, keeping those with grants or recent');
    const day = 86_400_000;
    const mk = (createdAt: Date, lastUsedAt: Date | null) => {
        const url = newUrl();
        return createPersistedEntity(OAuthClientEntity, {
            id: crypto.randomUUID(),
            name: 'pruned?',
            redirectUris: ['https://app.example.com/cb'],
            tokenEndpointAuthMethod: 'none',
            secretHash: null,
            createdAt,
            lastUsedAt,
            metadataUrl: url,
            metadataFetchedAt: createdAt,
            metadataExpiresAt: createdAt
        });
    };
    const oldUnused = await mk(new Date(Date.now() - 2 * day), null);
    const fresh = await mk(new Date(Date.now() - 1000), null);
    const oldUsed = await mk(new Date(Date.now() - 20 * day), new Date(Date.now() - 2 * day));
    const withGrant = await mk(new Date(Date.now() - 2 * day), null);
    await createPersistedEntity(OAuthGrantEntity, {
        id: crypto.randomUUID(),
        clientId: withGrant.id,
        userId: USER_ID,
        scope: 'mcp:read',
        resource: `${ISSUER}/api/mcp`,
        redirectUri: 'https://app.example.com/cb',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + day),
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null
    });
    const withPending = await mk(new Date(Date.now() - 2 * day), null);
    await createPersistedEntity(OAuthAuthorizationEntity, {
        id: crypto.randomUUID(),
        clientId: withPending.id,
        userId: null,
        redirectUri: 'https://app.example.com/cb',
        state: null,
        codeChallenge: 'a'.repeat(43),
        scope: 'mcp:read',
        resource: `${ISSUER}/api/mcp`,
        status: 'pending',
        codeHash: null,
        grantId: null,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        approvedAt: null,
        redeemedAt: null
    });

    await ctx.f.get<PruneOAuthJob>(PruneOAuthJob).handle();
    const exists = async (c: OAuthClientEntity) => (await OAuthClientEntity.query().filter({ id: c.id }).count()) === 1;
    eq(await exists(oldUnused), false, 'unused CIMD row older than a day is pruned');
    eq(await exists(fresh), true, 'recent CIMD row kept');
    eq(await exists(oldUsed), true, 'used CIMD row kept');
    eq(await exists(withGrant), true, 'CIMD row with a grant kept');
    eq(await exists(withPending), true, 'CIMD row with a live request kept');
    console.log('  PASS');
}
