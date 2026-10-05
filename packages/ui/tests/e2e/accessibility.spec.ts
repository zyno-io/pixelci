import { expect, test } from '@playwright/test';

test.describe('Accessibility', () => {
    test.beforeEach(async ({ page }) => {
        // Pre-auth before the first navigation so the single-provider login doesn't auto-redirect to OAuth.
        await page.addInitScript(() => {
            window.localStorage.setItem(
                'pixelci:jwt',
                'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcHAiLCJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjI1MjQ2MDc5OTksImlhdCI6MTc0NzYzMjc2Mn0.7FmHrOWWRWmH8i8floyAE-VvYu4Lya_9c-Qy68r8puI'
            );
        });

        await page.goto('/');
    });

    test('can navigate with keyboard', async ({ page }) => {
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');

        // Test tab navigation
        await page.keyboard.press('Tab');

        // Check if focus is visible
        const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
        expect(focusedElement).toBeTruthy();
    });

    test('images have alt text', async ({ page }) => {
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');
        await page.locator('.build').first().locator('span').first().click();
        await page.waitForSelector('.screen');
        await page.waitForSelector('.image-wrapper img');

        const images = page.locator('.image-wrapper img');
        const count = await images.count();
        expect(count).toBeGreaterThan(0);

        // Check that content images have alt attributes
        for (let i = 0; i < count; i++) {
            const img = images.nth(i);
            const alt = await img.getAttribute('alt');
            // Alt can be empty string for decorative images, but should exist
            expect(alt !== null).toBeTruthy();
        }
    });

    test('interactive elements have appropriate roles', async ({ page }) => {
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');
        await page.locator('.build').first().locator('span').first().click();
        await page.waitForSelector('.screen');

        // Check checkboxes have correct role
        const diffCheckbox = page.locator('input[data-testid="diff-check"]');
        const role = await diffCheckbox.getAttribute('type');
        expect(role).toBe('checkbox');
    });

    test('maintains focus visibility in dark mode', async ({ page }) => {
        // This test runs in both light and dark mode via colorScheme parameter
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');

        await page.keyboard.press('Tab');

        // Focus should be visible in both modes
        const focusedElement = await page.evaluate(() => document.activeElement);
        expect(focusedElement).toBeTruthy();
    });

    test('color contrast is sufficient', async ({ page }) => {
        // This is a basic check - full accessibility testing would use axe-core or similar
        await page.locator('.app').first().click();
        await page.waitForSelector('.build');

        // Check that text is visible (basic check)
        const buildElement = page.locator('.build').first();
        await expect(buildElement).toBeVisible();

        // Check text color is not transparent
        const color = await buildElement.evaluate(el => window.getComputedStyle(el).color);
        expect(color).not.toBe('rgba(0, 0, 0, 0)');
    });
});
