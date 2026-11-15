import { APIRequestContext, expect, Page, test } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';

// The seeded user's session (zero ID, valid until 2049), as in the other specs.
const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI';

const CALLBACK_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const MCP_HEADERS = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' };

// The e2e database is shared by every spec and run, so each test registers its own client under a unique name.
const uniqueName = (label: string) => `E2E ${label} ${randomBytes(4).toString('hex')}`;

async function useSession(page: Page) {
    await page.addInitScript(token => window.localStorage.setItem('pixelci:jwt', token), JWT);
}

interface IStartedAuthorization {
    clientId: string;
    clientName: string;
    requestId: string;
    verifier: string;
    state: string;
    resource: string;
}

interface IRegisteredClient {
    clientId: string;
    clientName: string;
}

// Registration is rate limited per IP (20/hour), so every test shares one client per worker rather than registering its own.
let sharedClient: Promise<IRegisteredClient> | undefined;

function registeredClient(request: APIRequestContext): Promise<IRegisteredClient> {
    sharedClient ??= (async () => {
        const clientName = uniqueName('client');
        const registration = await request.post('/api/oauth/register', {
            data: { client_name: clientName, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }
        });
        expect(registration.status()).toBe(201);
        return { clientId: (await registration.json()).client_id as string, clientName };
    })();
    return sharedClient;
}

/** Starts an authorization request without following the redirect, like an MCP client would. */
async function startAuthorization(request: APIRequestContext): Promise<IStartedAuthorization> {
    const { clientId, clientName } = await registeredClient(request);

    // Use the advertised resource (it follows the server's PUBLIC_URL, which differs from this origin in some setups).
    const metadata = await (await request.get('/.well-known/oauth-protected-resource/api/mcp')).json();
    const resource = metadata.resource as string;

    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(8).toString('hex');
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        state,
        resource
    });
    const authorize = await request.get(`/api/oauth/authorize?${query.toString()}`, { maxRedirects: 0 });
    expect(authorize.status()).toBe(302);
    const location = new URL(authorize.headers()['location']);
    expect(location.pathname).toBe('/oauth/consent');
    const requestId = location.searchParams.get('request')!;
    expect(requestId).toBeTruthy();
    return { clientId, clientName, requestId, verifier, state, resource };
}

/** Captures the navigation to the client's loopback callback (nothing listens there) instead of letting it fail. */
async function captureCallback(page: Page): Promise<() => Promise<URL>> {
    let resolveUrl!: (url: URL) => void;
    const captured = new Promise<URL>(resolve => (resolveUrl = resolve));
    await page.route(`http://127.0.0.1:${CALLBACK_PORT}/**`, async route => {
        resolveUrl(new URL(route.request().url()));
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>callback received</p>' });
    });
    return () => captured;
}

test.describe('OAuth consent', () => {
    test('approving lets an MCP client exchange the code and call tools', async ({ page, request }) => {
        const auth = await startAuthorization(request);
        await useSession(page);
        const callback = await captureCallback(page);

        await page.goto(`/oauth/consent?request=${auth.requestId}`);

        await expect(page.getByTestId('consent-title')).toContainText(`Allow ${auth.clientName} read-only access to PixelCI?`);
        await expect(page.getByText('Unverified app')).toBeVisible();
        await expect(page.getByTestId('consent-redirect')).toContainText(`an app on this computer (127.0.0.1:${CALLBACK_PORT})`);
        await expect(page.getByText('Cannot approve, reject or comment')).toBeVisible();
        await expect(page.getByTestId('consent-user')).not.toBeEmpty();

        // the click-hijack guard: Allow is inert for a moment after the page appears
        await expect(page.getByTestId('consent-allow')).toBeEnabled({ timeout: 5000 });
        await page.getByTestId('consent-allow').click();

        const url = await (await callback)();
        const code = url.searchParams.get('code');
        expect(code).toMatch(/^pixelci_ac_/);
        expect(url.searchParams.get('state')).toBe(auth.state);
        expect(url.searchParams.get('iss')).toBeTruthy();

        const token = await request.post('/api/oauth/token', {
            form: {
                grant_type: 'authorization_code',
                client_id: auth.clientId,
                code: code!,
                code_verifier: auth.verifier,
                redirect_uri: REDIRECT_URI
            }
        });
        expect(token.status()).toBe(200);
        const tokens = await token.json();
        expect(tokens.token_type).toBe('Bearer');

        const list = await request.post('/api/mcp', {
            headers: { ...MCP_HEADERS, authorization: `Bearer ${tokens.access_token}` },
            data: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
        });
        expect(list.status()).toBe(200);
        const names = ((await list.json()).result.tools as { name: string }[]).map(t => t.name);
        expect(names).toContain('list_apps');

        // the grant is visible in Connected apps and can be revoked there
        await page.unroute(`http://127.0.0.1:${CALLBACK_PORT}/**`);
        await page.goto('/connected-apps');
        const row = page.getByTestId('connected-app').filter({ hasText: auth.clientName });
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: `Revoke ${auth.clientName}` }).click();
        await page
            .getByRole('button', { name: /^(ok|yes|confirm|revoke)/i })
            .last()
            .click();
        await expect(row).toHaveCount(0);

        const after = await request.post('/api/mcp', {
            headers: { ...MCP_HEADERS, authorization: `Bearer ${tokens.access_token}` },
            data: { jsonrpc: '2.0', id: 2, method: 'tools/list' }
        });
        expect(after.status()).toBe(401);
        expect(after.headers()['www-authenticate']).toContain('invalid_token');
    });

    test('denying returns access_denied and issues nothing', async ({ page, request }) => {
        const auth = await startAuthorization(request);
        await useSession(page);
        const callback = await captureCallback(page);

        await page.goto(`/oauth/consent?request=${auth.requestId}`);
        await page.getByTestId('consent-deny').click();

        const url = await (await callback)();
        expect(url.searchParams.get('error')).toBe('access_denied');
        expect(url.searchParams.get('state')).toBe(auth.state);
        expect(url.searchParams.has('code')).toBe(false);

        // the request is spent
        await page.unroute(`http://127.0.0.1:${CALLBACK_PORT}/**`);
        await page.goto(`/oauth/consent?request=${auth.requestId}`);
        await expect(page.getByTestId('consent-ended')).toContainText('expired or was already used');
    });

    test('an unknown or malformed request explains itself', async ({ page }) => {
        await useSession(page);
        await page.goto('/oauth/consent?request=00000000-0000-4000-8000-00000000dead');
        await expect(page.getByTestId('consent-ended')).toContainText("couldn't find this request");
        await expect(page.getByTestId('consent-allow')).toHaveCount(0);

        await page.goto('/oauth/consent?request=not-a-uuid');
        await expect(page.getByTestId('consent-ended')).toContainText("couldn't find this request");
    });

    test('refuses to run inside a frame', async ({ page, request }) => {
        const auth = await startAuthorization(request);
        await useSession(page);
        await page.goto('/apps');
        await page.evaluate(requestId => {
            const frame = document.createElement('iframe');
            frame.id = 'attacker';
            frame.src = `/oauth/consent?request=${requestId}`;
            document.body.append(frame);
        }, auth.requestId);

        const frame = page.frameLocator('#attacker');
        await expect(frame.getByRole('link', { name: 'Open in its own tab' })).toBeVisible();
        await expect(frame.getByTestId('consent-allow')).toHaveCount(0);
        await expect(frame.getByTestId('consent-deny')).toHaveCount(0);

        // and the request is still pending: the framed copy never loaded it
        await page.goto(`/oauth/consent?request=${auth.requestId}`);
        await expect(page.getByTestId('consent-allow')).toBeVisible();
    });

    test('a request that cannot be trusted lands on the error page, which names the problem without echoing input', async ({ page, request }) => {
        // an unregistered redirect URI: nothing may be sent to the client
        const { clientId } = await registeredClient(request);
        const authorize = await request.get(
            `/api/oauth/authorize?${new URLSearchParams({
                response_type: 'code',
                client_id: clientId,
                redirect_uri: 'https://evil.example/cb',
                code_challenge: createHash('sha256').update('x'.repeat(50)).digest('base64url'),
                code_challenge_method: 'S256'
            }).toString()}`,
            { maxRedirects: 0 }
        );
        expect(authorize.status()).toBe(302);
        const location = new URL(authorize.headers()['location']);
        expect(location.pathname).toBe('/oauth/error');
        expect(location.searchParams.get('reason')).toBe('invalid_redirect_uri');

        // reachable without signing in
        await page.goto(`/oauth/error?reason=invalid_redirect_uri`);
        await expect(page.getByTestId('oauth-error-message')).toContainText("doesn't match what it registered");

        await page.goto(`/oauth/error?reason=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
        await expect(page.getByTestId('oauth-error-message')).toHaveText('The connection request could not be completed.');
    });
});
