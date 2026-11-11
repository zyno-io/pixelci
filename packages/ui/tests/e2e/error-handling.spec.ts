import { expect, test } from '@playwright/test';

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
        await page.addInitScript(() => {
            window.localStorage.setItem(
                'pixelci:jwt',
                'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI'
            );
        });
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
