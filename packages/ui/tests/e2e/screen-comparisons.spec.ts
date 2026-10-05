import { expect, test } from '@playwright/test';

test.describe('Screen Comparisons', () => {
    test.beforeEach(async ({ page }) => {
        // Pre-auth before the first navigation so the single-provider login doesn't auto-redirect to OAuth.
        await page.addInitScript(() => {
            window.localStorage.setItem(
                'pixelci:jwt',
                'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI'
            );
        });

        await page.goto('/');

        // Navigate to a build with screens
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');
        await page.locator('.build').first().locator('span').first().click();
        await page.waitForSelector('.screen');
    });

    test('can toggle between original and diff view', async ({ page }) => {
        const diffCheckbox = page.locator('input[data-testid="diff-check"]');

        // Initially unchecked
        await expect(diffCheckbox).not.toBeChecked();

        // Check the diff view
        await diffCheckbox.check();
        await expect(diffCheckbox).toBeChecked();

        // Uncheck back to original
        await diffCheckbox.uncheck();
        await expect(diffCheckbox).not.toBeChecked();
    });

    test('can filter to show only changes', async ({ page }) => {
        const changesCheckbox = page.locator('input[data-testid="changes-check"]');

        // Uncheck to show all screens
        if (await changesCheckbox.isChecked()) {
            await changesCheckbox.uncheck();
        }

        const allScreensCount = await page.locator('.screen').count();

        // Check to show only changes
        await changesCheckbox.check();
        await expect(changesCheckbox).toBeChecked();

        const changesOnlyCount = await page.locator('.screen').count();

        // Changes-only count should be less than or equal to all screens
        expect(changesOnlyCount).toBeLessThanOrEqual(allScreensCount);
    });
});
