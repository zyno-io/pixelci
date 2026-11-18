import { expect, test } from '@playwright/test';

import { signIn, stubLogout } from './fixtures/session';

test.describe('Error Handling', () => {
    test('sends unauthenticated users to authentication', async ({ page }) => {
        // The seeded provider's OAuth host is unreachable in tests; stub it so the auto-redirect
        // (single provider) doesn't hang on a DNS failure.
        await page.route('**/oauth/authorize**', route => route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));

        // A fresh browser context has no stored jwt, so this visit is unauthenticated.
        await page.goto('/apps');

        // Unauthenticated: the login picker is shown, or — with a single VCS provider — we're sent
        // straight to the provider's OAuth login.
        await page.waitForURL(/\/(apps|login)|\/oauth\/authorize/);
        expect(page.url()).toMatch(/\/(apps|login)|\/oauth\/authorize/);
    });
});

test.describe('Error Handling (authenticated)', () => {
    test.beforeEach(async ({ page }) => {
        await signIn(page);
    });

    test('unknown route shows Page not found', async ({ page }) => {
        await page.goto('/this/route/does-not-exist');
        await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Back to Apps' })).toBeVisible();
    });

    test('bad build id shows an inline error with a way back', async ({ page }) => {
        await page.goto('/');
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');
        const appPath = new URL(page.url()).pathname;

        await page.goto(`${appPath}/builds/00000000-0000-0000-0000-0000000fffff`);
        const alert = page.getByRole('alert');
        await expect(alert).toBeVisible();
        await expect(alert).toContainText("This build couldn't be loaded");
        await expect(alert.getByRole('link', { name: 'Back to builds' })).toBeVisible();
    });

    test('signed in with the wrong provider: explains it and offers to switch account', async ({ page }) => {
        const message = 'This app is connected to GitHub. Sign in with GitHub to view it.';
        const logoutHits = await stubLogout(page);
        await page.goto('/');
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');
        const appPath = new URL(page.url()).pathname;
        await page.locator('.build').first().locator('span').first().click();
        await page.waitForSelector('.screen');
        const buildPath = new URL(page.url()).pathname;

        // The API refuses everything under this app, as it does for a user from another provider.
        await page.route(`**/api${appPath}**`, route =>
            route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: message }) })
        );

        for (const path of [buildPath, appPath]) {
            await page.goto(path);
            const alert = page.getByRole('alert');
            await expect(alert).toHaveCount(1);
            await expect(alert).toContainText(message);
            await expect(page.getByTestId('switch-account')).toBeVisible();
            await expect(page.locator('.vf-modal')).toHaveCount(0);
        }

        // Switching account shows the provider picker rather than auto-redirecting to the only
        // provider, which would sign the same account straight back in.
        await page.getByTestId('switch-account').click();
        await expect(page.locator('#login button.btn.primary')).toHaveCount(1);
        expect(new URL(page.url()).pathname).toBe(appPath);
        expect(logoutHits()).toBe(1);
        expect((await page.context().cookies()).find(c => c.name === 'pixelci_session')).toBeUndefined();
    });

    test('bad app id shows one inline alert and no modal', async ({ page }) => {
        await page.goto('/apps/00000000-0000-0000-0000-0000000fffff');
        const alert = page.getByRole('alert');
        await expect(alert).toHaveCount(1);
        await expect(alert).toContainText("This app couldn't be loaded");
        await expect(alert.getByRole('link', { name: 'Back to Apps' })).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.locator('.vf-modal')).toHaveCount(0);
    });
});
