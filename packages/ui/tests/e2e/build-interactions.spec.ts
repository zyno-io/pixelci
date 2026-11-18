import { expect, test } from '@playwright/test';

import { signIn } from './fixtures/session';

test.describe('Build Interactions', () => {
    test.beforeEach(async ({ page }) => {
        // Pre-auth before the first navigation so the single-provider login doesn't auto-redirect to OAuth.
        await signIn(page);

        await page.goto('/');
    });

    test('displays build metadata correctly', async ({ page }) => {
        // Navigate to app and then to build
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');

        const firstBuild = page.locator('.build').first();

        // Should display commit info
        await expect(firstBuild).toBeVisible();

        // Check if build date is displayed
        const dateElement = firstBuild.locator('.build-date');
        await expect(dateElement).toBeVisible();
    });

    test('can navigate back from build details', async ({ page }) => {
        // Navigate to app
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');

        const appUrl = page.url();

        // Navigate to build
        await page.locator('.build').first().locator('span').first().click();
        await page.waitForSelector('.screen');

        // Navigate back (using browser back or back button)
        await page.goBack();
        await page.waitForSelector('.build');

        // Should be back at builds list
        expect(page.url()).toBe(appUrl);
        await expect(page.locator('.build').first()).toBeVisible();
    });
});
