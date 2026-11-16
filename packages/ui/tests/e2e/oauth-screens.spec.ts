import { APIRequestContext, expect, Page, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Visual-regression screenshots of the connect-app (OAuth) screens. State comes from `seed-e2e.mjs --oauth-screens`: fixed
// clients and grants with fixed dates, and a fresh cached Client ID Metadata Document for claude.ai so authorizing it never
// fetches. Dates render in the browser's timezone, so it is pinned to UTC.

const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI';
const DCR_CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';
const CIMD_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

const seedScript = fileURLToPath(new URL('../../../api/tests/scripts/seed-e2e.mjs', import.meta.url));
test.beforeEach(() => {
    execFileSync('node', [seedScript, '--oauth-screens'], { stdio: 'inherit' });
});

/** Starts an authorization request like an MCP client would, returning the consent page path. */
async function consentPath(request: APIRequestContext, clientId: string, redirectUri: string): Promise<string> {
    const metadata = await (await request.get('/.well-known/oauth-protected-resource/api/mcp')).json();
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'),
        code_challenge_method: 'S256',
        state: 'screenshot',
        resource: metadata.resource as string
    });
    const authorize = await request.get(`/api/oauth/authorize?${query.toString()}`, { maxRedirects: 0 });
    expect(authorize.status()).toBe(302);
    const location = new URL(authorize.headers()['location']);
    expect(location.pathname).toBe('/oauth/consent');
    return `${location.pathname}${location.search}`;
}

for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`${colorScheme} mode`, () => {
        test.use({ colorScheme, timezoneId: 'UTC' });

        const takeScreenshot = (page: Page, name: string) => page.screenshot({ path: `screenshots/${name} (${colorScheme}).png` });

        test('connect-app screens', async ({ page, request }) => {
            await page.addInitScript(token => window.localStorage.setItem('pixelci:jwt', token), JWT);

            // Consent for a Client ID Metadata Document client: the verified domain
            await page.goto(await consentPath(request, CIMD_CLIENT_ID, 'https://claude.ai/api/mcp/auth_callback'));
            await expect(page.getByTestId('consent-allow')).toBeEnabled();
            await takeScreenshot(page, 'OAuth Consent - Verified Domain');

            // Consent for a dynamically registered client returning to a loopback address
            await page.goto(await consentPath(request, DCR_CLIENT_ID, 'http://127.0.0.1:53682/callback'));
            await expect(page.getByTestId('consent-allow')).toBeEnabled();
            await takeScreenshot(page, 'OAuth Consent - Unverified App');

            // An authorization request that can't be trusted enough to redirect back
            await page.goto('/oauth/error?reason=invalid_redirect_uri');
            await expect(page.getByTestId('oauth-error-message')).toBeVisible();
            await takeScreenshot(page, 'OAuth Error');

            // Connected apps, the revoke confirmation, and the empty state
            await page.goto('/connected-apps');
            await expect(page.getByTestId('connected-app')).toHaveCount(2);
            await takeScreenshot(page, 'Connected Apps');

            // (the vue-foundation confirm has no dialog role)
            const confirm = page.locator('.vf-modal');
            await page.getByRole('button', { name: 'Revoke Claude Code' }).click();
            await expect(confirm).toBeVisible();
            await takeScreenshot(page, 'Connected Apps - Revoke Confirm');
            await confirm.getByRole('button', { name: 'Cancel' }).click();
            await expect(confirm).toBeHidden();

            for (const name of ['Claude Code', 'Claude']) {
                await page.getByRole('button', { name: `Revoke ${name}`, exact: true }).click();
                await confirm.getByRole('button', { name: 'Confirm' }).click();
                await expect(page.getByRole('button', { name: `Revoke ${name}`, exact: true })).toHaveCount(0);
            }
            await page.reload();
            await expect(page.getByText('No connected apps')).toBeVisible();
            await takeScreenshot(page, 'Connected Apps - Empty');
        });
    });
}
