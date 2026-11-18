import { expect, test } from '@playwright/test';

import { mintSessionJwt, signIn } from './fixtures/session';

const SESSION_COOKIE = 'pixelci_session';

test.describe('Cookie session', () => {
    test('a cookie-only session reaches the apps list', async ({ page }) => {
        await signIn(page);
        await page.goto('/');
        await expect(page).toHaveURL(/\/apps$/);
        await expect(page.locator('.app').first()).toBeVisible();
        // HttpOnly: scripts can't read it
        expect(await page.evaluate(() => document.cookie)).not.toContain(SESSION_COOKIE);
    });

    test('logout clears the cookie and shows the provider picker', async ({ page }) => {
        // The seeded provider's OAuth host is unreachable in tests; stub it so an auto-redirect can't hang on DNS.
        await page.route('**/oauth/authorize**', route => route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
        await signIn(page);
        await page.goto('/apps');
        await expect(page.locator('.app').first()).toBeVisible();

        await page.getByRole('button', { name: 'Logout' }).click();
        await expect(page.locator('#login button.btn.primary')).toHaveCount(1);
        expect((await page.context().cookies()).find(c => c.name === SESSION_COOKIE)).toBeUndefined();

        // and the session really is gone server-side
        const me = await page.request.get('/api/session/me');
        expect(me.status()).toBe(401);
    });

    test('a legacy localStorage token is removed on load, and is not a session', async ({ page }) => {
        await page.route('**/oauth/authorize**', route => route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
        await page.addInitScript(token => window.localStorage.setItem('pixelci:jwt', token), mintSessionJwt());
        await page.goto('/apps');
        await page.waitForURL(/\/(apps|login)|\/oauth\/authorize/);
        expect(await page.evaluate(() => window.localStorage.getItem('pixelci:jwt'))).toBeNull();
        await expect(page.locator('.app')).toHaveCount(0);
    });

    test('a sign-in whose cookie is not kept shows an error instead of redirecting to the provider again', async ({ page }) => {
        let authorizeHits = 0;
        await page.route('**/oauth/authorize**', route => {
            authorizeHits++;
            return route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' });
        });
        // the server accepts the sign-in but sets no cookie, so /me stays 401
        await page.route('**/api/session/login', route =>
            route.fulfill({ status: 200, contentType: 'application/json', body: '{"returnTo":"/apps"}' })
        );
        await page.addInitScript(() => window.sessionStorage.setItem('pixelci:oauthState', 'issued-state'));

        await page.goto('/login?code=abc&state=issued-state');
        await expect(page.getByRole('alert')).toContainText("Signed in, but the session cookie wasn't saved");
        await expect(page.locator('#login button.btn.primary')).toHaveCount(1);
        expect(authorizeHits).toBe(0);
    });
});
