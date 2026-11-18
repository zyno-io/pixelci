import { HttpRequest } from '@zyno-io/ts-server-foundation';
import { createPersistedEntity, JWT, TestingHelpers } from '@zyno-io/ts-server-foundation';
import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { CoreAppOptions } from '../../src/app';
import { UserEntity } from '../../src/entities/User.entity';
import { VcsIntegrationEntity } from '../../src/entities/VcsIntegration.entity';
import { sealIntegrationConfig } from '../../src/services/secrets/VcsSecrets';
import { configureTestDatabase, ensureTestBucket, useIsolatedRedisPrefix } from './db-defaults';

process.env.CI = 'true';
useIsolatedRedisPrefix('session-cookie');
process.env.PUBLIC_URL = 'https://pixelci.test';

configureTestDatabase();

const ORIGIN = 'https://pixelci.test';
const EVIL = 'https://evil.example';
const COOKIE = '__Host-pixelci_session';
const VCS_ID = 'a1234567-aaaa-bbbb-cccc-000000000001';
const GL_USER = 'gl-cookie-user';
const HOUR = 3600;

type Facade = ReturnType<typeof TestingHelpers.createTestingFacade>;
type Res = Awaited<ReturnType<Facade['request']>>;

let mockServer: Server;
let mockPort: number;
let tokenHits = 0;

run()
    .then(() => {
        console.log('\nAll session cookie tests passed!');
        process.exit(0);
    })
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

function check(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

function status(res: Res, expected: number, what: string) {
    if (res.statusCode !== expected) throw new Error(`${what}: expected ${expected} but got ${res.statusCode}: ${res.body}`);
}

function setCookies(res: Res): string[] {
    const raw = (res.headers as Record<string, string | string[] | undefined>)['set-cookie'];
    return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
}

function sessionSetCookie(res: Res, name = COOKIE): string | undefined {
    return setCookies(res).find(c => c.startsWith(`${name}=`));
}

function cookieValue(setCookie: string): string {
    return setCookie.split(';')[0].split('=').slice(1).join('=');
}

/** An HS256 session JWT with an explicit issue/expiry time (JWT.generate always issues "now"). */
function signSession(opts: { sub: string; iat: number; exp: number; authTime?: number }): string {
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'app', sub: opts.sub, iat: opts.iat, exp: opts.exp, authTime: opts.authTime })}`;
    return `${body}.${createHmac('sha256', 'secret').update(body).digest('base64url')}`;
}

function decodePayload(jwt: string): { sub: string; authTime: number; exp: number } {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
}

function createMockGitLab(): Promise<void> {
    return new Promise(resolve => {
        mockServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            if (req.url === '/oauth/token') {
                tokenHits++;
                const idToken = await JWT.generate({ subject: GL_USER, payload: { name: 'Cookie User' } });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ access_token: 'glpat-cookie', expires_in: 7200, refresh_token: 'glrt-cookie', id_token: idToken }));
                return;
            }
            res.writeHead(404);
            res.end('Not found');
        });
        mockServer.listen(0, () => {
            mockPort = (mockServer.address() as { port: number }).port;
            resolve();
        });
    });
}

async function startFacade(prefix: string): Promise<Facade> {
    const facade = TestingHelpers.createTestingFacade(CoreAppOptions, { enableDatabase: true, databasePrefix: prefix });
    await ensureTestBucket();
    await facade.start();
    await createPersistedEntity(VcsIntegrationEntity, {
        id: VCS_ID,
        name: 'Cookie Test VCS',
        platform: 'gitlab',
        config: sealIntegrationConfig({ url: `http://127.0.0.1:${mockPort}`, clientId: 'client-id', clientSecret: 'client-secret' })
    });
    return facade;
}

async function login(f: Facade, headers: Record<string, string> = {}): Promise<Res> {
    const urlRes = await f.request(HttpRequest.GET(`/api/session/providers/${VCS_ID}/login-url?returnTo=/apps`));
    status(urlRes, 200, 'login-url');
    const req = HttpRequest.POST('/api/session/login').json({ code: 'good', state: (urlRes.json as { state: string }).state });
    for (const [name, value] of Object.entries(headers)) req.header(name, value);
    return f.request(req);
}

const withCookie = (req: HttpRequest, value: string, name = COOKIE) => req.header('cookie', `${name}=${value}`);
const withHeaders = (req: HttpRequest, headers: Record<string, string>) => {
    for (const [name, value] of Object.entries(headers)) req.header(name, value);
    return req;
};

async function run() {
    await createMockGitLab();

    const f = await startFacade('pixelci_sesscookie');

    console.log('\nTest: login sets the session cookie, with the right attributes, and no token in the body');
    const loginRes = await login(f);
    status(loginRes, 200, 'login');
    check(JSON.stringify(loginRes.json) === JSON.stringify({ returnTo: '/apps' }), `login body: ${loginRes.body}`);
    const set = sessionSetCookie(loginRes);
    check(set, `session cookie missing: ${JSON.stringify(setCookies(loginRes))}`);
    const attrs = set.split(';').map(a => a.trim());
    for (const expected of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=3600']) {
        check(attrs.includes(expected), `cookie lacks ${expected}: ${set}`);
    }
    check(!attrs.some(a => /^domain=/i.test(a)), `cookie must have no Domain: ${set}`);
    const session = cookieValue(set);
    const user = await UserEntity.query().filter({ vcsId: VCS_ID, vcsUserId: GL_USER }).findOne();
    const claims = decodePayload(session);
    check(claims.sub === user.id, 'cookie subject is the user');
    check(typeof claims.authTime === 'number' && Math.abs(claims.authTime - Date.now() / 1000) < 30, 'cookie carries authTime');
    console.log('  PASS');

    console.log('\nTest: authentication sources');
    status(await f.request(withCookie(HttpRequest.GET('/api/session/me'), session)), 200, 'cookie authenticates');
    status(await f.request(withCookie(HttpRequest.GET('/api/session/me'), session, 'jwt')), 401, 'TSF jwt cookie is not accepted');
    status(await f.request(withCookie(HttpRequest.GET('/api/session/me'), session, 'pixelci_session')), 401, 'http cookie name is not accepted here');
    status(await f.request(withCookie(HttpRequest.GET('/api/session/me'), 'not-a-jwt')), 401, 'junk cookie');
    status(await f.request(HttpRequest.GET('/api/session/me').header('authorization', `Bearer ${session}`)), 200, 'bearer still works');
    // Bearer wins over the cookie: a bad bearer is not rescued by a good cookie
    status(
        await f.request(withCookie(HttpRequest.GET('/api/session/me'), session).header('authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.bad')),
        401,
        'invalid bearer is not rescued by the cookie'
    );
    // UserAuthMiddleware routes (not just the resolver) honour the cookie and ignore `jwt`
    status(await f.request(withCookie(HttpRequest.GET('/api/apps/e1234567-aaaa-bbbb-cccc-0000000000aa/screens'), 'x')), 401, 'auth middleware: junk');
    console.log('  PASS');

    console.log('\nTest: CSRF matrix on an unsafe route');
    const logout = (headers: Record<string, string>, cookie?: string) =>
        f.request(
            withHeaders(cookie ? withCookie(HttpRequest.POST('/api/session/logout'), cookie) : HttpRequest.POST('/api/session/logout'), headers)
        );
    status(await logout({ origin: EVIL }, session), 403, 'cookie + evil Origin');
    status(await logout({ 'sec-fetch-site': 'cross-site' }, session), 403, 'cookie + cross-site, no Origin');
    status(await logout({ 'sec-fetch-site': 'same-site' }, session), 403, 'cookie + same-site');
    status(await logout({ origin: EVIL }), 403, 'evil Origin without a cookie');
    status(await logout({ origin: ORIGIN }, session), 200, 'Origin = PUBLIC_URL');
    status(await logout({ 'sec-fetch-site': 'same-origin' }, session), 200, 'same-origin');
    status(await logout({ 'sec-fetch-site': 'same-origin', origin: EVIL }, session), 200, 'same-origin wins (browser-set, unforgeable)');
    status(await logout({ 'sec-fetch-site': 'none' }, session), 200, 'user-initiated navigation');
    status(await logout({}, session), 200, 'no headers (non-browser client)');
    status(await logout({ origin: EVIL, authorization: `Bearer ${session}` }, session), 200, 'bearer is exempt');
    console.log('  PASS');

    console.log('\nTest: login CSRF');
    const hitsBefore = tokenHits;
    status(await login(f, { origin: EVIL }), 403, 'login from a foreign origin');
    check(tokenHits === hitsBefore, 'the token endpoint must not be hit by a refused login');
    status(await login(f, { origin: ORIGIN }), 200, 'login from the app origin');
    console.log('  PASS');

    console.log('\nTest: logout clears the cookie, even with no session');
    for (const res of [await logout({}), await logout({}, session)]) {
        status(res, 200, 'logout');
        const cleared = sessionSetCookie(res);
        check(cleared, 'logout sets the cookie');
        const a = cleared.split(';').map(x => x.trim());
        check(cleared.startsWith(`${COOKIE}=;`), `cleared value: ${cleared}`);
        for (const expected of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=0'])
            check(a.includes(expected), `cleared cookie lacks ${expected}: ${cleared}`);
    }
    console.log('  PASS');

    console.log('\nTest: renewal');
    const now = Math.floor(Date.now() / 1000);
    const aged = signSession({ sub: user.id, iat: now - 50 * 60, exp: now + 10 * 60, authTime: now - 2 * HOUR });
    const renewedRes = await f.request(withCookie(HttpRequest.GET('/api/session/me'), aged));
    status(renewedRes, 200, 'aged cookie');
    const renewed = sessionSetCookie(renewedRes);
    check(renewed, 'a cookie past half its life is renewed');
    const renewedClaims = decodePayload(cookieValue(renewed));
    check(renewedClaims.authTime === now - 2 * HOUR, 'authTime is preserved across renewal');
    check(renewedClaims.exp > now + 55 * 60, 'renewal extends the expiry');
    check(renewed.includes('Max-Age=3600'), 'renewal sets Max-Age');

    const freshRes = await f.request(withCookie(HttpRequest.GET('/api/session/me'), session));
    status(freshRes, 200, 'fresh cookie');
    check(!sessionSetCookie(freshRes), 'a fresh cookie is not renewed');

    const capped = signSession({ sub: user.id, iat: now - 50 * 60, exp: now + 10 * 60, authTime: now - 169 * HOUR });
    const cappedRes = await f.request(withCookie(HttpRequest.GET('/api/session/me'), capped));
    status(cappedRes, 200, 'cookie past the absolute cap is still valid until it expires');
    check(!sessionSetCookie(cappedRes), 'a session past SESSION_MAX_AGE_HOURS is not renewed');

    const bearerAged = await f.request(HttpRequest.GET('/api/session/me').header('authorization', `Bearer ${aged}`));
    status(bearerAged, 200, 'aged bearer');
    check(!sessionSetCookie(bearerAged), 'bearer sessions are not renewed');

    const staleVcs = await createPersistedEntity(UserEntity, {
        id: 'a1234567-aaaa-bbbb-cccc-0000000000b1',
        name: 'No VCS session',
        createdAt: new Date(),
        lastLoginAt: new Date(),
        isAdmin: false,
        vcsId: VCS_ID,
        vcsUserId: 'stale'
    });
    const staleRes = await f.request(
        withCookie(
            HttpRequest.GET('/api/session/providers'),
            signSession({ sub: staleVcs.id, iat: now - 50 * 60, exp: now + 10 * 60, authTime: now })
        )
    );
    status(staleRes, 200, 'public route with a user whose VCS session is gone');
    check(!sessionSetCookie(staleRes), 'a session whose VCS sign-in is dead is not renewed');

    for (const bad of ['garbage', signSession({ sub: user.id, iat: now - 7200, exp: now - 3600 }), `${session.slice(0, -4)}AAAA`]) {
        status(await f.request(withCookie(HttpRequest.GET('/api/session/providers'), bad)), 200, 'public route with an invalid cookie');
        status(await f.request(withCookie(HttpRequest.GET('/api/session/onboarding-status'), bad)), 200, 'onboarding-status with an invalid cookie');
    }
    console.log('  PASS');

    await f.stop();

    console.log('\nTest: an http PUBLIC_URL uses the plain cookie name, without Secure');
    process.env.PUBLIC_URL = 'http://localhost:7925';
    const h = await startFacade('pixelci_sesscookie_http');
    const httpLogin = await login(h);
    status(httpLogin, 200, 'http login');
    const plain = sessionSetCookie(httpLogin, 'pixelci_session');
    check(plain, `plain cookie missing: ${JSON.stringify(setCookies(httpLogin))}`);
    check(!plain.split(';').some(a => a.trim() === 'Secure'), `plain cookie must not be Secure: ${plain}`);
    check(plain.includes('HttpOnly') && plain.includes('SameSite=Lax') && plain.includes('Path=/'), `plain cookie attributes: ${plain}`);
    status(await h.request(withCookie(HttpRequest.GET('/api/session/me'), cookieValue(plain), 'pixelci_session')), 200, 'plain cookie authenticates');
    status(await h.request(withHeaders(HttpRequest.POST('/api/session/logout'), { origin: 'http://localhost:7925' })), 200, 'http origin passes');
    console.log('  PASS');
    await h.stop();

    mockServer.close();
}
